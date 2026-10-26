/**
 * TC (Thermocouple) Hotfire state machine — ESP32 PCB
 *
 * Same state machine as PT Hotfire: Waiting for Server → Active → Standalone
 * Abort (and back to Active on clear). Sends heartbeats, streams
 * thermocouple/sensor data to server or to actuator controller in abort. Uses
 * TC_Board pin layout and BoardType::THERMOCOUPLE. Uses shared
 * SensorHotfireCore; board-specific: ADC init, read_chunk, reference voltage,
 * self-test.
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
#define PINS_ACTIVE_LAYOUT sense_board_pins::TC_Board
#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"
#include "SensorHotfireCore.h"
#include "SensorSelfTest.h"
// clang-format on

using namespace sense_board_pins;

//-----------------------------------------------------------------------------
// ADC config (Stream_ADC_Data / multi-channel style)
//-----------------------------------------------------------------------------
// FIR @ 20 SPS: the ADS1263's quietest mode, and its FIR has fixed 50/60 Hz
// rejection nulls (datasheet Table 9-13 / p93 — FIR is available only at
// 2.5/5/10/20 SPS). This sensor is slow enough that 20 SPS is ample.
#define FILTER ADS126X_FIR
#define DATA_RATE ADS126X_RATE_20
ADS126X_ASSERT_FILTER_RATE(FILTER, DATA_RATE);
#define TEST_PIN 1
#define NUM_CHANNELS 10

static ADS126X ads126x;
SPIClass ADC_SPI(HSPI);

static SensorHotfire::CoreState coreState;
static SensorHotfire::Config coreConfig;

// Set to true to enable Serial output from core and board; false to disable.
bool g_verbose = true;

// ADC task: one reading of every configured channel.
static bool read_chunk_cb(void*, const SensorHotfire::StoredSensorConfig& cfg,
                          SensorHotfire::Chunk& out) {
    for (uint8_t i = 0; i < cfg.num_sensors; i++) {
        ads126x.setInputMux(getAdcChannel(cfg.sensor_ids[i], TEST_PIN),
                            ADS126X_AINCOM);
        delayMicroseconds(10);
        if (!SensorHotfire::waitDrdy(Pins.ADC_DRDY_1)) {
            out.values[i] = 0;
            continue;
        }
        const auto reading = ads126x.readADC1();
        out.values[i] =
            reading.checksumValid ? static_cast<uint32_t>(reading.value) : 0u;
    }
    return true;
}

static void init_adc_cb(void*) {
    ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);
    ADC_SPI.setDataMode(SPI_MODE1);
    pinMode(Pins.ADC_DRDY_1, INPUT);
    ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);
    ads126x.stopADC1();
    ads126x.setInputMux(static_cast<uint8_t>(getAdcChannel(1, TEST_PIN)),
                        ADS126X_AINCOM);
    ads126x.bypassPGA();
    ads126x.setFilter(FILTER);
    ads126x.setRate(DATA_RATE);
    ads126x.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
    ads126x.startADC1();
}

static void on_reference_voltage_cb(void*, uint8_t reference_voltage) {
    uint8_t ref_pos =
        (reference_voltage == 1) ? ADS126X_REF_POS_VDD : ADS126X_REF_POS_INT;
    ads126x.setReference(ADS126X_REF_NEG_VSS, ref_pos);
}

static void run_self_test_cb(void*,
                             const SensorHotfire::StoredSensorConfig& cfg,
                             std::vector<daq::SelfTestResult>& results_out) {
    // 1. ADC self-test (TDAC internal)
    auto adc_result = SensorSelfTest::run_adc_self_test(
        ads126x, Pins.ADC_DRDY_1, ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
    results_out.push_back(daq::SelfTestResult{
        0u, static_cast<uint8_t>(adc_result.passed ? 1 : 0)});

    // 2. Sensor bias continuity test
    SensorSelfTest::sensor_bias_enable(ads126x);
    for (uint8_t i = 0; i < cfg.num_sensors; i++) {
        uint8_t id = cfg.sensor_ids[i];
        auto bias = SensorSelfTest::read_sensor_bias(
            ads126x, Pins.ADC_DRDY_1, getAdcChannel(id, TEST_PIN),
            ADS126X_AINCOM);
        uint8_t pass =
            (bias.result == SensorSelfTest::BiasResult::CONNECTED) ? 1u : 0u;
        results_out.push_back(daq::SelfTestResult{id, pass});
    }
    SensorSelfTest::sensor_bias_disable(ads126x);
}

void setup() {
    // Do NOT memset coreState -- it contains IPAddress (has vtable via
    // Printable) and EthernetUDP. memset zeroes vtable pointers, causing
    // LoadProhibited crashes on virtual calls like Serial.print(IPAddress).
    coreState.gateway = IPAddress(0, 0, 0, 0);
    coreState.subnet = IPAddress(255, 255, 255, 0);
    coreState.dns = IPAddress(192, 168, 2, 1);

    coreConfig.board_name = "TC";
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
