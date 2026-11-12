// Bluetooth switch: latched high-side power switch for commercial altimeters
// (WifiSwitch board, ESP32-C3). Controlled and monitored over BLE only; the
// "are you sure" confirmation lives in the web client.
//
// Output policy:
//   - Latched: once on, it stays on until an explicit OFF (disable) command.
//   - A BLE disconnect never changes the output.
//   - Across a non-power-on reset (watchdog, panic, brownout) the pad stays
//     held by gpio_hold and the state is re-applied from RTC memory, so an MCU
//     reset in flight does not drop altimeter power.
//   - A full power cycle comes up OFF.

#include <Arduino.h>
#include <Wire.h>
#include <driver/gpio.h>
#include <esp_mac.h>
#include <esp_system.h>

#include "ble_link.h"
#include "ina260.h"
#include "pins.h"
#include "status.h"

namespace {

// Sense thresholds on the CONT_ADC node (half of VOUT after D2). Open reads
// ~0.9 V with CONT_EN driving; the zener clamps a live output near 2.5 V.
// Bench-calibrate these against a real altimeter.
constexpr uint32_t SENSE_LOAD_MAX_MV = 150;
constexpr uint32_t SENSE_LIVE_MIN_MV = 1800;

constexpr uint32_t STATUS_PERIOD_CONNECTED_MS = 2000;
constexpr uint32_t STATUS_PERIOD_IDLE_MS = 30000;
constexpr uint32_t SENSE_SETTLE_MS = 500;  // 1M into C5 + C23, tau ~100 ms

constexpr uint32_t LOOP_PERIOD_MS = 20;

constexpr uint32_t RTC_MAGIC_ON = 0x53574F4E;   // "SWON"
constexpr uint32_t RTC_MAGIC_OFF = 0x53574F46;  // "SWOF"
RTC_NOINIT_ATTR uint32_t rtcOutputState;

INA260 ina;
bool inaOk = false;
bool outputOn = false;
bool restoredAfterReset = false;
esp_reset_reason_t resetReason = ESP_RST_UNKNOWN;

// Written from the NimBLE host task, applied in loop().
volatile int8_t pendingOutput = -1;

uint32_t lastStatusMs = 0;
uint32_t senseValidAtMs = 0;

void driveOutputPad(bool on) {
    gpio_hold_dis(static_cast<gpio_num_t>(PIN_OUT_EN));
    gpio_set_level(static_cast<gpio_num_t>(PIN_OUT_EN), on ? 1 : 0);
    gpio_set_direction(static_cast<gpio_num_t>(PIN_OUT_EN), GPIO_MODE_OUTPUT);
    gpio_hold_en(static_cast<gpio_num_t>(PIN_OUT_EN));
}

void setOutput(bool on) {
    rtcOutputState = on ? RTC_MAGIC_ON : RTC_MAGIC_OFF;
    driveOutputPad(on);
    // Continuity drive only while off; D1 blocks the supply from back-feeding.
    digitalWrite(PIN_CONT_EN, on ? LOW : HIGH);
    outputOn = on;
    restoredAfterReset = false;
    senseValidAtMs = millis() + SENSE_SETTLE_MS;
    lastStatusMs = 0;  // force a status update once the sense line settles
    Serial.printf("[out] %s\n", on ? "ON" : "OFF (disabled)");
    ble_link::publishOutput(on);
}

// Runs first thing in setup(), before anything else can stall.
void restoreOutput() {
    resetReason = esp_reset_reason();
    bool fromPowerOn = resetReason == ESP_RST_POWERON || resetReason == ESP_RST_UNKNOWN;
    bool on = !fromPowerOn && rtcOutputState == RTC_MAGIC_ON;
    if (fromPowerOn) rtcOutputState = RTC_MAGIC_OFF;
    restoredAfterReset = on;
    outputOn = on;
    driveOutputPad(on);
}

Sense classifySense(uint32_t mv) {
    if (mv >= SENSE_LIVE_MIN_MV) return Sense::Live;
    if (outputOn) return Sense::Unknown;  // on but not live: switch or supply fault
    return mv <= SENSE_LOAD_MAX_MV ? Sense::LoadPresent : Sense::Open;
}

StatusPacket buildStatus() {
    StatusPacket pkt = {};
    pkt.version = STATUS_VERSION;
    pkt.output = outputOn ? 1 : 0;
    pkt.uptime_s = millis() / 1000;
    pkt.reset_reason = static_cast<uint8_t>(resetReason);
    if (inaOk) pkt.flags |= FLAG_INA_OK;
    if (restoredAfterReset) pkt.flags |= FLAG_RESTORED;

    INA260::Reading r;
    if (inaOk && ina.read(r)) {
        pkt.flags |= FLAG_READING_VALID;
        pkt.supply_mV = r.bus_mV;
        pkt.current_mA = static_cast<int16_t>(constrain(r.current_mA, INT16_MIN, INT16_MAX));
        pkt.power_mW = static_cast<uint16_t>(min<uint32_t>(r.power_mW, UINT16_MAX));
    }

    uint32_t mv = analogReadMilliVolts(PIN_CONT_ADC);
    pkt.sense_mV = static_cast<uint16_t>(mv);
    pkt.sense = static_cast<uint8_t>(
        static_cast<int32_t>(millis() - senseValidAtMs) >= 0 ? classifySense(mv) : Sense::Unknown);
    return pkt;
}

void printStatus(const StatusPacket &p) {
    static const char *SENSE_NAMES[] = {"unknown", "load", "open", "live"};
    Serial.printf("[status] out=%s sense=%s (%u mV) supply=%u mV I=%d mA P=%u mW%s%s\n",
                  p.output ? "ON" : "OFF", SENSE_NAMES[p.sense < 4 ? p.sense : 0], p.sense_mV,
                  p.supply_mV, p.current_mA, p.power_mW,
                  (p.flags & FLAG_INA_OK) ? "" : " [INA260 missing]",
                  (p.flags & FLAG_RESTORED) ? " [restored after reset]" : "");
}

void onOutputRequest(bool on) { pendingOutput = on ? 1 : 0; }

// Bench console over USB CDC: on | off | status
void handleSerial() {
    static String line;
    while (Serial.available()) {
        char c = static_cast<char>(Serial.read());
        if (c != '\n' && c != '\r') {
            if (line.length() < 32) line += c;
            continue;
        }
        line.trim();
        if (line == "on") {
            setOutput(true);
        } else if (line == "off") {
            setOutput(false);
        } else if (line == "status") {
            printStatus(buildStatus());
        } else if (line.length()) {
            Serial.println("commands: on | off | status");
        }
        line = "";
    }
}

}  // namespace

void setup() {
    restoreOutput();

    pinMode(PIN_CONT_EN, OUTPUT);
    digitalWrite(PIN_CONT_EN, outputOn ? LOW : HIGH);
    analogSetPinAttenuation(PIN_CONT_ADC, ADC_11db);
    senseValidAtMs = millis() + SENSE_SETTLE_MS;

    Serial.begin(115200);
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    inaOk = ina.begin(Wire, INA260_ADDR);

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    char name[24];
    snprintf(name, sizeof(name), "STAR-Switch-%02X%02X", mac[4], mac[5]);
    ble_link::begin(name, onOutputRequest);
    ble_link::publishOutput(outputOn);

    Serial.printf("[boot] %s reset=%d output=%s ina260=%s\n", name,
                  static_cast<int>(resetReason), outputOn ? "ON (restored)" : "OFF",
                  inaOk ? "ok" : "MISSING");
}

void loop() {
    int8_t req = pendingOutput;
    if (req >= 0) {
        pendingOutput = -1;
        if ((req == 1) != outputOn) setOutput(req == 1);
        else ble_link::publishOutput(outputOn);
    }

    handleSerial();

    uint32_t period = ble_link::connected() ? STATUS_PERIOD_CONNECTED_MS : STATUS_PERIOD_IDLE_MS;
    uint32_t now = millis();
    bool settledUpdateDue = lastStatusMs == 0 && static_cast<int32_t>(now - senseValidAtMs) >= 0;
    if (settledUpdateDue || now - lastStatusMs >= period) {
        lastStatusMs = now ? now : 1;
        StatusPacket pkt = buildStatus();
        ble_link::publishStatus(pkt);
        if (ble_link::connected()) printStatus(pkt);
    }

    delay(LOOP_PERIOD_MS);
}
