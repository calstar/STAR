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
#include <esp_rom_gpio.h>
#include <esp_mac.h>
#include <esp_pm.h>
#include <esp_system.h>

#include "../../Hotfire_Code/common/firmware_hash.h"
#include "ble_link.h"
#include "ina260.h"
#include "led_pattern.h"
#include "pins.h"
#include "status.h"

namespace {

// Sense thresholds on the CONT_ADC node (about half of VOUT after D2). Open
// measured 260-425 mV on the bench (no battery, so U3's QOD pull-down is off).
// Live is (VOUT - D2) / 2: ~1.5 V from a flat 1S at 3.3 V, clamped by the zener
// near 2.5 V for 2S and up, so the cut sits well below a flat 1S.
constexpr uint32_t SENSE_LOAD_MAX_MV = 150;
constexpr uint32_t SENSE_LIVE_MIN_MV = 1000;

// The board needs 3.5 V in; an empty J1-3 floats at 0.3-0.55 V.
constexpr uint16_t BATTERY_PRESENT_MIN_MV = 2500;

constexpr uint32_t STATUS_PERIOD_CONNECTED_MS = 2000;
// Short enough for the LED to follow a battery being plugged in or pulled.
constexpr uint32_t STATUS_PERIOD_IDLE_MS = 3000;
constexpr uint32_t SENSE_SETTLE_MS = 500;  // 1M into C5 + C23, tau ~100 ms

constexpr uint32_t LOOP_PERIOD_MS = 20;
constexpr uint32_t LED_SENSE_PERIOD_MS = 250;  // how often the LED re-reads the sense line

// USB has to be gone this long before the chip may light-sleep (it stops the
// USB console, so it only sleeps on battery).
constexpr uint32_t USB_GONE_MS = 2000;

constexpr uint32_t RTC_MAGIC_ON = 0x53574F4E;   // "SWON"
constexpr uint32_t RTC_MAGIC_OFF = 0x53574F46;  // "SWOF"
RTC_NOINIT_ATTR uint32_t rtcOutputState;

INA260 ina;
bool inaOk = false;
bool outputOn = false;
bool restoredAfterReset = false;
bool noBattery = false;  // only claimed from a valid INA260 reading
esp_reset_reason_t resetReason = ESP_RST_UNKNOWN;

// Written from the NimBLE host task, applied in loop().
volatile int8_t pendingOutput = -1;

esp_pm_lock_handle_t usbAwakeLock = nullptr;
bool usbAwakeHeld = false;
uint32_t usbLastSeenMs = 0;

uint32_t lastStatusMs = 0;
uint32_t senseValidAtMs = 0;

// LED state. lastCommandMs is 0 until the first arm/disarm of this boot.
uint32_t lastCommandMs = 0;
uint32_t lastConnectMs = 0;
uint32_t seenConnects = 0;
uint32_t lastLedSenseMs = 0;
Sense ledSense = Sense::Unknown;
led::Rgb ledShown{1, 1, 1};  // not a real colour, so the first write always lands

// GPIO4 comes out of reset as MTMS (JTAG), not GPIO, so the pad has to be
// switched to its GPIO function or the output never reaches the pin. Level and
// direction are set while the pad is still held, so releasing the hold is the
// only moment it can change.
void driveOutputPad(bool on) {
    const gpio_num_t pin = static_cast<gpio_num_t>(PIN_OUT_EN);
    gpio_set_level(pin, on ? 1 : 0);
    esp_rom_gpio_pad_select_gpio(PIN_OUT_EN);
    gpio_set_direction(pin, GPIO_MODE_OUTPUT);
    gpio_hold_dis(pin);
    gpio_hold_en(pin);
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
    lastCommandMs = millis() ? millis() : 1;
    ledSense = Sense::Unknown;
    Serial.printf("[out] %s\n", on ? "ARMED" : "DISARMED");
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

// Armed and not live reads as load/open, not Unknown: that is the fault the web
// client and the LED flag. Unknown means only "still settling".
Sense classifySense(uint32_t mv) {
    if (mv >= SENSE_LIVE_MIN_MV) return Sense::Live;
    return mv <= SENSE_LOAD_MAX_MV ? Sense::LoadPresent : Sense::Open;
}

Sense readSense(uint32_t mv) {
    return static_cast<int32_t>(millis() - senseValidAtMs) >= 0 ? classifySense(mv) : Sense::Unknown;
}

uint32_t since(uint32_t thenMs, uint32_t nowMs) { return thenMs ? nowMs - thenMs : UINT32_MAX; }

void updateLed(uint32_t now) {
    uint32_t connects = ble_link::connectCount();
    if (connects != seenConnects) {
        seenConnects = connects;
        lastConnectMs = now ? now : 1;
    }
    if (now - lastLedSenseMs >= LED_SENSE_PERIOD_MS) {
        lastLedSenseMs = now;
        ledSense = readSense(analogReadMilliVolts(PIN_CONT_ADC));
    }
    led::Inputs in{outputOn,          ledSense, restoredAfterReset, inaOk,
                   since(lastCommandMs, now), since(lastConnectMs, now), noBattery};
    led::Rgb c = led::color(in, now);
    if (!(c == ledShown)) {
        neopixelWrite(PIN_LED, c.r, c.g, c.b);  // SK6805 is GRB; neopixelWrite reorders
        ledShown = c;
    }
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
        noBattery = r.bus_mV < BATTERY_PRESENT_MIN_MV;
    } else if (!inaOk) {
        noBattery = false;  // can't tell; the LED shows the INA260 fault instead
    }
    if (noBattery) pkt.flags |= FLAG_NO_BATTERY;

    uint32_t mv = analogReadMilliVolts(PIN_CONT_ADC);
    pkt.sense_mV = static_cast<uint16_t>(mv);
    pkt.sense = static_cast<uint8_t>(readSense(mv));
    return pkt;
}

void printStatus(const StatusPacket &p) {
    static const char *SENSE_NAMES[] = {"unknown", "load", "open", "live"};
    const char *power = !usbAwakeLock ? "no light sleep" : usbAwakeHeld ? "awake for USB" : "light sleep";
    Serial.printf("[status] out=%s sense=%s (%u mV) supply=%u mV I=%d mA P=%u mW power=%s%s%s%s\n",
                  p.output ? "ARMED" : "DISARMED", SENSE_NAMES[p.sense < 4 ? p.sense : 0], p.sense_mV,
                  p.supply_mV, p.current_mA, p.power_mW, power,
                  (p.flags & FLAG_INA_OK) ? "" : " [INA260 missing]",
                  (p.flags & FLAG_RESTORED) ? " [restored after reset]" : "",
                  (p.flags & FLAG_NO_BATTERY) ? " [no battery]" : "");
}

// Light sleep between BLE events cuts idle draw from ~80 mA to a few mA (see
// sdkconfig.defaults). Starts held awake so the console works from boot.
void beginPowerSave() {
    // IDF puts every pin in its sleep config (not driving) during light sleep;
    // keep these on their normal config so they hold their level through sleep.
    for (int pin : {PIN_OUT_EN, PIN_CONT_EN, PIN_LED}) gpio_sleep_sel_dis(static_cast<gpio_num_t>(pin));
    esp_pm_config_esp32c3_t cfg = {};
    cfg.max_freq_mhz = 80;
    // No scaling while awake: the RMT that drives the LED times bits off APB and
    // IDF 4.4 doesn't hold it at 80 MHz, so a write at 40 MHz garbles the colour.
    cfg.min_freq_mhz = 80;
    cfg.light_sleep_enable = true;
    esp_err_t err = esp_pm_configure(&cfg);
    if (err == ESP_OK) err = esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "usb", &usbAwakeLock);
    if (err == ESP_OK) err = esp_pm_lock_acquire(usbAwakeLock);
    usbAwakeHeld = err == ESP_OK;
    usbLastSeenMs = millis();
    if (err != ESP_OK) Serial.printf("[power] light sleep unavailable: %s\n", esp_err_to_name(err));
}

// Stay awake while USB is plugged in; sleep once it has been gone a while.
void updatePowerSave(uint32_t now) {
    if (!usbAwakeLock) return;
    if (HWCDC::isPlugged()) {
        usbLastSeenMs = now;
        if (!usbAwakeHeld) usbAwakeHeld = esp_pm_lock_acquire(usbAwakeLock) == ESP_OK;
    } else if (usbAwakeHeld && now - usbLastSeenMs >= USB_GONE_MS) {
        usbAwakeHeld = esp_pm_lock_release(usbAwakeLock) != ESP_OK;
    }
}

void onOutputRequest(bool on) { pendingOutput = on ? 1 : 0; }

// Bench console over USB CDC: arm | disarm | status (on/off still accepted)
void handleSerial() {
    static String line;
    while (Serial.available()) {
        char c = static_cast<char>(Serial.read());
        if (c != '\n' && c != '\r') {
            if (line.length() < 32) line += c;
            continue;
        }
        line.trim();
        if (line == "arm" || line == "on") {
            setOutput(true);
        } else if (line == "disarm" || line == "off") {
            setOutput(false);
        } else if (line == "status") {
            printStatus(buildStatus());
            FirmwareHash::print();
        } else if (line.length()) {
            Serial.println("commands: arm | disarm | status");
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
    beginPowerSave();
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    inaOk = ina.begin(Wire, INA260_ADDR);

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    char name[24];
    snprintf(name, sizeof(name), "STAR-Switch-%02X%02X", mac[4], mac[5]);
    ble_link::begin(name, onOutputRequest);
    ble_link::publishOutput(outputOn);
    // SHA-256 ESP-IDF appended to this image: what CI's firmware-registry is keyed on.
    ble_link::publishFirmwareHash(FirmwareHash::get());

    Serial.printf("[boot] %s reset=%d output=%s ina260=%s\n", name,
                  static_cast<int>(resetReason), outputOn ? "ARMED (restored)" : "DISARMED",
                  inaOk ? "ok" : "MISSING");
    FirmwareHash::print();
}

void loop() {
    int8_t req = pendingOutput;
    if (req >= 0) {
        pendingOutput = -1;
        if ((req == 1) != outputOn) setOutput(req == 1);
        else ble_link::publishOutput(outputOn);
    }

    handleSerial();
    updateLed(millis());
    updatePowerSave(millis());

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
