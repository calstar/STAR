/**
 * RTD (Resistance Temperature Detector) Hotfire state machine — ESP32 PCB
 *
 * Same state machine as PT/TC/LC: Waiting for Server → Active → Standalone Abort.
 * Sends heartbeats, streams RTD (differential + IDAC excitation) sensor data to server or abort controller.
 * Uses RTD_Board pin layout and BoardType::RTD. Reads connectors 1–4 (two physical ADS1263 chips).
 * ADC1 (ADC_CS_1) handles connectors 1 & 2; ADC2 (ADC_CS_2) handles connectors 3 & 4.
 * Based on RTD_Testing project for proper RTD read sequence.
 */

#include <Arduino.h>
#include <SPI.h>

#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <vector>
#include <esp_mac.h>

#include "main.h"
#include "STAR_ADS126X.h"

// MUST be defined before sense_board_pins.h / connector_adc_map.h
#define PINS_ACTIVE_LAYOUT sense_board_pins::RTD_Board

#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"
#include "SensorHotfireCore.h"
#include "SensorSelfTest.h"

using namespace sense_board_pins;

//-----------------------------------------------------------------------------
// ADC config — RTD: differential (pin 1 vs pin 2) + IDAC excitation per connector (from RTD_Testing)
//-----------------------------------------------------------------------------
#define FILTER                 ADS126X_SINC4
#define DATA_RATE              ADS126X_RATE_7200
ADS126X_ASSERT_FILTER_RATE(FILTER, DATA_RATE);
#define NUM_CONNECTORS         4   // Connectors 1–4 (ADC1: 1&2, ADC2: 3&4)

static ADS126X ads126x;    // ADC1 — connectors 1 & 2
static ADS126X ads126x_2;  // ADC2 — connectors 3 & 4
SPIClass ADC_SPI(HSPI);
std::vector<Diablo::SensorDataChunkCollection> dataChunks;

static SensorHotfire::CoreState coreState;
static SensorHotfire::Config coreConfig;

static unsigned long g_last_sensor_packet_log_ms = 0;

bool g_sensor_hotfire_serial = true;

// Helper: get the correct ADS126X instance and DRDY pin for a connector
static ADS126X& adc_for_connector(uint8_t connector_id) {
  return (getAdcIndex(connector_id, 1) == 2) ? ads126x_2 : ads126x;
}
static int drdy_for_connector(uint8_t connector_id) {
  return (getAdcIndex(connector_id, 1) == 2) ? Pins.ADC_DRDY_2 : Pins.ADC_DRDY_1;
}

// Set mux and IDAC for one RTD connector (differential + excitation)
static void set_connector_rtd(uint8_t connector_id) {
  ADS126X& adc = adc_for_connector(connector_id);
  adc.setInputMux(getAdcChannel(connector_id, 1), getAdcChannel(connector_id, 2));
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

static void collect_chunk_impl() {
  const uint8_t active_count = coreState.stored_config.num_sensors;
  if (active_count == 0) return;
  const uint8_t* active_ids = coreState.stored_config.sensor_ids;

  Diablo::SensorDataChunkCollection chunk(millis(), active_count);
  for (uint8_t i = 0; i < active_count; i++) {
    const uint8_t conn = active_ids[i];
    set_connector_rtd(conn);
    const int drdy_pin = drdy_for_connector(conn);
    ADS126X& adc = adc_for_connector(conn);
    delayMicroseconds(10);
    while (digitalRead(drdy_pin) != LOW)
      delayMicroseconds(10);
    const auto reading = adc.readADC1();
    const uint32_t value = reading.checksumValid ? static_cast<uint32_t>(reading.value) : 0u;
    chunk.add_datapoint(conn, value);
  }
  if (chunk.size() == active_count && dataChunks.size() < SENSOR_MAX_CHUNKS_BEFORE_SEND)
    dataChunks.push_back(chunk);
}

static void send_chunks_to_impl(IPAddress dest_ip, int dest_port,
                                bool also_to_abort_controller,
                                IPAddress abort_controller_ip, int abort_controller_port) {
  if (dataChunks.empty()) return;
  if (dataChunks.size() < SENSOR_MAX_CHUNKS_BEFORE_SEND) return;
  uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
  const uint8_t num_sensors = dataChunks[0].num_sensors;
  size_t packetSize = Diablo::create_sensor_data_packet(
      dataChunks, num_sensors, millis(), packetBuffer, sizeof(packetBuffer));
  if (packetSize == 0) return;
  coreState.udp.beginPacket(dest_ip, dest_port);
  coreState.udp.write(packetBuffer, packetSize);
  coreState.udp.endPacket();
  SENSOR_HOTFIRE_PRINT("Sent: sensor_data to ");
  SENSOR_HOTFIRE_PRINT(dest_ip);
  SENSOR_HOTFIRE_PRINT(":");
  SENSOR_HOTFIRE_PRINTLN(dest_port);

  unsigned long now = millis();
  if (now - g_last_sensor_packet_log_ms >= 1000) {
    g_last_sensor_packet_log_ms = now;
    SENSOR_HOTFIRE_PRINTLN("SENSOR_DATA contents:");
    for (size_t i = 0; i < dataChunks.size(); ++i) {
      const auto& chunk = dataChunks[i];
      SENSOR_HOTFIRE_PRINT("  chunk ");
      SENSOR_HOTFIRE_PRINT(i);
      SENSOR_HOTFIRE_PRINT(" ts=");
      SENSOR_HOTFIRE_PRINT(chunk.timestamp);
      SENSOR_HOTFIRE_PRINT(" :");
      for (const auto& dp : chunk.datapoints) {
        SENSOR_HOTFIRE_PRINT(" (id=");
        SENSOR_HOTFIRE_PRINT(static_cast<unsigned>(dp.sensor_id));
        SENSOR_HOTFIRE_PRINT(", data=");
        SENSOR_HOTFIRE_PRINT(dp.data);
        SENSOR_HOTFIRE_PRINT(")");
      }
      SENSOR_HOTFIRE_PRINTLN_();
    }
  }

  if (also_to_abort_controller) {
    coreState.udp.beginPacket(abort_controller_ip, abort_controller_port);
    coreState.udp.write(packetBuffer, packetSize);
    coreState.udp.endPacket();
    SENSOR_HOTFIRE_PRINT("Sent: sensor_data to ");
    SENSOR_HOTFIRE_PRINT(abort_controller_ip);
    SENSOR_HOTFIRE_PRINT(":");
    SENSOR_HOTFIRE_PRINTLN(abort_controller_port);
  }
  dataChunks.clear();
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
  uint8_t ref_pos = (reference_voltage == 1) ? ADS126X_REF_POS_VDD : ADS126X_REF_POS_INT;
  ads126x.setReference(ADS126X_REF_NEG_VSS, ref_pos);
  ads126x_2.setReference(ADS126X_REF_NEG_VSS, ref_pos);
}

static void collect_chunk_cb(void*) { collect_chunk_impl(); }

static void send_chunks_to_cb(void*, IPAddress dest_ip, int dest_port,
                             bool also_to_abort_controller,
                             IPAddress abort_controller_ip, int abort_controller_port) {
  send_chunks_to_impl(dest_ip, dest_port, also_to_abort_controller,
                     abort_controller_ip, abort_controller_port);
}

static void run_self_test_cb(void*,
    const SensorHotfire::StoredSensorConfig& cfg,
    std::vector<Diablo::SelfTestResult>& results_out) {

  // 1. ADC self-test (TDAC internal) for both ADCs
  auto adc1_result = SensorSelfTest::run_adc_self_test(
      ads126x, Pins.ADC_DRDY_1,
      ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
  results_out.push_back(Diablo::SelfTestResult{
      0u, static_cast<uint8_t>(adc1_result.passed ? 1 : 0)});

  auto adc2_result = SensorSelfTest::run_adc_self_test(
      ads126x_2, Pins.ADC_DRDY_2,
      ADS126X_REF_NEG_VSS, ADS126X_REF_POS_INT);
  results_out.push_back(Diablo::SelfTestResult{
      100u, static_cast<uint8_t>(adc2_result.passed ? 1 : 0)});

  // 2. Sensor bias continuity test
  SensorSelfTest::sensor_bias_enable(ads126x);
  SensorSelfTest::sensor_bias_enable(ads126x_2);

  for (uint8_t i = 0; i < cfg.num_sensors; i++) {
    uint8_t id = cfg.sensor_ids[i];
    int ch1 = getAdcChannel(id, 1);
    int ch2 = getAdcChannel(id, 2);
    if (ch1 < 0 || ch2 < 0) continue;

    ADS126X& adc = adc_for_connector(id);
    int drdy_pin = drdy_for_connector(id);

    auto bias = SensorSelfTest::read_sensor_bias(
        adc, drdy_pin,
        static_cast<uint8_t>(ch1), static_cast<uint8_t>(ch2));
    uint8_t pass = (bias.result == SensorSelfTest::BiasResult::CONNECTED) ? 1u : 0u;
    results_out.push_back(Diablo::SelfTestResult{id, pass});
  }

  SensorSelfTest::sensor_bias_disable(ads126x);
  SensorSelfTest::sensor_bias_disable(ads126x_2);
}

void setup() {
  // Do NOT memset coreState -- it contains IPAddress (has vtable via Printable)
  // and EthernetUDP. memset zeroes vtable pointers, causing LoadProhibited
  // crashes on virtual calls like Serial.print(IPAddress).
  coreState.gateway = IPAddress(0, 0, 0, 0);
  coreState.subnet = IPAddress(255, 255, 255, 0);
  coreState.dns = IPAddress(192, 168, 2, 1);

  coreConfig.board_name = "RTD";
  coreConfig.pins = &Pins;
  coreConfig.init_adc = init_adc_cb;
  coreConfig.collect_chunk = collect_chunk_cb;
  coreConfig.send_chunks_to = send_chunks_to_cb;
  coreConfig.run_self_test = run_self_test_cb;
  coreConfig.on_reference_voltage_config = on_reference_voltage_cb;
  coreConfig.user_data = nullptr;

  SensorHotfire::setup(coreState, coreConfig);
}

void loop() {
  SensorHotfire::loop(coreState, coreConfig);
}
