/**
 * TC (Thermocouple) Hotfire state machine — ESP32 PCB
 *
 * Same state machine as PT Hotfire: Waiting for Server → Active → Standalone Abort (and back to Active on clear).
 * Sends heartbeats, streams thermocouple/sensor data to server or to actuator controller in abort.
 * Uses TC_Board pin layout and BoardType::THERMOCOUPLE.
 */

#include <Arduino.h>
#include <SPI.h>
#include <SPIFFS.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <vector>
#include <esp_mac.h>

#include "main.h"
#define PINS_ACTIVE_LAYOUT sense_board_pins::TC_Board
#include "STAR_ADS126X.h"
#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"

using namespace sense_board_pins;

//-----------------------------------------------------------------------------
// ADC config (Stream_ADC_Data / PT_BOARD_Multi style)
//-----------------------------------------------------------------------------
#define FILTER       ADS126X_SINC4
#define DATA_RATE    ADS126X_RATE_7200
#define TEST_PIN     1
#define NUM_PTS     10
#define READINGS_PER_MUX 5
#define MAX_CHUNKS   9   // 9 chunks fit in 512-byte packet with 10 sensors

static ADS126X ads126x;
SPIClass ADC_SPI(HSPI);
static uint8_t currentConnector = 1;

//-----------------------------------------------------------------------------
// Ethernet and network (IP 192.168.2.XXX and board_id = XXX from SPIFFS)
//-----------------------------------------------------------------------------
static uint8_t board_id = BOARD_ID_DEFAULT;
byte mac[6];
IPAddress staticIP(192, 168, 2, BOARD_ID_DEFAULT);
IPAddress gateway(0, 0, 0, 0);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
const int udpListenPort = 5005;
const int serverPortDefault = 5006;
EthernetUDP udp;

// Server address: updated when we receive a server heartbeat (store server address in server heartbeat)
IPAddress serverIP(192, 168, 2, 20);
int serverPort = serverPortDefault;

//-----------------------------------------------------------------------------
// State machine
//-----------------------------------------------------------------------------
enum class PTHotfireState {
  WaitingForServer,
  Active,
  StandaloneAbort
};

static PTHotfireState state = PTHotfireState::WaitingForServer;

// Stored config from SENSOR_CONFIG packet (necessary_for_abort, actuator controller IP)
struct StoredSensorConfig {
  bool valid;
  bool necessary_for_abort;
  uint32_t actuator_controller_ip;  // IPv4 as uint32_t (e.g. network order)
};
static StoredSensorConfig stored_config = { false, false, 0 };

// Sensor data collection (Stream_ADC_Data style)
std::vector<Diablo::SensorDataChunkCollection> dataChunks;
uint8_t sensorId = 0;

// Heartbeat at fixed interval (main.h: BOARD_HEARTBEAT_INTERVAL_MS)
static unsigned long lastHeartbeatMillis = 0;

//-----------------------------------------------------------------------------
// Incoming packet kinds (for transitions)
//-----------------------------------------------------------------------------
enum class IncomingPacketKind {
  None,
  ServerHeartbeat,
  SensorConfig,
  ClearAbort,
  NoConnAbort
};

//-----------------------------------------------------------------------------
// Helpers: ADC and voltage
//-----------------------------------------------------------------------------
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

//-----------------------------------------------------------------------------
// Read packet header (for type dispatch)
//-----------------------------------------------------------------------------
static bool readPacketHeader(const uint8_t *buffer, size_t len, Diablo::PacketHeader &hdr_out) {
  if (len < sizeof(Diablo::PacketHeader)) return false;
  memcpy(&hdr_out, buffer, sizeof(Diablo::PacketHeader));
  return true;
}

//-----------------------------------------------------------------------------
// Process one incoming packet; return kind and optionally store server address
// remote_ip/remote_port: set when we receive SERVER_HEARTBEAT (store server address)
//-----------------------------------------------------------------------------
static IncomingPacketKind processIncomingPacket(const uint8_t *buffer, size_t len,
                                                IPAddress remote_ip, int remote_port) {
  Diablo::PacketHeader hdr;
  if (!readPacketHeader(buffer, len, hdr)) return IncomingPacketKind::None;

  switch (hdr.packet_type) {
    case Diablo::PacketType::SERVER_HEARTBEAT: {
      Diablo::PacketHeader dummy;
      Diablo::ServerHeartbeatPacket data;
      if (Diablo::parse_server_heartbeat_packet(buffer, len, dummy, data)) {
        serverIP = remote_ip;
        serverPort = remote_port;
        return IncomingPacketKind::ServerHeartbeat;
      }
      return IncomingPacketKind::None;
    }
    case Diablo::PacketType::SENSOR_CONFIG:
      // Store config: layout per generate_packets (necessary_for_abort byte, then optional controller_ip)
      stored_config.valid = true;
      if (len >= 6 + 1) {
        stored_config.necessary_for_abort = (buffer[6] != 0);
        if (stored_config.necessary_for_abort && len >= 6 + 5) {
          stored_config.actuator_controller_ip = (static_cast<uint32_t>(buffer[7]) << 24) |
            (static_cast<uint32_t>(buffer[8]) << 16) |
            (static_cast<uint32_t>(buffer[9]) << 8) |
            static_cast<uint32_t>(buffer[10]);
        } else {
          stored_config.actuator_controller_ip = 0;
        }
      }
      return IncomingPacketKind::SensorConfig;
    case Diablo::PacketType::CLEAR_ABORT:
      return IncomingPacketKind::ClearAbort;
    case Diablo::PacketType::NO_CONNECTION_ABORT: {
      if (len >= sizeof(Diablo::PacketHeader))
        return IncomingPacketKind::NoConnAbort;
      return IncomingPacketKind::None;
    }
    default:
      return IncomingPacketKind::None;
  }
}

//-----------------------------------------------------------------------------
// Send board heartbeat (board ID + boardState), like actuator_c / Stream_ADC_Data
//-----------------------------------------------------------------------------
static void sendBoardHeartbeat(Diablo::BoardState board_state, IPAddress dest_ip, int dest_port) {
  Diablo::BoardHeartbeatPacket hb;
  memset(hb.firmware_hash, 0, sizeof(hb.firmware_hash));
  hb.board_id = board_id;
  hb.engine_state = Diablo::EngineState::SAFE;
  hb.board_state = board_state;

  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t n = Diablo::create_board_heartbeat_packet(hb, millis(), packetBuffer, sizeof(packetBuffer));
  if (n == 0) return;
  udp.beginPacket(dest_ip, dest_port);
  udp.write(packetBuffer, n);
  udp.endPacket();
}

//-----------------------------------------------------------------------------
// Stream sensor data to a destination (Stream_ADC_Data style)
//-----------------------------------------------------------------------------
static void sendSensorDataPacketTo(IPAddress dest_ip, int dest_port) {
  if (dataChunks.empty()) return;
  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t packetSize = Diablo::create_sensor_data_packet(
    dataChunks, static_cast<uint8_t>(NUM_PTS), millis(), packetBuffer, sizeof(packetBuffer));
  if (packetSize == 0) return;
  udp.beginPacket(dest_ip, dest_port);
  udp.write(packetBuffer, packetSize);
  udp.endPacket();
  dataChunks.clear();
}

//-----------------------------------------------------------------------------
// Read ADC data for current connector and push chunk (Stream_ADC_Data style)
//-----------------------------------------------------------------------------
static void read_data(int count) {
  Diablo::SensorDataChunkCollection chunk(millis(), NUM_PTS);
  for (int i = 0; i < count; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW)
      delayMicroseconds(10);
    const auto reading = ads126x.readADC1();
    if (!reading.checksumValid) continue;
    chunk.add_datapoint(sensorId, static_cast<uint32_t>(reading.value));
  }
  if (!chunk.empty())
    dataChunks.push_back(chunk);
}

//-----------------------------------------------------------------------------
// State handlers
//-----------------------------------------------------------------------------

// 1: Waiting for Server — heartbeat sent at fixed interval in loop; on config -> Active
static void run_WaitingForServer() {
  // No per-state work; heartbeat sent in loop
}

// 2: Active — stream sensor packets to server; heartbeat at fixed interval
static void run_Active() {
  if (dataChunks.size() >= MAX_CHUNKS)
    sendSensorDataPacketTo(serverIP, serverPort);
}

// 3: Standalone Abort — stream sensor data to actuator controller; heartbeat at fixed interval
static void run_StandaloneAbort() {
  if (!stored_config.valid || stored_config.actuator_controller_ip == 0)
    return;
  IPAddress actuatorIP(
    (stored_config.actuator_controller_ip >> 24) & 0xFF,
    (stored_config.actuator_controller_ip >> 16) & 0xFF,
    (stored_config.actuator_controller_ip >> 8) & 0xFF,
    stored_config.actuator_controller_ip & 0xFF);
  if (dataChunks.size() >= MAX_CHUNKS)
    sendSensorDataPacketTo(actuatorIP, serverPortDefault);
}

//-----------------------------------------------------------------------------
// Apply packet-driven transitions
//-----------------------------------------------------------------------------
static void applyPacketTransition(IncomingPacketKind kind) {
  switch (state) {
    case PTHotfireState::WaitingForServer:
      if (kind == IncomingPacketKind::SensorConfig) {
        state = PTHotfireState::Active;
      }
      break;
    case PTHotfireState::Active:
      if (kind == IncomingPacketKind::NoConnAbort && stored_config.necessary_for_abort)
        state = PTHotfireState::StandaloneAbort;
      break;
    case PTHotfireState::StandaloneAbort:
      if (kind == IncomingPacketKind::ClearAbort) {
        state = PTHotfireState::Active;
      }
      break;
  }
}

//-----------------------------------------------------------------------------
// Setup
//-----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.println("TC Hotfire state machine starting...");

  bool spiffs_ok = false;
  // Mount read-only: do not format on fail, so we never overwrite burned value
  if (SPIFFS.begin(false)) {
    File f = SPIFFS.open(SPIFFS_BOARD_VALUE_PATH, "r");  // path from main.h
    if (f && f.available() >= 1) {
      uint8_t b;
      if (f.read(&b, 1) == 1) {
        board_id = b;
        staticIP = IPAddress(192, 168, 2, b);
        spiffs_ok = true;
        Serial.print("Board ID and IP from SPIFFS: ");
        Serial.print(static_cast<unsigned>(board_id));
        Serial.print(" / 192.168.2.");
        Serial.println(static_cast<unsigned>(b));
      }
    }
    if (f) f.close();
    SPIFFS.end();
  }
  if (!spiffs_ok)
    Serial.println("SPIFFS read skipped or failed, using default board ID 1 / 192.168.2.1");

  ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);
  ADC_SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);
  ads126x.stopADC1();
  ads126x.setInputMux(static_cast<uint8_t>(getAdcChannel(1, TEST_PIN)), ADS126X_AINCOM);
  ads126x.bypassPGA();
  ads126x.setFilter(FILTER);
  ads126x.setRate(DATA_RATE);
  ads126x.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);
  ads126x.startADC1();

  sensorId = currentConnector;

  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI);
  delay(ETHERNET_SPI_DELAY_MS);
  Ethernet.init(Pins.ETH_CS);
  delay(ETHERNET_INIT_DELAY_MS);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(ETHERNET_BEGIN_DELAY_MS);
  udp.begin(udpListenPort);

  state = PTHotfireState::WaitingForServer;
  Serial.print("Ethernet IP: ");
  Serial.println(Ethernet.localIP());
  Serial.println("Setup complete. State: WaitingForServer (TC Board)");
}

//-----------------------------------------------------------------------------
// Loop
//-----------------------------------------------------------------------------
void loop() {
  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    IPAddress remoteIP = udp.remoteIP();
    int remotePort = udp.remotePort();
    uint8_t packetBuffer[MAX_PACKET_SIZE];
    int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
    if (bytesRead > 0) {
      IncomingPacketKind kind = processIncomingPacket(
        packetBuffer, bytesRead, remoteIP, remotePort);
      applyPacketTransition(kind);
    }
  }

  read_data(READINGS_PER_MUX);
  currentConnector++;
  if (currentConnector > NUM_PTS) currentConnector = 1;
  sensorId = currentConnector;
  int ch = getAdcChannel(currentConnector, TEST_PIN);
  if (ch >= 0)
    ads126x.setInputMux(static_cast<uint8_t>(ch), ADS126X_AINCOM);
  flush_cycles(settlePulses(FILTER, DATA_RATE));

  switch (state) {
    case PTHotfireState::WaitingForServer:
      run_WaitingForServer();
      break;
    case PTHotfireState::Active:
      run_Active();
      break;
    case PTHotfireState::StandaloneAbort:
      run_StandaloneAbort();
      break;
  }

  // Send board heartbeat at fixed interval (e.g. once per second)
  unsigned long now = millis();
  if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMillis = now;
    switch (state) {
      case PTHotfireState::WaitingForServer:
        sendBoardHeartbeat(Diablo::BoardState::SETUP, serverIP, serverPort);
        break;
      case PTHotfireState::Active:
        sendBoardHeartbeat(Diablo::BoardState::ACTIVE, serverIP, serverPort);
        break;
      case PTHotfireState::StandaloneAbort:
        if (!stored_config.valid || stored_config.actuator_controller_ip == 0)
          sendBoardHeartbeat(Diablo::BoardState::STANDALONE_ABORT, serverIP, serverPort);
        else {
          IPAddress actuatorIP(
            (stored_config.actuator_controller_ip >> 24) & 0xFF,
            (stored_config.actuator_controller_ip >> 16) & 0xFF,
            (stored_config.actuator_controller_ip >> 8) & 0xFF,
            stored_config.actuator_controller_ip & 0xFF);
          sendBoardHeartbeat(Diablo::BoardState::STANDALONE_ABORT, actuatorIP, serverPortDefault);
        }
        break;
    }
  }

  delay(LOOP_DELAY_MS);
}
