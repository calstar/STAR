#include "ble_link.h"

#include <NimBLEDevice.h>

namespace ble_link {
namespace {

// Base UUID 5354_4152-xxxx ("STAR"); website must use the same values.
const char *SERVICE_UUID = "53544152-0001-4b8a-9d3e-7a1c2f6b0e10";
const char *OUTPUT_UUID = "53544152-0002-4b8a-9d3e-7a1c2f6b0e10";
const char *STATUS_UUID = "53544152-0003-4b8a-9d3e-7a1c2f6b0e10";

// Advertising every 1 s while idle; connection interval 300-400 ms with a 6 s
// supervision timeout. Units: adv 0.625 ms, conn interval 1.25 ms, timeout 10 ms.
constexpr uint16_t ADV_INTERVAL = 1600;
constexpr uint16_t CONN_INTERVAL_MIN = 240;
constexpr uint16_t CONN_INTERVAL_MAX = 320;
constexpr uint16_t CONN_LATENCY = 0;
constexpr uint16_t CONN_TIMEOUT = 600;

NimBLECharacteristic *outputChr = nullptr;
NimBLECharacteristic *statusChr = nullptr;
OutputRequestFn outputRequest = nullptr;

volatile bool isConnected = false;

class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer *s, ble_gap_conn_desc *desc) override {
        isConnected = true;
        s->updateConnParams(desc->conn_handle, CONN_INTERVAL_MIN, CONN_INTERVAL_MAX,
                            CONN_LATENCY, CONN_TIMEOUT);
    }

    // Disconnecting never touches the output: losing the phone at the pad
    // must not power down the altimeters.
    void onDisconnect(NimBLEServer *, ble_gap_conn_desc *) override { isConnected = false; }
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

    NimBLEServer *server = NimBLEDevice::createServer();
    server->setCallbacks(new ServerCallbacks());

    NimBLEService *svc = server->createService(SERVICE_UUID);
    outputChr = svc->createCharacteristic(
        OUTPUT_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
    outputChr->setCallbacks(new OutputCallbacks());
    statusChr = svc->createCharacteristic(STATUS_UUID,
                                          NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
    svc->start();

    NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
    adv->addServiceUUID(SERVICE_UUID);
    adv->setScanResponse(true);
    adv->setMinInterval(ADV_INTERVAL);
    adv->setMaxInterval(ADV_INTERVAL);
    adv->start();
}

bool connected() { return isConnected; }

void publishOutput(bool on) {
    uint8_t v = on ? 1 : 0;
    outputChr->setValue(&v, 1);
    if (isConnected) outputChr->notify();
}

void publishStatus(const StatusPacket &pkt) {
    statusChr->setValue(reinterpret_cast<const uint8_t *>(&pkt), sizeof(pkt));
    if (isConnected) statusChr->notify();
}

}  // namespace ble_link
