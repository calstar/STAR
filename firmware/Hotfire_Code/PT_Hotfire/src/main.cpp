/**
 * PT (Pressure Transducer) Hotfire state machine — ESP32 PCB
 *
 * Three states: Waiting for Server → Active → Standalone Abort (and back to
 * Active on clear). Sends heartbeats, streams sensor data to server or to
 * actuator controller in abort. Uses shared SensorHotfireCore; board-specific:
 * ADC init, collect_chunk, send_chunks_to.
 */

#include "main.h"

#include <Arduino.h>
#include <daq-protocol.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <esp_mac.h>

#include <cstring>
#include <vector>

#include "STAR_ADS126X.h"

// clang-format off
// MUST be defined before sense_board_pins.h / connector_adc_map.h
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board
#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"
#include "SensorHotfireCore.h"
#include "SensorSelfTest.h"
// clang-format on

using namespace sense_board_pins;

//-----------------------------------------------------------------------------
// ADC config (Stream_ADC_Data / PT_BOARD_Multi style)
//-----------------------------------------------------------------------------
#define FILTER ADS126X_SINC5
#define DATA_RATE ADS126X_RATE_38400
ADS126X_ASSERT_FILTER_RATE(FILTER, DATA_RATE);
#define TEST_PIN 1

static ADS126X ads126x;
SPIClass ADC_SPI(HSPI);
std::vector<daq::SensorDataChunkCollection> dataChunks;

static SensorHotfire::CoreState coreState;
static SensorHotfire::Config coreConfig;

static unsigned long g_last_sensor_packet_log_ms = 0;

// Set to true to enable Serial output from core and board; false to disable.
bool g_verbose = true;

static float convert_code_to_voltage(int32_t code) {
    return (static_cast<float>(code) * 2.5f) / 2147483648.0f;
}

static void flush_cycles(int cycles) {
    for (int i = 0; i < cycles; i++) {
        while (digitalRead(Pins.ADC_DRDY_1) != LOW)
            delayMicroseconds(10);
        ads126x.readADC1();
    }
}

static void collect_chunk_impl() {
    const uint8_t active_count = coreState.stored_config.num_sensors;
    if (active_count == 0)
        return;
    const uint8_t* active_ids = coreState.stored_config.sensor_ids;

    daq::SensorDataChunkCollection chunk(millis(), active_count);
    for (uint8_t i = 0; i < active_count; i++) {
        ads126x.setInputMux(getAdcChannel(active_ids[i], TEST_PIN),
                            ADS126X_AINCOM);
        delayMicroseconds(10);
        while (digitalRead(Pins.ADC_DRDY_1) != LOW)
            delayMicroseconds(10);
        const auto reading = ads126x.readADC1();
        const uint32_t value =
            reading.checksumValid ? static_cast<uint32_t>(reading.value) : 0u;
        chunk.add_datapoint(active_ids[i], value);
    }
    if (chunk.size() == active_count &&
        dataChunks.size() < SENSOR_MAX_CHUNKS_BEFORE_SEND)
        dataChunks.push_back(chunk);
}

static void send_chunks_to_impl(IPAddress dest_ip, int dest_port,
                                bool also_to_abort_controller,
                                IPAddress abort_controller_ip,
                                int abort_controller_port) {
    if (dataChunks.empty())
        return;
    if (dataChunks.size() < SENSOR_MAX_CHUNKS_BEFORE_SEND)
        return;
    uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
    const uint8_t num_sensors = dataChunks[0].num_sensors;
    size_t packetSize = daq::create_sensor_data_packet(
        dataChunks, num_sensors, millis(), packetBuffer, sizeof(packetBuffer));
    if (packetSize == 0)
        return;
    coreState.udp.beginPacket(dest_ip, dest_port);
    coreState.udp.write(packetBuffer, packetSize);
    coreState.udp.endPacket();
    HF_VERBOSE("Sent: sensor_data to ");
    HF_VERBOSE(dest_ip);
    HF_VERBOSE(":");
    HF_VERBOSELN(dest_port);

    unsigned long now = millis();
    if (now - g_last_sensor_packet_log_ms >= 1000) {
        g_last_sensor_packet_log_ms = now;
        HF_VERBOSELN("SENSOR_DATA contents:");
        for (size_t i = 0; i < dataChunks.size(); ++i) {
            const auto& chunk = dataChunks[i];
            HF_VERBOSE("  chunk ");
            HF_VERBOSE(i);
            HF_VERBOSE(" ts=");
            HF_VERBOSE(chunk.timestamp);
            HF_VERBOSE(" :");
            for (const auto& dp : chunk.datapoints) {
                HF_VERBOSE(" (id=");
                HF_VERBOSE(static_cast<unsigned>(dp.sensor_id));
                HF_VERBOSE(", data=");
                HF_VERBOSE(dp.data);
                HF_VERBOSE(")");
            }
            HF_VERBOSELN_();
        }
    }

    if (also_to_abort_controller) {
        coreState.udp.beginPacket(abort_controller_ip, abort_controller_port);
        coreState.udp.write(packetBuffer, packetSize);
        coreState.udp.endPacket();
        HF_VERBOSE("Sent: sensor_data to ");
        HF_VERBOSE(abort_controller_ip);
        HF_VERBOSE(":");
        HF_VERBOSELN(abort_controller_port);
    }
    dataChunks.clear();
}

static void init_adc_cb(void*) {
    ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI);
    ADC_SPI.setDataMode(SPI_MODE1);
    pinMode(Pins.ADC_DRDY_1, INPUT);
    ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);
    ads126x.stopADC1();
    ads126x.setInputMux(static_cast<uint8_t>(getAdcChannel(1, TEST_PIN)),
                        ADS126X_AINCOM);
    ads126x.bypassPGA();
    ads126x.setFilter(FILTER);
    ads126x.setRate(DATA_RATE);
    // Reference is not configured here; it must be set from server
    // SENSOR_CONFIG
    ads126x.startADC1();
}

static void on_reference_voltage_cb(void*, uint8_t reference_voltage) {
    // 0 = internal 2.5V, 1 = VDD, 2 = 5V (ignored; use internal)
    uint8_t ref_pos =
        (reference_voltage == 1) ? ADS126X_REF_POS_VDD : ADS126X_REF_POS_INT;
    ads126x.setReference(ADS126X_REF_NEG_VSS, ref_pos);
}

static void collect_chunk_cb(void*) {
    collect_chunk_impl();
}

static void send_chunks_to_cb(void*, IPAddress dest_ip, int dest_port,
                              bool also_to_abort_controller,
                              IPAddress abort_controller_ip,
                              int abort_controller_port) {
    send_chunks_to_impl(dest_ip, dest_port, also_to_abort_controller,
                        abort_controller_ip, abort_controller_port);
}

static const char* bias_result_str(SensorSelfTest::BiasResult r) {
    switch (r) {
        case SensorSelfTest::BiasResult::CONNECTED:
            return "CONNECTED";
        case SensorSelfTest::BiasResult::AMBIGUOUS:
            return "AMBIGUOUS";
        case SensorSelfTest::BiasResult::DISCONNECTED:
            return "DISCONNECTED";
        default:
            return "?";
    }
}

static void run_self_test_cb(void*,
                             const SensorHotfire::StoredSensorConfig& cfg,
                             std::vector<daq::SelfTestResult>& results_out) {
    // 1. ADC self-test (TDAC internal)
    auto adc_result = SensorSelfTest::run_adc_self_test(
        ads126x, Pins.ADC_DRDY_1, ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
    results_out.push_back(daq::SelfTestResult{
        0u, static_cast<uint8_t>(adc_result.passed ? 1 : 0)});

    HF_LOGLN("=== ADC TDAC Self-Test ===");
    // Verdict is Tier 1; the numeric detail is verbose-only.
    HF_VERBOSE("  read code  = ");
    HF_VERBOSELN(adc_result.code);
    HF_VERBOSE("  expected   = ");
    HF_VERBOSELN(SensorSelfTest::ADC_TDAC_EXPECTED_CODE);
    HF_VERBOSE("  tolerance  = ");
    HF_VERBOSELN(SensorSelfTest::ADC_TDAC_TOLERANCE);
    HF_VERBOSE("  checksum   = ");
    HF_VERBOSELN(adc_result.checksum_valid ? "OK" : "FAIL");
    HF_LOG("  result     = ");
    HF_LOGLN(adc_result.passed ? "PASS" : "FAIL");
    Serial.flush();

    // 2. Sensor bias continuity test
    HF_LOGLN("=== Sensor Bias Test ===");
    SensorSelfTest::sensor_bias_enable(ads126x);
    for (uint8_t i = 0; i < cfg.num_sensors; i++) {
        uint8_t id = cfg.sensor_ids[i];
        int channel = getAdcChannel(id, TEST_PIN);
        if (channel < 0) {
            HF_LOG("  sensor id=");
            HF_LOG(id);
            HF_LOGLN("  channel=INVALID  result=FAIL");
            results_out.push_back(daq::SelfTestResult{id, 0u});
            continue;
        }
        auto bias = SensorSelfTest::read_sensor_bias(
            ads126x, Pins.ADC_DRDY_1, static_cast<uint8_t>(channel),
            ADS126X_AINCOM);
        uint8_t pass =
            (bias.result == SensorSelfTest::BiasResult::CONNECTED) ? 1u : 0u;

        HF_LOG("  sensor id=");
        HF_LOG(id);
        HF_VERBOSE("  ch=");
        HF_VERBOSE(channel);
        HF_VERBOSE("  code=");
        HF_VERBOSE(bias.code);
        HF_VERBOSE("  chk=");
        HF_VERBOSE(bias.checksum_valid ? "OK" : "FAIL");
        HF_LOG("  -> ");
        HF_LOGLN(bias_result_str(bias.result));

        results_out.push_back(daq::SelfTestResult{id, pass});
    }
    Serial.flush();
    SensorSelfTest::sensor_bias_disable(ads126x);
}

void setup() {
    // Do NOT memset coreState -- it contains IPAddress (has vtable via
    // Printable) and EthernetUDP. memset zeroes vtable pointers, causing
    // LoadProhibited crashes on virtual calls like Serial.print(IPAddress).
    // Static variables are already zero-initialized for POD members.
    coreState.gateway = IPAddress(0, 0, 0, 0);
    coreState.subnet = IPAddress(255, 255, 255, 0);
    coreState.dns = IPAddress(192, 168, 2, 1);

    coreConfig.board_name = "PT";
    coreConfig.pins = &Pins;
    coreConfig.init_adc = init_adc_cb;
    coreConfig.collect_chunk = collect_chunk_cb;
    coreConfig.send_chunks_to = send_chunks_to_cb;
    // Re-enable self-test now that we guard invalid mappings.
    coreConfig.run_self_test = run_self_test_cb;
    coreConfig.on_reference_voltage_config = on_reference_voltage_cb;
    coreConfig.user_data = nullptr;

    SensorHotfire::setup(coreState, coreConfig);
}

void loop() {
    SensorHotfire::loop(coreState, coreConfig);
}
