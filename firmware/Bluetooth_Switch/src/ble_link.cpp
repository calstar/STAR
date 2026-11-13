#include "ble_link.h"

#include <NimBLEDevice.h>

namespace ble_link {
namespace {

// UUIDs are shared with the environmental board and the web page
// (lib/daq-protocol/src/SwitchStatus.h).
using daq::bt_switch::FIRMWARE_UUID;
using daq::bt_switch::OUTPUT_UUID;
using daq::bt_switch::SERVICE_UUID;
using daq::bt_switch::STATUS_UUID;

// Advertising every 1 s while idle; connection interval 300-400 ms with a 6 s
// supervision timeout. Units: adv 0.625 ms, conn interval 1.25 ms, timeout 10 ms.
//
// Latency 4: with nothing to send, the switch may skip 4 connection events and
// answer every 5th, ~1.5-2 s. Under light sleep the radio is most of the power
// budget, and the environmental board holds a link to every switch all the
// time; at latency 0 that link alone would wake the switch ~3x a second, more
// than its advertising does. A command from the central waits up to ~2 s for
// the next event the switch listens to. The timeout must stay above
// (1 + latency) * interval * 2 = 4 s.
constexpr uint16_t ADV_INTERVAL = 1600;
constexpr uint16_t CONN_INTERVAL_MIN = 240;
constexpr uint16_t CONN_INTERVAL_MAX = 320;
constexpr uint16_t CONN_LATENCY = 4;
constexpr uint16_t CONN_TIMEOUT = 600;
static_assert(CONN_TIMEOUT * 10 > (1 + CONN_LATENCY) * CONN_INTERVAL_MAX * 125 / 100 * 2,
              "supervision timeout too short for this latency");

NimBLECharacteristic *outputChr = nullptr;
NimBLECharacteristic *statusChr = nullptr;
NimBLECharacteristic *firmwareChr = nullptr;
volatile uint32_t connects = 0;
OutputRequestFn outputRequest = nullptr;

NimBLEServer *server = nullptr;

// Several centrals may be connected at once; every one gets the notifications
// and any one of them can switch the output (last write wins).
class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer *s, ble_gap_conn_desc *desc) override {
        connects = connects + 1;
        s->updateConnParams(desc->conn_handle, CONN_INTERVAL_MIN, CONN_INTERVAL_MAX,
                            CONN_LATENCY, CONN_TIMEOUT);
        // A connection ends connectable advertising; keep advertising while
        // there is a free slot so the next phone can still find the switch.
        if (s->getConnectedCount() < CONFIG_BT_NIMBLE_MAX_CONNECTIONS) {
            NimBLEDevice::startAdvertising();
        }
    }

    // Disconnecting never touches the output: losing a phone at the pad must
    // not power down the altimeters. Advertising restarts by itself
    // (advertiseOnDisconnect).
    void onDisconnect(NimBLEServer *, ble_gap_conn_desc *) override {}
};

class OutputCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *chr) override {
        NimBLEAttValue v = chr->getValue();
        if (v.length() != 1 || v[0] > 1) return;
        if (outputRequest) outputRequest(v[0] == 1);
    }
};

}  // namespace

void begin(const char *name, OutputRequestFn on_output_request) {
    outputRequest = on_output_request;

    NimBLEDevice::init(name);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

    server = NimBLEDevice::createServer();
    server->setCallbacks(new ServerCallbacks());
    server->advertiseOnDisconnect(true);

    NimBLEService *svc = server->createService(SERVICE_UUID);
    outputChr = svc->createCharacteristic(
        OUTPUT_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
    outputChr->setCallbacks(new OutputCallbacks());
    statusChr = svc->createCharacteristic(STATUS_UUID,
                                          NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
    firmwareChr = svc->createCharacteristic(FIRMWARE_UUID, NIMBLE_PROPERTY::READ);
    svc->start();

    NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
    adv->addServiceUUID(SERVICE_UUID);
    adv->setScanResponse(true);
    adv->setMinInterval(ADV_INTERVAL);
    adv->setMaxInterval(ADV_INTERVAL);
    adv->start();
}

uint32_t connectCount() { return connects; }

void publishFirmwareHash(const uint8_t *sha256) { firmwareChr->setValue(sha256, 32); }

bool connected() { return server && server->getConnectedCount() > 0; }

void publishOutput(bool on) {
    uint8_t v = on ? 1 : 0;
    outputChr->setValue(&v, 1);
    if (connected()) outputChr->notify();
}

void publishStatus(const StatusPacket &pkt) {
    statusChr->setValue(reinterpret_cast<const uint8_t *>(&pkt), sizeof(pkt));
    if (connected()) statusChr->notify();
}

}  // namespace ble_link
