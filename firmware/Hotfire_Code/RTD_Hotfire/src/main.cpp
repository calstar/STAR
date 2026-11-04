/**
 * RTD (Resistance Temperature Detector) Hotfire state machine — ESP32 PCB
 *
 * Same state machine as PT/TC/LC: Waiting for Server → Active → Standalone
 * Abort. Sends heartbeats, streams RTD (differential + IDAC excitation) sensor
 * data to server or abort controller. Uses RTD_Board pin layout and
 * BoardType::RTD. Reads connectors 1–4 (two physical ADS1263 chips). ADC1
 * (ADC_CS_1) handles connectors 1 & 2; ADC2 (ADC_CS_2) handles connectors 3
 * & 4. Based on RTD_Testing project for proper RTD read sequence.
 */

#include "main.h"

#include <Arduino.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <daq-protocol.h>
#include <esp_mac.h>

#include <cstring>
#include <vector>

#include "STAR_ADS126X.h"

// clang-format off
// MUST be defined before sense_board_pins.h / connector_adc_map.h
#define PINS_ACTIVE_LAYOUT sense_board_pins::RTD_Board
#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"
#include "SensorHotfireCore.h"
#include "SensorSelfTest.h"
// clang-format on

using namespace sense_board_pins;

//-----------------------------------------------------------------------------
// ADC config — RTD: differential (pin 1 vs pin 2) + IDAC excitation per
// connector (from RTD_Testing)
//-----------------------------------------------------------------------------
// FIR @ 20 SPS: the ADS1263's quietest mode, and its FIR has fixed 50/60 Hz
// rejection nulls (datasheet Table 9-13 / p93 — FIR is available only at
// 2.5/5/10/20 SPS). This sensor is slow enough that 20 SPS is ample.
#define FILTER ADS126X_FIR
#define DATA_RATE ADS126X_RATE_20
ADS126X_ASSERT_FILTER_RATE(FILTER, DATA_RATE);
#define NUM_CONNECTORS 4  // Connectors 1–4 (ADC1: 1&2, ADC2: 3&4)

static ADS126X ads126x;    // ADC1 — connectors 1 & 2
static ADS126X ads126x_2;  // ADC2 — connectors 3 & 4
SPIClass ADC_SPI(HSPI);

static SensorHotfire::CoreState coreState;
static SensorHotfire::Config coreConfig;

bool g_verbose = true;

// Helper: get the correct ADS126X instance and DRDY pin for a connector
static ADS126X& adc_for_connector(uint8_t connector_id) {
    return (getAdcIndex(connector_id, 1) == 2) ? ads126x_2 : ads126x;
}
static int drdy_for_connector(uint8_t connector_id) {
    return (getAdcIndex(connector_id, 1) == 2) ? Pins.ADC_DRDY_2
                                               : Pins.ADC_DRDY_1;
}

// Set mux and IDAC for one RTD connector (differential + excitation)
static void set_connector_rtd(uint8_t connector_id) {
    ADS126X& adc = adc_for_connector(connector_id);
    adc.setInputMux(getAdcChannel(connector_id, 1),
                    getAdcChannel(connector_id, 2));
    const int idac1 = getIdacChannel(connector_id, 1);
    const int idac2 = getIdacChannel(connector_id, 2);
    if (idac1 >= 0) {
        adc.setIDAC1Pin(static_cast<uint8_t>(idac1));
        adc.setIDAC1Mag(ADS126X_IDAC_MAG_1000);
    }
    if (idac2 >= 0) {
        adc.setIDAC2Pin(static_cast<uint8_t>(idac2));
        adc.setIDAC2Mag(ADS126X_IDAC_MAG_1000);
    }
}

// ADC task: one reading of every configured connector.
static bool read_chunk_cb(void*, const SensorHotfire::StoredSensorConfig& cfg,
                          SensorHotfire::Chunk& out) {
    for (uint8_t i = 0; i < cfg.num_sensors; i++) {
        const uint8_t conn = cfg.sensor_ids[i];
        set_connector_rtd(conn);
        const int drdy_pin = drdy_for_connector(conn);
        ADS126X& adc = adc_for_connector(conn);
        delayMicroseconds(10);
        if (!SensorHotfire::waitDrdy(drdy_pin) ||
            !SensorHotfire::readChecked(adc, drdy_pin, out.values[i]))
            return false;
    }
    return true;
}

static void init_adc_cb(void*) {
    // Deselect both CS pins before anything else so neither chip floats LOW
    pinMode(Pins.ADC_CS_1, OUTPUT);
    digitalWrite(Pins.ADC_CS_1, HIGH);
    pinMode(Pins.ADC_CS_2, OUTPUT);
    digitalWrite(Pins.ADC_CS_2, HIGH);

    // Drive RESET and START pins for both chips
    if (Pins.ADC_RESET_1 >= 0) {
        pinMode(Pins.ADC_RESET_1, OUTPUT);
        digitalWrite(Pins.ADC_RESET_1, LOW);
        delay(10);
        digitalWrite(Pins.ADC_RESET_1, HIGH);
        delay(10);
    }
    if (Pins.ADC_START_1 >= 0) {
        pinMode(Pins.ADC_START_1, OUTPUT);
        digitalWrite(Pins.ADC_START_1, HIGH);
    }
    if (Pins.ADC_RESET_2 >= 0) {
        pinMode(Pins.ADC_RESET_2, OUTPUT);
        digitalWrite(Pins.ADC_RESET_2, LOW);
        delay(10);
        digitalWrite(Pins.ADC_RESET_2, HIGH);
        delay(10);
    }
    if (Pins.ADC_START_2 >= 0) {
        pinMode(Pins.ADC_START_2, OUTPUT);
        digitalWrite(Pins.ADC_START_2, HIGH);
    }

    // SPI bus — use -1 for SS so hardware doesn't auto-assert any CS pin
    ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, -1);
    ADC_SPI.setDataMode(SPI_MODE1);

    // --- ADC1 (connectors 1 & 2) ---
    pinMode(Pins.ADC_DRDY_1, INPUT);
    ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);
    ads126x.stopADC1();
    set_connector_rtd(1);
    ads126x.bypassPGA();
    ads126x.setFilter(FILTER);
    ads126x.setRate(DATA_RATE);
    ads126x.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
    ads126x.startADC1();

    // --- ADC2 (connectors 3 & 4) ---
    pinMode(Pins.ADC_DRDY_2, INPUT);
    ads126x_2.begin(Pins.ADC_CS_2, &ADC_SPI);
    ads126x_2.stopADC1();
    set_connector_rtd(3);
    ads126x_2.bypassPGA();
    ads126x_2.setFilter(FILTER);
    ads126x_2.setRate(DATA_RATE);
    ads126x_2.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
    ads126x_2.startADC1();
}

static void on_reference_voltage_cb(void*, uint8_t reference_voltage) {
    uint8_t ref_pos =
        (reference_voltage == 1) ? ADS126X_REF_POS_VDD : ADS126X_REF_POS_INT;
    ads126x.setReference(ADS126X_REF_NEG_VSS, ref_pos);
    ads126x_2.setReference(ADS126X_REF_NEG_VSS, ref_pos);
}

static void run_self_test_cb(void*,
                             const SensorHotfire::StoredSensorConfig& cfg,
                             std::vector<daq::SelfTestResult>& results_out) {
    // 1. ADC self-test (TDAC internal) for both ADCs
    auto adc1_result = SensorSelfTest::run_adc_self_test(
        ads126x, Pins.ADC_DRDY_1, ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
    results_out.push_back(daq::SelfTestResult{
        0u, static_cast<uint8_t>(adc1_result.passed ? 1 : 0)});

    auto adc2_result = SensorSelfTest::run_adc_self_test(
        ads126x_2, Pins.ADC_DRDY_2, ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
    results_out.push_back(daq::SelfTestResult{
        100u, static_cast<uint8_t>(adc2_result.passed ? 1 : 0)});

    // 2. Sensor bias continuity test
    SensorSelfTest::sensor_bias_enable(ads126x);
    SensorSelfTest::sensor_bias_enable(ads126x_2);

    for (uint8_t i = 0; i < cfg.num_sensors; i++) {
        uint8_t id = cfg.sensor_ids[i];
        int ch1 = getAdcChannel(id, 1);
        int ch2 = getAdcChannel(id, 2);
        if (ch1 < 0 || ch2 < 0)
            continue;

        ADS126X& adc = adc_for_connector(id);
        int drdy_pin = drdy_for_connector(id);

        auto bias = SensorSelfTest::read_sensor_bias(adc, drdy_pin,
                                                     static_cast<uint8_t>(ch1),
                                                     static_cast<uint8_t>(ch2));
        uint8_t pass =
            (bias.result == SensorSelfTest::BiasResult::CONNECTED) ? 1u : 0u;
        results_out.push_back(daq::SelfTestResult{id, pass});
    }

    SensorSelfTest::sensor_bias_disable(ads126x);
    SensorSelfTest::sensor_bias_disable(ads126x_2);
}

void setup() {
    // Do NOT memset coreState -- it contains IPAddress (has vtable via
    // Printable) and EthernetUDP. memset zeroes vtable pointers, causing
    // LoadProhibited crashes on virtual calls like Serial.print(IPAddress).
    coreState.gateway = IPAddress(0, 0, 0, 0);
    coreState.subnet = IPAddress(255, 255, 255, 0);
    coreState.dns = IPAddress(192, 168, 2, 1);

    coreConfig.board_name = "RTD";
    coreConfig.pins = &Pins;
    coreConfig.adc_rate_code = DATA_RATE;
    coreConfig.adc_settle_conversions = settlePulses(FILTER, DATA_RATE);
    coreConfig.init_adc = init_adc_cb;
    coreConfig.read_chunk = read_chunk_cb;
    coreConfig.run_self_test = run_self_test_cb;
    coreConfig.on_reference_voltage_config = on_reference_voltage_cb;
    coreConfig.user_data = nullptr;

    SensorHotfire::setup(coreState, coreConfig);
}

void loop() {
    SensorHotfire::loop(coreState, coreConfig);
}
