/**
 * ProtoEncoder Hotfire — dual AS5600 encoder board
 *
 * Minimal state machine: Setup -> SelfTest -> Active.
 * In Setup, sends SETUP heartbeats and waits for any SENSOR_CONFIG packet.
 * In SelfTest, probes each encoder over I2C, sends a SELF_TEST packet, then
 * transitions to Active. In Active, streams encoder data continuously.
 */

#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>

#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <vector>
#include <esp_mac.h>

#ifndef BOARD_ID
#define BOARD_ID 61
#endif
#include "hotfire_config.h"
#include "sense_config.h"
#include "firmware_hash.h"
#include "hotfire_ota.h"

// ---------------------------------------------------------------------------
// Pin definitions — Encoder Board PCB
// ---------------------------------------------------------------------------

// Encoder 1 (Wire)
static constexpr int ENC1_SDA = 4;
static constexpr int ENC1_SCL = 5;

// Encoder 2 (Wire1)
static constexpr int ENC2_SDA = 15;
static constexpr int ENC2_SCL = 7;

// W5500 Ethernet (SPI)
static constexpr int ETH_MOSI = 11;
static constexpr int ETH_MISO = 13;
static constexpr int ETH_SCLK = 12;
static constexpr int ETH_CS   = 10;

// ---------------------------------------------------------------------------
// AS5600 constants
// ---------------------------------------------------------------------------
static constexpr uint8_t AS5600_ADDR    = 0x36;
static constexpr uint8_t REG_STATUS     = 0x0B;
static constexpr uint8_t REG_RAW_MSB    = 0x0C;
static constexpr uint8_t STATUS_MH      = 0x08;  // magnet too strong
static constexpr uint8_t STATUS_ML      = 0x10;  // magnet too weak
static constexpr uint8_t STATUS_MD      = 0x20;  // magnet detected
static constexpr uint16_t READ_ERROR    = 0xFFFF;

// Sensor IDs used in SENSOR_DATA packets
static constexpr uint8_t SENSOR_ID_ENC1 = 1;
static constexpr uint8_t SENSOR_ID_ENC2 = 2;
static constexpr uint8_t NUM_SENSORS    = 2;

// ---------------------------------------------------------------------------
// Network / packet config
// ---------------------------------------------------------------------------
static constexpr int ENCODER_PACKET_BUF_SIZE = 512;
static constexpr int UDP_LISTEN_PORT = 5005;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
enum class State : uint8_t { Setup = 1, SelfTest = 10, Active = 2 };
static State boardState = State::Setup;

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
static byte mac[6];
static IPAddress staticIP;
static IPAddress gateway(0, 0, 0, 0);
static IPAddress subnet(255, 255, 255, 0);
static IPAddress dns_addr(192, 168, 2, 1);
static IPAddress serverIP(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
static constexpr int serverPort = HOTFIRE_SERVER_PORT;

static EthernetUDP udp;
static OTAEthernetServer otaServer(HOTFIRE_OTA_PORT);

static std::vector<Diablo::SensorDataChunkCollection> dataChunks;
static unsigned long lastHeartbeatMs = 0;

// ---------------------------------------------------------------------------
// AS5600 I2C helpers (parameterized by bus)
// ---------------------------------------------------------------------------

static bool i2cReadBytes(TwoWire& bus, uint8_t reg, uint8_t* buf, uint8_t len) {
  bus.beginTransmission(AS5600_ADDR);
  bus.write(reg);
  if (bus.endTransmission(false) != 0)
    return false;
  bus.requestFrom(AS5600_ADDR, len);
  if (bus.available() < len)
    return false;
  for (uint8_t i = 0; i < len; i++)
    buf[i] = bus.read();
  return true;
}

static uint16_t readRawAngle(TwoWire& bus) {
  uint8_t buf[2];
  if (!i2cReadBytes(bus, REG_RAW_MSB, buf, 2))
    return READ_ERROR;
  return ((uint16_t)(buf[0] << 8) | buf[1]) & 0x0FFF;
}

static bool checkMagnetPresence(TwoWire& bus, const char* label) {
  Serial.print("[");
  Serial.print(label);
  Serial.println("] Checking magnet...");
  unsigned long start = millis();
  while (millis() - start < 3000) {
    uint8_t status;
    if (!i2cReadBytes(bus, REG_STATUS, &status, 1)) {
      Serial.print("[");
      Serial.print(label);
      Serial.println("] ERROR: could not read STATUS — check wiring");
      delay(500);
      continue;
    }
    status &= 0x38;
    if (status & STATUS_MD) {
      if (status & STATUS_MH) {
        Serial.print("[");
        Serial.print(label);
        Serial.println("] WARNING: magnet too strong — increase air gap");
        return false;
      }
      if (status & STATUS_ML) {
        Serial.print("[");
        Serial.print(label);
        Serial.println("] WARNING: magnet too weak — decrease air gap");
        return false;
      }
      Serial.print("[");
      Serial.print(label);
      Serial.println("] Magnet detected OK");
      return true;
    }
    delay(100);
  }
  Serial.print("[");
  Serial.print(label);
  Serial.println("] ERROR: no magnet detected after 3 s");
  return false;
}

// ---------------------------------------------------------------------------
// Encoder self-test — verify I2C communication with each AS5600
// ---------------------------------------------------------------------------

static bool testEncoderComms(TwoWire& bus) {
  uint8_t status;
  return i2cReadBytes(bus, REG_STATUS, &status, 1);
}

static void runSelfTest() {
  Serial.println("=== Encoder Self-Test ===");

  uint8_t adc_good = 0;  // no ADC on this board
  Serial.println("  ADC TDAC: FAIL (no ADC)");

  bool enc1_ok = testEncoderComms(Wire);
  Serial.print("  Encoder 1 I2C: ");
  Serial.println(enc1_ok ? "PASS" : "FAIL");

  bool enc2_ok = testEncoderComms(Wire1);
  Serial.print("  Encoder 2 I2C: ");
  Serial.println(enc2_ok ? "PASS" : "FAIL");

  std::vector<Diablo::SelfTestResult> results;
  results.push_back(Diablo::SelfTestResult{SENSOR_ID_ENC1, static_cast<uint8_t>(enc1_ok ? 1 : 0)});
  results.push_back(Diablo::SelfTestResult{SENSOR_ID_ENC2, static_cast<uint8_t>(enc2_ok ? 1 : 0)});

  uint8_t buf[ENCODER_PACKET_BUF_SIZE];
  size_t n = Diablo::create_self_test_packet(adc_good, results, millis(), buf, sizeof(buf));
  if (n > 0) {
    udp.beginPacket(serverIP, serverPort);
    udp.write(buf, n);
    udp.endPacket();
    Serial.println("  Sent SELF_TEST packet to server");
  }

  Serial.println("=========================");
  Serial.flush();

  boardState = State::Active;
  Serial.println("State -> Active");
  Serial.flush();
}

// ---------------------------------------------------------------------------
// Packet sending
// ---------------------------------------------------------------------------

static void sendDataChunks() {
  if (dataChunks.size() < SENSOR_MAX_CHUNKS_BEFORE_SEND)
    return;

  uint8_t buf[ENCODER_PACKET_BUF_SIZE];
  size_t n = Diablo::create_sensor_data_packet(
      dataChunks, NUM_SENSORS, millis(), buf, sizeof(buf));
  if (n == 0) {
    dataChunks.clear();
    return;
  }

  udp.beginPacket(serverIP, serverPort);
  udp.write(buf, n);
  udp.endPacket();

  dataChunks.clear();
}

static Diablo::BoardState currentBoardState() {
  switch (boardState) {
    case State::Setup:    return Diablo::BoardState::SETUP;
    case State::SelfTest: return Diablo::BoardState::SELF_TEST;
    case State::Active:   return Diablo::BoardState::ACTIVE;
    default:              return Diablo::BoardState::SETUP;
  }
}

static void sendHeartbeat() {
  Diablo::BoardHeartbeatPacket hb;
  memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
  hb.board_id = (uint8_t)BOARD_ID;
  hb.engine_state = Diablo::EngineState::SAFE;
  hb.board_state = currentBoardState();

  uint8_t buf[ENCODER_PACKET_BUF_SIZE];
  size_t n = Diablo::create_board_heartbeat_packet(hb, millis(), buf, sizeof(buf));
  if (n == 0) return;

  udp.beginPacket(serverIP, serverPort);
  udp.write(buf, n);
  udp.endPacket();
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(2000);
  FirmwareHash::print();
  Serial.println("=== ProtoEncoder Hotfire ===");

  // I2C bus 1 — Encoder 1
  Wire.begin(ENC1_SDA, ENC1_SCL);
  Wire.setClock(100000);
  Serial.println("I2C bus 1 initialized (Encoder 1)");
  checkMagnetPresence(Wire, "ENC1");

  // I2C bus 2 — Encoder 2
  Wire1.begin(ENC2_SDA, ENC2_SCL);
  Wire1.setClock(100000);
  Serial.println("I2C bus 2 initialized (Encoder 2)");
  checkMagnetPresence(Wire1, "ENC2");

  // Ethernet
  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  staticIP = IPAddress(192, 168, 2, (uint8_t)BOARD_ID);
  SPI.begin(ETH_SCLK, ETH_MISO, ETH_MOSI, ETH_CS);
  delay(ETHERNET_SPI_DELAY_MS);
  Ethernet.init(ETH_CS);
  delay(ETHERNET_INIT_DELAY_MS);
  Ethernet.begin(mac, staticIP, dns_addr, gateway, subnet);
  delay(ETHERNET_BEGIN_DELAY_MS);

  udp.begin(UDP_LISTEN_PORT);
  Serial.print("UDP listening on port ");
  Serial.println(UDP_LISTEN_PORT);

  otaServer.begin();
  Serial.print("OTA TCP server listening on port ");
  Serial.println(HOTFIRE_OTA_PORT);

  Serial.print("Board ID: ");
  Serial.print((unsigned)BOARD_ID);
  Serial.print("  IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Server: ");
  Serial.print(serverIP);
  Serial.print(":");
  Serial.println(serverPort);
  Serial.println("State -> Setup");
  Serial.println("(Waiting for SENSOR_CONFIG packet to begin self-test)");
  Serial.flush();
}

void loop() {
  // OTA check
  EthernetClient otaClient = otaServer.available();
  if (otaClient) hotfire_handleOTA(otaClient);

  switch (boardState) {
    case State::Setup: {
      int packetSize = udp.parsePacket();
      if (packetSize > 0) {
        uint8_t typeByte;
        udp.read(&typeByte, 1);
        udp.flush();
        if (typeByte == static_cast<uint8_t>(Diablo::PacketType::SENSOR_CONFIG)) {
          Serial.println("SENSOR_CONFIG received -> State -> SelfTest");
          Serial.flush();
          boardState = State::SelfTest;
        }
      }
      break;
    }

    case State::SelfTest:
      runSelfTest();
      break;

    case State::Active: {
      uint16_t raw1 = readRawAngle(Wire);
      uint16_t raw2 = readRawAngle(Wire1);

      uint32_t val1 = (raw1 != READ_ERROR) ? static_cast<uint32_t>(raw1) : 0u;
      uint32_t val2 = (raw2 != READ_ERROR) ? static_cast<uint32_t>(raw2) : 0u;

      Diablo::SensorDataChunkCollection chunk(millis(), NUM_SENSORS);
      chunk.add_datapoint(SENSOR_ID_ENC1, val1);
      chunk.add_datapoint(SENSOR_ID_ENC2, val2);

      if (dataChunks.size() < SENSOR_MAX_CHUNKS_BEFORE_SEND)
        dataChunks.push_back(chunk);

      sendDataChunks();
      break;
    }
  }

  // Heartbeat in all states
  unsigned long now = millis();
  if (now - lastHeartbeatMs >= BOARD_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = now;
    sendHeartbeat();
  }

  delay(LOOP_DELAY_MS);
}
