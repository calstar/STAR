/**
 * Actuator Hotfire (controller) state machine — ESP32 PCB
 *
 * Implements the controller actuator board: coordinates abort sequences,
 * sends NO_CONNECTION_ABORT to PTs, runs PT Abort / No PT Abort / StandaloneAbort.
 * Uses DAQv2-Comms over Ethernet/UDP.
 * Based on Avionics_State_Machine_Drafts/actuator_c.cpp.
 */

#include <Arduino.h>
#include <SPI.h>
#include <SPIFFS.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <esp_mac.h>
#include <vector>
#include "actuator_board_pins.h"
#include "actuator_config.h"
#include "firmware_hash.h"

using namespace actuator_board_pins;

//-----------------------------------------------------------------------------
// Board identity and network (IP 192.168.2.XXX and board_id = XXX from SPIFFS)
//-----------------------------------------------------------------------------
static uint8_t board_id = BOARD_ID_DEFAULT;
byte mac[6];
IPAddress staticIP(192, 168, 2, BOARD_ID_DEFAULT);
IPAddress gateway(0, 0, 0, 0);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
IPAddress serverIP(192, 168, 2, 20);
const int udpListenPort = 5005;
const int serverPort = 5006;
const int ptBoardPort = 5005;  // PT boards listen on 5005
EthernetUDP udp;

//-----------------------------------------------------------------------------
// State machine
//-----------------------------------------------------------------------------
enum class ActuatorControllerState {
  WaitingForServer,
  Active,
  StandardAbort,
  NoConnectionAbort,
  PTAbort,
  NoPTAbort,
  AbortFinished,
  ConnectionLossDetected,
  StandaloneAbort
};

static ActuatorControllerState state = ActuatorControllerState::WaitingForServer;
static unsigned long last_server_heartbeat_ms = 0;
static unsigned long state_enter_ms = 0;

// Parsed actuator config from server
static bool is_abort_controller = false;
static std::vector<Diablo::AbortActuatorLocation> abort_actuator_locations;
static std::vector<Diablo::AbortPTLocation> abort_pt_locations;
static bool config_valid = false;

// For ConnectionLossDetected -> StandaloneAbort: last time we got sensor data from a config PT
static unsigned long last_pt_data_from_config_ms = 0;

// For NoConnectionAbort: did we receive PT data during the wait?
static bool pt_data_received_during_no_conn_abort_wait = false;
// Send NO_CONNECTION_ABORT to PTs only once per NoConnectionAbort entry
static bool no_conn_abort_pt_sent = false;

// Sensor data (current sense pins)
const uint8_t NUM_SENSORS = NUM_ACTUATORS;
static unsigned long last_adc_read_ms = 0;
static uint8_t actuator_states[NUM_ACTUATORS];
static unsigned long lastHeartbeatMillis = 0;

//-----------------------------------------------------------------------------
// Status LED: non-blocking blink count = state number
//-----------------------------------------------------------------------------
enum class LedPhase { Idle, On, Off };
static LedPhase led_phase = LedPhase::Idle;
static unsigned long led_cycle_start_ms = 0;
static uint8_t led_blink_index = 0;
static unsigned long led_phase_start_ms = 0;
static ActuatorControllerState last_led_state = ActuatorControllerState::WaitingForServer;

static uint8_t getStateNumber(ActuatorControllerState s) {
  switch (s) {
    case ActuatorControllerState::WaitingForServer:   return 1;
    case ActuatorControllerState::Active:             return 2;
    case ActuatorControllerState::StandardAbort:      return 3;
    case ActuatorControllerState::NoConnectionAbort:  return 4;
    case ActuatorControllerState::PTAbort:            return 5;
    case ActuatorControllerState::NoPTAbort:         return 6;
    case ActuatorControllerState::AbortFinished:     return 7;
    case ActuatorControllerState::ConnectionLossDetected: return 8;
    case ActuatorControllerState::StandaloneAbort:   return 9;
    default: return 1;
  }
}

static void updateLedNonBlocking() {
  const unsigned long now = millis();
  const uint8_t nblinks = getStateNumber(state);
  const int pin = Actuator_Board.LED;

  if (state != last_led_state) {
    last_led_state = state;
    led_phase = LedPhase::Idle;
    led_cycle_start_ms = now;
  }

  switch (led_phase) {
    case LedPhase::Idle:
      digitalWrite(pin, LOW);
      if ((now - led_cycle_start_ms) >= LED_CYCLE_MS) {
        led_cycle_start_ms = now;
        led_blink_index = 0;
        digitalWrite(pin, HIGH);
        led_phase = LedPhase::On;
        led_phase_start_ms = now;
      }
      break;
    case LedPhase::On:
      if ((now - led_phase_start_ms) >= LED_BLINK_ON_MS) {
        digitalWrite(pin, LOW);
        led_phase = LedPhase::Off;
        led_phase_start_ms = now;
      }
      break;
    case LedPhase::Off:
      if ((now - led_phase_start_ms) >= LED_BLINK_OFF_MS) {
        led_blink_index++;
        if (led_blink_index < nblinks) {
          digitalWrite(pin, HIGH);
          led_phase = LedPhase::On;
        } else {
          led_phase = LedPhase::Idle;
          led_cycle_start_ms = now;
        }
        led_phase_start_ms = now;
      }
      break;
  }
}

//-----------------------------------------------------------------------------
// Helpers: map state to Diablo::BoardState for heartbeats
//-----------------------------------------------------------------------------
static Diablo::BoardState getBoardStateForHeartbeat() {
  switch (state) {
    case ActuatorControllerState::WaitingForServer:
      return Diablo::BoardState::SETUP;
    case ActuatorControllerState::Active:
      return Diablo::BoardState::ACTIVE;
    case ActuatorControllerState::ConnectionLossDetected:
      return Diablo::BoardState::CONNECTION_LOSS_DETECTED;
    case ActuatorControllerState::NoConnectionAbort:
      return Diablo::BoardState::NO_CONNECTION_ABORT;
    case ActuatorControllerState::PTAbort:
      return Diablo::BoardState::PT_ABORT;
    case ActuatorControllerState::NoPTAbort:
      return Diablo::BoardState::NO_PT_ABORT;
    case ActuatorControllerState::AbortFinished:
      return Diablo::BoardState::ABORT_FINISHED;
    case ActuatorControllerState::StandardAbort:
      return Diablo::BoardState::PT_ABORT;
    case ActuatorControllerState::StandaloneAbort:
      return Diablo::BoardState::STANDALONE_ABORT;
    default:
      return Diablo::BoardState::SETUP;
  }
}

static void sendBoardHeartbeat() {
  Diablo::BoardHeartbeatPacket hb;
  memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
  hb.board_id = board_id;
  hb.engine_state = Diablo::EngineState::SAFE;
  hb.board_state = getBoardStateForHeartbeat();

  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t len = Diablo::create_board_heartbeat_packet(hb, millis(), packetBuffer, sizeof(packetBuffer));
  if (len == 0) return;

  udp.beginPacket(serverIP, serverPort);
  udp.write(packetBuffer, len);
  udp.endPacket();
}

//-----------------------------------------------------------------------------
// Helpers: IP in config PT list?
//-----------------------------------------------------------------------------
static bool isIPInPTLocations(uint32_t ip) {
  for (const auto &loc : abort_pt_locations) {
    if (loc.ip_address == ip) return true;
  }
  return false;
}

static IPAddress uint32ToIPAddress(uint32_t ip) {
  return IPAddress(
    (ip >> 24) & 0xFF,
    (ip >> 16) & 0xFF,
    (ip >> 8) & 0xFF,
    ip & 0xFF
  );
}

//-----------------------------------------------------------------------------
// Parse incoming UDP
//-----------------------------------------------------------------------------
static bool readPacketHeader(const uint8_t *buffer, size_t buffer_size, Diablo::PacketHeader &header_out) {
  if (buffer_size < sizeof(Diablo::PacketHeader)) return false;
  memcpy(&header_out, buffer, sizeof(Diablo::PacketHeader));
  return true;
}

enum class IncomingPacketKind {
  None,
  ServerHeartbeat,
  Config,
  Abort,
  AbortDone,
  ClearAbort,
  SensorData
};

static void processActuatorCommands(const std::vector<Diablo::ActuatorCommand> &commands);

static IncomingPacketKind processIncomingPacket(const uint8_t *buffer, size_t len, IPAddress remoteIP) {
  Diablo::PacketHeader hdr;
  if (!readPacketHeader(buffer, len, hdr)) return IncomingPacketKind::None;

  switch (hdr.packet_type) {
    case Diablo::PacketType::SERVER_HEARTBEAT: {
      Diablo::PacketHeader dummy;
      Diablo::ServerHeartbeatPacket data;
      if (Diablo::parse_server_heartbeat_packet(buffer, len, dummy, data)) {
        last_server_heartbeat_ms = millis();
        return IncomingPacketKind::ServerHeartbeat;
      }
      return IncomingPacketKind::None;
    }
    case Diablo::PacketType::ACTUATOR_CONFIG: {
      Diablo::PacketHeader dummy;
      uint8_t is_controller = 0;
      std::vector<Diablo::AbortActuatorLocation> act_locs;
      std::vector<Diablo::AbortPTLocation> pt_locs;
      uint8_t enable_serial_printing = 0;
      if (Diablo::parse_actuator_config_packet(buffer, len, dummy, is_controller, act_locs, pt_locs,
                                                enable_serial_printing)) {
        (void)enable_serial_printing;
        is_abort_controller = (is_controller != 0);
        abort_actuator_locations = act_locs;
        abort_pt_locations = pt_locs;
        config_valid = true;
        return IncomingPacketKind::Config;
      }
      return IncomingPacketKind::None;
    }
    case Diablo::PacketType::ABORT:
      return IncomingPacketKind::Abort;
    case Diablo::PacketType::ABORT_DONE:
      return IncomingPacketKind::AbortDone;
    case Diablo::PacketType::CLEAR_ABORT:
      return IncomingPacketKind::ClearAbort;
    case Diablo::PacketType::SENSOR_DATA:
      if (state == ActuatorControllerState::NoConnectionAbort) {
        pt_data_received_during_no_conn_abort_wait = true;
      }
      if (config_valid && !abort_pt_locations.empty()) {
        uint32_t rip = static_cast<uint32_t>(remoteIP);
        if (isIPInPTLocations(rip)) {
          last_pt_data_from_config_ms = millis();
        }
      }
      return IncomingPacketKind::SensorData;
    case Diablo::PacketType::ACTUATOR_COMMAND: {
      Diablo::PacketHeader cmd_header;
      std::vector<Diablo::ActuatorCommand> commands;
      if (Diablo::parse_actuator_command_packet(buffer, len, cmd_header, commands) &&
          (state == ActuatorControllerState::Active || state == ActuatorControllerState::StandardAbort)) {
        processActuatorCommands(commands);
      }
      return IncomingPacketKind::None;
    }
    default:
      return IncomingPacketKind::None;
  }
}

static void processActuatorCommands(const std::vector<Diablo::ActuatorCommand> &commands) {
  for (const auto &cmd : commands) {
    if (cmd.actuator_id < 1 || cmd.actuator_id > NUM_ACTUATORS) continue;
    int pin = getActuatorPin(cmd.actuator_id);
    if (pin < 0) continue;
    uint8_t new_state = (cmd.actuator_state != 0) ? 1 : 0;
    uint8_t idx = cmd.actuator_id - 1;
    if (actuator_states[idx] != new_state) {
      digitalWrite(pin, new_state ? HIGH : LOW);
      actuator_states[idx] = new_state;
    }
  }
}

//-----------------------------------------------------------------------------
// Sensor data: read current sense pins and send (like Actuator_Testing)
//-----------------------------------------------------------------------------
static void readCurrentSensePinsAndSend() {
  Diablo::SensorDataChunkCollection chunk(millis(), NUM_SENSORS);
  for (uint8_t i = 0; i < NUM_SENSORS; i++) {
    int pin = getCurrentSensePin(i);
    if (pin < 0) continue;
    int adcValue = analogRead(pin);
    float voltage = (static_cast<float>(adcValue) / 4095.0f) * 3.3f;
    uint32_t voltage_bits;
    memcpy(&voltage_bits, &voltage, sizeof(float));
    chunk.add_datapoint(i, voltage_bits);
  }
  if (chunk.empty()) return;

  uint8_t packetBuffer[MAX_PACKET_SIZE];
  std::vector<Diablo::SensorDataChunkCollection> chunks;
  chunks.push_back(chunk);
  size_t packetSize = Diablo::create_sensor_data_packet(chunks, NUM_SENSORS, millis(), packetBuffer, sizeof(packetBuffer));
  if (packetSize == 0) return;

  udp.beginPacket(serverIP, serverPort);
  udp.write(packetBuffer, packetSize);
  udp.endPacket();
}

static bool heartbeatTimedOut() {
  if (last_server_heartbeat_ms == 0) return false;
  return (millis() - last_server_heartbeat_ms) > HEARTBEAT_TIMEOUT_MS;
}

static void streamSensorDataIfDue() {
  unsigned long now = millis();
  if (now - last_adc_read_ms >= ADC_READ_INTERVAL_MS) {
    last_adc_read_ms = now;
    readCurrentSensePinsAndSend();
  }
}

//-----------------------------------------------------------------------------
// NO_CONNECTION_ABORT: header-only (not in DAQv2-Comms serializers)
//-----------------------------------------------------------------------------
static size_t create_no_connection_abort_packet(uint8_t *buffer, size_t buffer_size) {
  if (buffer_size < sizeof(Diablo::PacketHeader)) return 0;
  Diablo::PacketHeader header;
  header.packet_type = Diablo::PacketType::NO_CONNECTION_ABORT;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = millis();
  memcpy(buffer, &header, sizeof(header));
  return sizeof(header);
}

//-----------------------------------------------------------------------------
// Send NO_CONNECTION_ABORT to each PT in config
//-----------------------------------------------------------------------------
static void sendNoConnectionAbortToAllPTs() {
  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t len = create_no_connection_abort_packet(packetBuffer, sizeof(packetBuffer));
  if (len == 0) return;

  for (const auto &loc : abort_pt_locations) {
    IPAddress ptIP = uint32ToIPAddress(loc.ip_address);
    udp.beginPacket(ptIP, ptBoardPort);
    udp.write(packetBuffer, len);
    udp.endPacket();
  }
}

//-----------------------------------------------------------------------------
// State handlers
//-----------------------------------------------------------------------------
static void run_WaitingForServer() {
  (void)0;
}

static void run_Active() {
  streamSensorDataIfDue();
  if (heartbeatTimedOut()) {
    state = ActuatorControllerState::ConnectionLossDetected;
    state_enter_ms = millis();
  }
}

static void run_StandardAbort() {
  if (heartbeatTimedOut()) {
    state = ActuatorControllerState::NoConnectionAbort;
    state_enter_ms = millis();
    pt_data_received_during_no_conn_abort_wait = false;
  }
}

static void run_NoConnectionAbort() {
  if (!no_conn_abort_pt_sent && is_abort_controller && config_valid) {
    sendNoConnectionAbortToAllPTs();
    no_conn_abort_pt_sent = true;
  }

  unsigned long elapsed = millis() - state_enter_ms;
  if (elapsed >= NO_CONN_ABORT_PT_WAIT_MS) {
    no_conn_abort_pt_sent = false;  // reset for next time we enter NoConnectionAbort
    if (pt_data_received_during_no_conn_abort_wait) {
      state = ActuatorControllerState::PTAbort;
    } else {
      state = ActuatorControllerState::NoPTAbort;
    }
    state_enter_ms = millis();
  }
}

static void run_PTAbort() {
  // TODO: Run procedure involving receiving PT data and actuating solenoids.
  // When procedure finishes, transition to AbortFinished.
  if ((millis() - state_enter_ms) >= NO_CONNECTION_ABORT_DONE_MS) {
    state = ActuatorControllerState::AbortFinished;
    state_enter_ms = millis();
  }
}

static void run_NoPTAbort() {
  // TODO: Run slightly different procedure involving receiving PT data and actuating solenoids.
  // When procedure finishes, transition to AbortFinished.
  if ((millis() - state_enter_ms) >= NO_CONNECTION_ABORT_DONE_MS) {
    state = ActuatorControllerState::AbortFinished;
    state_enter_ms = millis();
  }
}

static void run_AbortFinished() {
  (void)0;
}

static void run_ConnectionLossDetected() {
  if ((millis() - state_enter_ms) >= CONNECTION_LOSS_GRACE_MS) {
    state = ActuatorControllerState::NoConnectionAbort;
    state_enter_ms = millis();
    pt_data_received_during_no_conn_abort_wait = false;
    return;
  }
  // If connection to one or more necessary-for-abort boards is lost -> StandaloneAbort
  if (is_abort_controller && config_valid && !abort_pt_locations.empty()) {
    if ((millis() - last_pt_data_from_config_ms) > STANDALONE_ABORT_PT_LOSS_MS) {
      state = ActuatorControllerState::StandaloneAbort;
      state_enter_ms = millis();
    }
  }
}

static void run_StandaloneAbort() {
  // TODO: Standalone abort procedure. When done -> AbortFinished.
  if ((millis() - state_enter_ms) >= NO_CONNECTION_ABORT_DONE_MS) {
    state = ActuatorControllerState::AbortFinished;
    state_enter_ms = millis();
  }
}

//-----------------------------------------------------------------------------
// Packet-driven transitions
//-----------------------------------------------------------------------------
static void applyPacketTransition(IncomingPacketKind kind) {
  switch (state) {
    case ActuatorControllerState::WaitingForServer:
      if (kind == IncomingPacketKind::Config) {
        state = ActuatorControllerState::Active;
        state_enter_ms = millis();
      }
      break;
    case ActuatorControllerState::Active:
      if (kind == IncomingPacketKind::Abort) {
        state = ActuatorControllerState::StandardAbort;
        state_enter_ms = millis();
      }
      break;
    case ActuatorControllerState::StandardAbort:
      if (kind == IncomingPacketKind::AbortDone) {
        state = ActuatorControllerState::AbortFinished;
        state_enter_ms = millis();
      }
      break;
    case ActuatorControllerState::AbortFinished:
      if (kind == IncomingPacketKind::ClearAbort) {
        state = ActuatorControllerState::Active;
        state_enter_ms = millis();
      }
      break;
    case ActuatorControllerState::ConnectionLossDetected:
      if (kind == IncomingPacketKind::ServerHeartbeat) {
        state = ActuatorControllerState::Active;
        state_enter_ms = millis();
      }
      break;
    default:
      break;
  }
}

//-----------------------------------------------------------------------------
// Pin setup
//-----------------------------------------------------------------------------
static void initializeActuators() {
  Serial.println("Initializing actuators...");
  for (int i = 1; i <= NUM_ACTUATORS; i++) {
    int pin = getActuatorPin(i);
    if (pin < 0) continue;
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    actuator_states[i - 1] = 0;
  }
  Serial.println("All actuators initialized to OFF state");
}

static void initializeCurrentSensePins() {
  for (uint8_t i = 0; i < NUM_SENSORS; i++) {
    int pin = getCurrentSensePin(i);
    if (pin >= 0) pinMode(pin, INPUT);
  }
}

//-----------------------------------------------------------------------------
// Setup and loop
//-----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.println("Actuator Hotfire (controller) starting...");

  if (SPIFFS.begin(false)) {
    File f = SPIFFS.open(SPIFFS_BOARD_VALUE_PATH, "r");
    if (f && f.available() >= 1) {
      uint8_t b;
      if (f.read(&b, 1) == 1) {
        board_id = b;
        staticIP = IPAddress(192, 168, 2, b);
        Serial.print("Board ID and IP from SPIFFS: ");
        Serial.print(static_cast<unsigned>(board_id));
        Serial.print(" / 192.168.2.");
        Serial.println(static_cast<unsigned>(b));
      }
    }
    if (f) f.close();
    SPIFFS.end();
  }

  initializeActuators();
  initializeCurrentSensePins();

  pinMode(Actuator_Board.LED, OUTPUT);
  digitalWrite(Actuator_Board.LED, LOW);
  last_led_state = state;
  led_cycle_start_ms = millis();

  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  SPI.begin(Actuator_Board.ETH_SCLK, Actuator_Board.ETH_MISO, Actuator_Board.ETH_MOSI, Actuator_Board.ETH_CS);
  delay(ETHERNET_SPI_DELAY_MS);
  Ethernet.init(Actuator_Board.ETH_CS);
  delay(ETHERNET_INIT_DELAY_MS);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(ETHERNET_BEGIN_DELAY_MS);
  udp.begin(udpListenPort);

  Serial.print("Ethernet initialized. IP: ");
  Serial.println(Ethernet.localIP());

  state = ActuatorControllerState::WaitingForServer;
  state_enter_ms = millis();
  last_server_heartbeat_ms = 0;

  Serial.println("Setup complete. State: WaitingForServer");
}

void loop() {
  updateLedNonBlocking();

  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    IPAddress remoteIP = udp.remoteIP();
    uint8_t packetBuffer[MAX_PACKET_SIZE];
    int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
    if (bytesRead > 0) {
      IncomingPacketKind kind = processIncomingPacket(packetBuffer, bytesRead, remoteIP);
      applyPacketTransition(kind);
    }
  }

  switch (state) {
    case ActuatorControllerState::WaitingForServer:
      run_WaitingForServer();
      break;
    case ActuatorControllerState::Active:
      run_Active();
      break;
    case ActuatorControllerState::StandardAbort:
      run_StandardAbort();
      break;
    case ActuatorControllerState::NoConnectionAbort:
      run_NoConnectionAbort();
      break;
    case ActuatorControllerState::PTAbort:
      run_PTAbort();
      break;
    case ActuatorControllerState::NoPTAbort:
      run_NoPTAbort();
      break;
    case ActuatorControllerState::AbortFinished:
      run_AbortFinished();
      break;
    case ActuatorControllerState::ConnectionLossDetected:
      run_ConnectionLossDetected();
      break;
    case ActuatorControllerState::StandaloneAbort:
      run_StandaloneAbort();
      break;
  }

  unsigned long now = millis();
  if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMillis = now;
    sendBoardHeartbeat();
  }

  delay(LOOP_DELAY_MS);
}
