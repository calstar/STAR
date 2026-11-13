#include "switch_link.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <string.h>

#include "SwitchRelay.h"
#include "SwitchStatus.h"

namespace switch_link {
namespace {

// Match the switch's own request (firmware/Bluetooth_Switch/src/ble_link.cpp):
// 300-400 ms interval, latency 4, 6 s supervision timeout.
constexpr uint16_t CONN_INTERVAL_MIN = 240;  // 1.25 ms units
constexpr uint16_t CONN_INTERVAL_MAX = 320;
constexpr uint16_t CONN_LATENCY = 4;
constexpr uint16_t CONN_TIMEOUT = 600;        // 10 ms units
// Connect and discover at a fast interval (discovery is several round trips:
// at 400 ms and latency 4 it takes seconds), then step down to the slow one.
constexpr uint16_t FAST_INTERVAL_MIN = 12;  // 15 ms
constexpr uint16_t FAST_INTERVAL_MAX = 24;  // 30 ms
constexpr uint16_t FAST_LATENCY = 0;
constexpr uint8_t CONNECT_TIMEOUT_S = 4;
constexpr uint32_t RSSI_PERIOD_MS = 1000;
constexpr uint32_t TASK_PERIOD_MS = 50;

SwitchRelay relay;
SemaphoreHandle_t lock = nullptr;
bool started = false;

struct Guard {
    Guard() { xSemaphoreTake(lock, portMAX_DELAY); }
    ~Guard() { xSemaphoreGive(lock); }
};

// NimBLE keeps addresses least significant byte first; the config (and every
// human) writes them most significant first.
void toMac(const NimBLEAddress &a, uint8_t mac[6]) {
    const uint8_t *n = a.getNative();
    for (int i = 0; i < 6; ++i) mac[i] = n[5 - i];
}

NimBLEAddress toAddress(const uint8_t mac[6]) {
    char s[18];
    snprintf(s, sizeof s, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4],
             mac[5]);
    return NimBLEAddress(std::string(s), BLE_ADDR_PUBLIC);
}

// A listed switch heard in a scan, waiting for the task to connect to it.
volatile bool pendingSet = false;
uint8_t pendingMac[6];

void onStatusNotify(NimBLERemoteCharacteristic *chr, uint8_t *data, size_t len, bool) {
    uint8_t mac[6];
    toMac(chr->getRemoteService()->getClient()->getPeerAddress(), mac);
    Guard g;
    relay.onStatus(mac, data, len, millis());
}

class ClientCallbacks : public NimBLEClientCallbacks {
    // The switch asks for its slow parameters as soon as anyone connects (for
    // phones). Decline: this board sets those same parameters itself once
    // discovery is done, and accepting now would make discovery take seconds.
    bool onConnParamsUpdateRequest(NimBLEClient *, const ble_gap_upd_params *) override {
        return false;
    }

    void onDisconnect(NimBLEClient *c) override {
        uint8_t mac[6];
        toMac(c->getPeerAddress(), mac);
        Serial.printf("[switch] %02X%02X link lost\n", mac[4], mac[5]);
        Guard g;
        relay.onDisconnected(mac);
    }
};
ClientCallbacks clientCallbacks;

class ScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice *d) override {
        if (!d->isAdvertisingService(NimBLEUUID(daq::bt_switch::SERVICE_UUID))) return;
        uint8_t mac[6];
        toMac(d->getAddress(), mac);
        bool want;
        {
            Guard g;
            want = relay.shouldConnect(mac);
        }
        if (want && !pendingSet) {
            memcpy(pendingMac, mac, 6);
            pendingSet = true;
            NimBLEDevice::getScan()->stop();  // connect from the task, not from here
        }
    }
};
ScanCallbacks scanCallbacks;

bool connectTo(const uint8_t mac[6]) {
    NimBLEClient *c = NimBLEDevice::getDisconnectedClient();
    if (!c) {
        if (NimBLEDevice::getClientListSize() >= CONFIG_BT_NIMBLE_MAX_CONNECTIONS) return false;
        c = NimBLEDevice::createClient();
        c->setClientCallbacks(&clientCallbacks, false);
        c->setConnectionParams(FAST_INTERVAL_MIN, FAST_INTERVAL_MAX, FAST_LATENCY, CONN_TIMEOUT);
        c->setConnectTimeout(CONNECT_TIMEOUT_S);
    }
    if (!c->connect(toAddress(mac))) return false;

    NimBLERemoteService *svc = c->getService(daq::bt_switch::SERVICE_UUID);
    NimBLERemoteCharacteristic *st = svc ? svc->getCharacteristic(daq::bt_switch::STATUS_UUID) : nullptr;
    if (!st || !st->subscribe(true, onStatusNotify)) {
        Serial.printf("[switch] %02X%02X has no status characteristic\n", mac[4], mac[5]);
        c->disconnect();
        return false;
    }
    NimBLEAttValue v = st->readValue();  // don't wait up to 2 s for the first notification
    // Discovery done: settle on the switch's own slow, power-saving parameters.
    c->updateConnParams(CONN_INTERVAL_MIN, CONN_INTERVAL_MAX, CONN_LATENCY, CONN_TIMEOUT);
    Guard g;
    relay.onConnected(mac);
    if (v.length()) relay.onStatus(mac, v.data(), v.length(), millis());
    return true;
}

// Write one operator command to its switch's Output characteristic, with
// response. The switch confirms through its own Output/Status notifications.
bool writeOutput(const uint8_t mac[6], uint8_t output) {
    NimBLEClient *c = NimBLEDevice::getClientByPeerAddress(toAddress(mac));
    if (!c || !c->isConnected()) return false;
    NimBLERemoteService *svc = c->getService(daq::bt_switch::SERVICE_UUID);
    NimBLERemoteCharacteristic *out = svc ? svc->getCharacteristic(daq::bt_switch::OUTPUT_UUID) : nullptr;
    return out && out->writeValue(&output, 1, true);
}

void task(void *) {
    uint32_t lastRssi = 0;
    for (;;) {
        // Commands first: an operator is waiting. The relay hands out only what
        // the DAQ sent; nothing here decides to write.
        for (;;) {
            daq::SwitchCommandPacket cmd;
            uint8_t mac[6];
            bool have;
            {
                Guard g;
                have = relay.takeCommand(cmd, mac);
            }
            if (!have) break;
            bool ok = writeOutput(mac, cmd.output);
            Serial.printf("[switch] %02X%02X command %u %s: %s\n", mac[4], mac[5], cmd.command_id,
                          cmd.output ? "ARM" : "DISARM", ok ? "written" : "write failed");
            Guard g;
            relay.finishCommand(cmd, ok);
        }

        if (pendingSet) {
            uint8_t mac[6];
            memcpy(mac, pendingMac, 6);
            bool ok = connectTo(mac);
            Serial.printf("[switch] %02X%02X %s\n", mac[4], mac[5], ok ? "connected" : "connect failed");
            pendingSet = false;
        }

        bool scan;
        {
            Guard g;
            scan = relay.wantsScan();
        }
        NimBLEScan *s = NimBLEDevice::getScan();
        if (scan && !s->isScanning() && !pendingSet) s->start(0, nullptr, false);
        if (!scan && s->isScanning()) s->stop();

        uint32_t now = millis();
        if (now - lastRssi >= RSSI_PERIOD_MS) {
            lastRssi = now;
            for (NimBLEClient *c : *NimBLEDevice::getClientList()) {
                if (!c->isConnected()) continue;
                uint8_t mac[6];
                toMac(c->getPeerAddress(), mac);
                int rssi = c->getRssi();
                Guard g;
                relay.onRssi(mac, static_cast<int8_t>(rssi));
            }
        }
        vTaskDelay(pdMS_TO_TICKS(TASK_PERIOD_MS));
    }
}

}  // namespace

bool begin() {
    lock = xSemaphoreCreateMutex();
    if (!lock) return false;
    NimBLEDevice::init("STAR-Env");
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);
    NimBLEScan *s = NimBLEDevice::getScan();
    s->setAdvertisedDeviceCallbacks(&scanCallbacks, false);
    s->setActiveScan(false);  // the service UUID is in the advertisement itself
    // Keep no results: the callback is all we use, and a scan that runs until a
    // missing switch turns up would otherwise store every phone at the pad
    // (the default keeps up to 255 and NimBLE allocates each one).
    s->setMaxResults(0);
    s->setInterval(100);      // listen 50 ms of every 100 ms, only while a switch is missing
    s->setWindow(50);
    started = xTaskCreate(task, "switch_link", 6144, nullptr, 2, nullptr) == pdPASS;
    return started;
}

bool running() { return started; }

void applyConfig(const daq::SwitchConfig &config, uint32_t hash) {
    if (!started) return;
    uint8_t drop[daq::MAX_SWITCHES][6];
    size_t n;
    {
        Guard g;
        if (relay.hasConfig() && relay.configHash() == hash) return;
        n = relay.applyConfig(config, hash);
        for (size_t i = 0; i < n; ++i) memcpy(drop[i], relay.dropped(i), 6);
    }
    Serial.printf("[switch] config %08lx: %u switch(es)\n", static_cast<unsigned long>(hash),
                  config.count);
    // A switch taken off the list: close its link. Closing a link never
    // changes a switch's output.
    for (size_t i = 0; i < n; ++i) {
        NimBLEClient *c = NimBLEDevice::getClientByPeerAddress(toAddress(drop[i]));
        if (c && c->isConnected()) c->disconnect();
    }
}

void submitCommand(const daq::SwitchCommandPacket &cmd) {
    if (!started) return;
    Guard g;
    relay.submitCommand(cmd);
}

size_t collectResults(daq::SwitchCommandResultPacket *out, size_t max) {
    if (!started) return 0;
    Guard g;
    return relay.collectResults(out, max);
}

size_t collectReports(uint32_t nowMs, daq::SwitchStatusReport *out, size_t max) {
    if (!started) return 0;
    Guard g;
    return relay.collectReports(nowMs, out, max);
}

}  // namespace switch_link
