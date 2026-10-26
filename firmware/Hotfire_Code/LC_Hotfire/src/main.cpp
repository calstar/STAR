/**
 * LC (Load Cell) Hotfire state machine — ESP32 PCB
 *
 * Same state machine: Waiting for Server → Active → Standalone Abort (and back
 * to Active on clear). Sends heartbeats, streams load-cell (differential)
 * sensor data to server or to actuator controller in abort. Uses LC_Board pin
 * layout and BoardType::LOAD_CELL. Only connectors on ADC 1 (1, 2, 3, 6, 7).
 * Differential read between pin 1 and pin 2 per connector.
 * Uses shared SensorHotfireCore; board-specific: ADC init, read_chunk,
 * reference voltage, self-test.
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
#define PINS_ACTIVE_LAYOUT sense_board_pins::LC_Board
#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"
#include "SensorHotfireCore.h"
#include "SensorSelfTest.h"
// clang-format on

using namespace sense_board_pins;

//-----------------------------------------------------------------------------
// ADC config — LC Board ADC 1 only; differential (pin 1 vs pin 2) per connector
//-----------------------------------------------------------------------------
// 38400 SPS + SINC5 is the part's fastest and noisiest setting (~1.5 uV RMS
// input-referred at gain 32). Nothing on this board needs that bandwidth: the
// load cell is a scale reading a fill over seconds. 400 SPS + SINC4 is ~16x
// quieter for free, before any host-side filtering.
#define FILTER ADS126X_SINC4
#define DATA_RATE ADS126X_RATE_20
ADS126X_ASSERT_FILTER_RATE(FILTER, DATA_RATE);
#define GAIN ADS126X_GAIN_32
#define NUM_CHANNELS 5

static const uint8_t LC_ADC1_CONNECTORS[] = {1, 2, 3, 6, 7};

static ADS126X ads126x;
SPIClass ADC_SPI(HSPI);

static SensorHotfire::CoreState coreState;
static SensorHotfire::Config coreConfig;

// Set to true to enable Serial output from core and board; false to disable.
bool g_verbose = true;

static void flush_cycles(int cycles) {
    for (int i = 0; i < cycles; i++) {
        SensorHotfire::waitDrdy(Pins.ADC_DRDY_1);
        ads126x.readADC1();
    }
}

static int last_mux_p = -1, last_mux_n = -1;

// ADC task: one reading of every configured connector.
static bool read_chunk_cb(void*, const SensorHotfire::StoredSensorConfig& cfg,
                          SensorHotfire::Chunk& out) {
    for (uint8_t i = 0; i < cfg.num_sensors; i++) {
        const uint8_t connector_id = cfg.sensor_ids[i];
        const int ch1 = getAdcChannel(connector_id, 1);
        const int ch2 = getAdcChannel(connector_id, 2);
        // An unmapped connector leaves the chunk incomplete: drop it, as
        // before, rather than send a reading that is not there.
        if (ch1 < 0 || ch2 < 0)
            return false;
        const bool mux_changed = (ch1 != last_mux_p || ch2 != last_mux_n);
        ads126x.setInputMux(static_cast<uint8_t>(ch1),
                            static_cast<uint8_t>(ch2));
        last_mux_p = ch1;
        last_mux_n = ch2;
        delayMicroseconds(10);
        // Only after an actual channel change does the digital filter still
        // hold the previous input's samples. Flushing unconditionally throws
        // away a perfectly good conversion every cycle, which halves the
        // output rate when a single connector is active.
        if (mux_changed)
            flush_cycles(settlePulses(FILTER, DATA_RATE));
        SensorHotfire::waitDrdy(Pins.ADC_DRDY_1);
        // DRDY asserts as the conversion register is being updated; reading
        // immediately catches it mid-update and yields corrupted samples.
        // LC_Calibration/PT_BOARD_Multi both pause here before reading.
        delayMicroseconds(25);
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
    ads126x.setInputMux(static_cast<uint8_t>(getAdcChannel(1, 1)),
                        static_cast<uint8_t>(getAdcChannel(1, 2)));
    ads126x.enablePGA();
    ads126x.setGain(GAIN);
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
        int ch1 = getAdcChannel(id, 1);
        int ch2 = getAdcChannel(id, 2);
        if (ch1 < 0 || ch2 < 0)
            continue;

        auto bias = SensorSelfTest::read_sensor_bias(ads126x, Pins.ADC_DRDY_1,
                                                     static_cast<uint8_t>(ch1),
                                                     static_cast<uint8_t>(ch2));
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

    coreConfig.board_name = "LC";
    coreConfig.pins = &Pins;
    coreConfig.adc_rate_code = DATA_RATE;
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
