/**
 * Actuator Controller (actuator_c) state machine — ESP32 PCB
 *
 * Coordinates abort sequences. Uses DAQv2-Comms over Ethernet/UDP.
 * Reference: Stream_ADC_Data for ethernet/heartbeat sending,
 *            Actuator_Testing for sensor data collection and sending.
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
EthernetUDP udp;

//-----------------------------------------------------------------------------
// State machine
//-----------------------------------------------------------------------------
enum class ActuatorControllerState {
  WaitingForServer,
  Active,
  StandardAbort,
  NoConnectionAbort,
  AbortFinished,
  ConnectionLossDetected
};

static ActuatorControllerState state = ActuatorControllerState::WaitingForServer;
static unsigned long last_server_heartbeat_ms = 0;
static unsigned long state_enter_ms = 0;

// Stored config from server (placeholder until full ACTUATOR_CONFIG parse exists)
struct StoredConfig {
  bool valid;
  uint8_t raw[64];
  size_t raw_len;
};
static StoredConfig stored_config = { false, {0}, 0 };

// Sensor data (like Actuator_Testing): current sense pins
const uint8_t NUM_SENSORS = NUM_ACTUATORS;
static unsigned long last_adc_read_ms = 0;

// Actuator output state (0 = OFF, 1 = ON), like Actuator_Testing
static uint8_t actuator_states[NUM_ACTUATORS];

// Heartbeat at fixed interval (actuator_config.h: BOARD_HEARTBEAT_INTERVAL_MS)
static unsigned long lastHeartbeatMillis = 0;

//-----------------------------------------------------------------------------
// Status LED: non-blocking blink count = state number (timing in actuator_config.h)
//-----------------------------------------------------------------------------
enum class LedPhase { Idle, On, Off };
static LedPhase led_phase = LedPhase::Idle;
static unsigned long led_cycle_start_ms = 0;
static uint8_t led_blink_index = 0;
static unsigned long led_phase_start_ms = 0;
static ActuatorControllerState last_led_state = ActuatorControllerState::WaitingForServer;

static uint8_t getStateNumber(ActuatorControllerState s) {
  switch (s) {
    case ActuatorControllerState::WaitingForServer:     return 1;
    case ActuatorControllerState::Active:                return 2;
    case ActuatorControllerState::StandardAbort:         return 3;
    case ActuatorControllerState::NoConnectionAbort:     return 4;
    case ActuatorControllerState::AbortFinished:         return 5;
    case ActuatorControllerState::ConnectionLossDetected: return 6;
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
          led_cycle_start_ms = now;  // 5 s pause before next burst
        }
        led_phase_start_ms = now;
      }
      break;
  }
}

//-----------------------------------------------------------------------------
// Helpers: map our state to Diablo::BoardState for heartbeats
//-----------------------------------------------------------------------------
static Diablo::BoardState getBoardStateForHeartbeat() {
  switch (state) {
    case ActuatorControllerState::WaitingForServer:
      return Diablo::BoardState::SETUP;
    case ActuatorControllerState::Active:
      return Diablo::BoardState::ACTIVE;
    case ActuatorControllerState::StandardAbort:
      return Diablo::BoardState::PT_ABORT;
    case ActuatorControllerState::NoConnectionAbort:
      return Diablo::BoardState::NO_CONNECTION_ABORT;
    case ActuatorControllerState::AbortFinished:
      return Diablo::BoardState::ABORT_FINISHED;
    case ActuatorControllerState::ConnectionLossDetected:
      return Diablo::BoardState::CONNECTION_LOSS_DETECTED;
    default:
      return Diablo::BoardState::SETUP;
  }
}

//-----------------------------------------------------------------------------
// Send board heartbeat to server (Board ID + boardState), like Stream_ADC_Data
//-----------------------------------------------------------------------------
static void sendBoardHeartbeat() {
  Diablo::BoardHeartbeatPacket hb;
  memset(hb.firmware_hash, 0, sizeof(hb.firmware_hash));
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
// Parse incoming UDP: read header and return packet type (or UNKNOWN)
//-----------------------------------------------------------------------------
static bool readPacketHeader(const uint8_t *buffer, size_t buffer_size, Diablo::PacketHeader &header_out) {
  if (buffer_size < sizeof(Diablo::PacketHeader)) return false;
  memcpy(&header_out, buffer, sizeof(Diablo::PacketHeader));
  return true;
}

//-----------------------------------------------------------------------------
// Process one incoming packet: update last heartbeat time and return what was received
//-----------------------------------------------------------------------------
enum class IncomingPacketKind {
  None,
  ServerHeartbeat,
  Config,
  Abort,
  AbortDone,
  ClearAbort
};

static IncomingPacketKind processIncomingPacket(const uint8_t *buffer, size_t len) {
  Diablo::PacketHeader hdr;
  if (!readPacketHeader(buffer, len, hdr)) return IncomingPacketKind::None;

  switch (hdr.packet_type) {
    case Diablo::PacketType::SERVER_HEARTBEAT: {
      Diablo::PacketHeader dummy;
      Diablo::ServerHeartbeatPacket data;
      if (Diablo::parse_server_heartbeat_packet(buffer, len, dummy, data)) {
        last_server_heartbeat_ms = millis();  // Only server heartbeat refreshes watchdog
        return IncomingPacketKind::ServerHeartbeat;
      }
      return IncomingPacketKind::None;
    }
    case Diablo::PacketType::ACTUATOR_CONFIG:
      // Store config data (TODO: full parse when layout is final)
      stored_config.valid = true;
      stored_config.raw_len = (len <= sizeof(stored_config.raw)) ? len : sizeof(stored_config.raw);
      memcpy(stored_config.raw, buffer, stored_config.raw_len);
      return IncomingPacketKind::Config;
    case Diablo::PacketType::ABORT:
      return IncomingPacketKind::Abort;
    case Diablo::PacketType::ABORT_DONE:
      return IncomingPacketKind::AbortDone;
    case Diablo::PacketType::CLEAR_ABORT:
      return IncomingPacketKind::ClearAbort;
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

//-----------------------------------------------------------------------------
// Actuator commands from server (Active and Standard Abort only), like Actuator_Testing
//-----------------------------------------------------------------------------
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
// Sensor data: read current sense pins and send one packet (like Actuator_Testing)
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

//-----------------------------------------------------------------------------
// Watchdog and sensor streaming helpers
//-----------------------------------------------------------------------------
static bool heartbeatTimedOut() {
  if (last_server_heartbeat_ms == 0) return false;  // No heartbeat received yet
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
// State handlers (each runs one tick, may transition)
//-----------------------------------------------------------------------------

// 1: Waiting for Server — heartbeat sent at fixed interval in loop; on config -> Active
static void run_WaitingForServer() {
  // Incoming packets processed in loop(); transition to Active happens when Config received
}

// 2: Active — stream sensor data, watchdog -> Connection Loss; heartbeat at fixed interval
static void run_Active() {
  streamSensorDataIfDue();
  if (heartbeatTimedOut()) {
    state = ActuatorControllerState::ConnectionLossDetected;
    state_enter_ms = millis();
  }
}

// 3: Standard Abort — Abort Done packet -> Abort Finished; watchdog -> No Connection Abort; heartbeat at fixed interval
static void run_StandardAbort() {
  if (heartbeatTimedOut()) {
    state = ActuatorControllerState::NoConnectionAbort;
    state_enter_ms = millis();
  }
}

// 4: No Connection Abort — complete abort sequence (TODO); after timeout -> Abort Finished; heartbeat at fixed interval
static void run_NoConnectionAbort() {
  if ((millis() - state_enter_ms) >= NO_CONNECTION_ABORT_DONE_MS) {
    state = ActuatorControllerState::AbortFinished;
    state_enter_ms = millis();
  }
}

// 5: Abort Finished — Clear Abort packet -> Active; heartbeat at fixed interval
static void run_AbortFinished() {
  // ClearAbort transition applied in loop()
}

// 6: Connection Loss Detected — if server heartbeat received (in loop) -> Active; else after grace time -> No Connection Abort
static void run_ConnectionLossDetected() {
  if ((millis() - state_enter_ms) >= CONNECTION_LOSS_GRACE_MS) {
    state = ActuatorControllerState::NoConnectionAbort;
    state_enter_ms = millis();
  }
}

//-----------------------------------------------------------------------------
// Apply transitions that depend on received packet (called from loop after processIncomingPacket)
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
    case ActuatorControllerState::NoConnectionAbort:
      // No packet-driven transitions; 10s timer handles -> Abort Finished
      break;
  }
}

//-----------------------------------------------------------------------------
// Pin setup and default states (like Actuator_Testing)
//-----------------------------------------------------------------------------
static void initializeActuators() {
  Serial.println("Initializing actuators...");
  for (int i = 1; i <= NUM_ACTUATORS; i++) {
    int pin = getActuatorPin(i);
    if (pin < 0) {
      Serial.print("Warning: Invalid actuator ID ");
      Serial.println(i);
      continue;
    }
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    actuator_states[i - 1] = 0;
    Serial.print("Actuator ");
    Serial.print(i);
    Serial.print(" (GPIO ");
    Serial.print(pin);
    Serial.println(") set to OFF");
  }
  Serial.println("All actuators initialized to OFF state");
}

static void initializeCurrentSensePins() {
  Serial.println("Initializing current sense pins...");
  for (uint8_t i = 0; i < NUM_SENSORS; i++) {
    int pin = getCurrentSensePin(i);
    if (pin >= 0) {
      pinMode(pin, INPUT);
      Serial.print("Current sense sensor ");
      Serial.print(i);
      Serial.print(" (GPIO ");
      Serial.print(pin);
      Serial.println(") initialized");
    }
  }
}

//-----------------------------------------------------------------------------
// Setup and loop
//-----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.println("Actuator Controller (actuator_c) starting...");

  bool spiffs_ok = false;
  // Mount read-only: do not format on fail, so we never overwrite burned value
  if (SPIFFS.begin(false)) {
    File f = SPIFFS.open(SPIFFS_BOARD_VALUE_PATH, "r");
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

  initializeActuators();
  initializeCurrentSensePins();

  pinMode(Actuator_Board.LED, OUTPUT);
  digitalWrite(Actuator_Board.LED, LOW);
  last_led_state = state;
  led_cycle_start_ms = millis();

  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  Serial.print("Generated unique MAC address: ");
  for (int i = 0; i < 6; i++) {
    if (i > 0) Serial.print(":");
    if (mac[i] < 0x10) Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();

  Serial.println("Initializing Ethernet...");
  SPI.begin(Actuator_Board.ETH_SCLK, Actuator_Board.ETH_MISO, Actuator_Board.ETH_MOSI, Actuator_Board.ETH_CS);
  delay(ETHERNET_SPI_DELAY_MS);
  Ethernet.init(Actuator_Board.ETH_CS);
  delay(ETHERNET_INIT_DELAY_MS);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(ETHERNET_BEGIN_DELAY_MS);
  udp.begin(udpListenPort);

  Serial.print("Ethernet initialized. IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Link Status: ");
  if (Ethernet.linkStatus() == LinkON) {
    Serial.println("Connected");
  } else if (Ethernet.linkStatus() == LinkOFF) {
    Serial.println("Disconnected");
  } else {
    Serial.println("Unknown");
  }
  Serial.print("Listening for actuator commands on UDP port: ");
  Serial.println(udpListenPort);

  state = ActuatorControllerState::WaitingForServer;
  state_enter_ms = millis();
  last_server_heartbeat_ms = 0;

  Serial.println("Setup complete. State: WaitingForServer");
}

void loop() {
  updateLedNonBlocking();

  // 1) Read all pending UDP packets and update heartbeat time / apply transitions
  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    uint8_t packetBuffer[MAX_PACKET_SIZE];
    int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
    if (bytesRead > 0) {
      IncomingPacketKind kind = processIncomingPacket(packetBuffer, bytesRead);
      applyPacketTransition(kind);
    }
  }

  // 2) Run current state
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
    case ActuatorControllerState::AbortFinished:
      run_AbortFinished();
      break;
    case ActuatorControllerState::ConnectionLossDetected:
      run_ConnectionLossDetected();
      break;
  }

  // Send board heartbeat at fixed interval (e.g. once per second)
  unsigned long now = millis();
  if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMillis = now;
    sendBoardHeartbeat();
  }

  delay(LOOP_DELAY_MS);
}
