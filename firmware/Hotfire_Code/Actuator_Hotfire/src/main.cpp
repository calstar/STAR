/**
 * Actuator Hotfire — single firmware for all actuator boards (controller and
 * designated survivor).
 *
 * State machine: WaitingForServer -> Active <-> ConnectionLossDetected ->
 * NoConnectionAbort -> PTAbort/NoPTAbort -> AbortFinished. Behavior gated by
 * is_abort_controller from ACTUATOR_CONFIG. Uses DAQv2-Comms over Ethernet/UDP.
 *
 * Every decision lives in common/ActuatorLogic.h (host-tested); this file
 * owns the pins, PWM and UDP and carries out what the controller asks.
 * Implements plan: Single Actuator Hotfire Script
 * (Hotfire_Code/Actuator_Hotfire).
 *
 * Networking mirrors the sense-board core (SensorHotfireCore.h): with
 * -DSENSOR_ETH_USE_DHCP the ground station assigns this board's address from
 * its MAC -> IP reservation table, and the board broadcasts BOARD_HEARTBEAT
 * until a server is heard, learning the server's address from its packets.
 * See common/board_net.h.
 */

#include "main.h"

#include <Arduino.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <STAR_EthernetOTA.h>
#include <daq-protocol.h>
#include <esp_mac.h>

#include <cstring>
#include <vector>

#include "ActuatorLogic.h"
#include "actuator_board_pins.h"
#include "actuator_config.h"
#include "board_net.h"
#include "firmware_hash.h"

using namespace actuator_board_pins;

//-----------------------------------------------------------------------------
// Board identity and network
//-----------------------------------------------------------------------------
static uint8_t board_id = BOARD_ID;
byte mac[6];
IPAddress staticIP(192, 168, 2, BOARD_ID);
IPAddress gateway(0, 0, 0, 0);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
IPAddress serverIP(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
const int udpListenPort = 5005;
const int serverPort = HOTFIRE_SERVER_PORT;
const int ptBoardPort = 5005;
EthernetUDP udp;
static StarOTA::Server otaServer(HOTFIRE_OTA_PORT);

// Address + server-discovery state. The scheme lives in common/board_net.h,
// shared with SensorHotfireCore.h so the actuator and the sense boards behave
// identically and cannot drift apart.
static BoardNet::State net;

//-----------------------------------------------------------------------------
// Verbose serial gate from ACTUATOR_CONFIG (enable_serial_printing); default on
// until config says otherwise. Shared two-tier logging: HF_LOG* = always,
// HF_VERBOSE* = verbose-only (this flag).
//-----------------------------------------------------------------------------
#include "hotfire_log.h"
bool g_verbose = true;

/**
 * Freeze our address before a single byte reaches flash. Our address is a DHCP
 * lease, and a renewal landing mid-flash would move us and drop the transfer,
 * so this suspends renewals for the duration.
 */
static void otaFreezeAddress(void*, uint32_t) {
    BoardNet::beginOtaHold(net);
}

//-----------------------------------------------------------------------------
// Local outputs: pins, PWM, UDP. The controller decides; this carries it out.
//-----------------------------------------------------------------------------
const uint8_t NUM_SENSORS = NUM_ACTUATORS;
static unsigned long last_adc_read_ms = 0;
static uint8_t actuator_states[NUM_ACTUATORS];
static unsigned long lastHeartbeatMillis = 0;

// PWM state (for PWM_ACTUATOR_COMMAND)
struct PWMState {
    bool active;
    unsigned long start_time;
    uint32_t duration;
    float duty_cycle;
    uint32_t period_micros;
    uint32_t on_time_micros;
    unsigned long last_cycle_start_micros;
    bool current_pin_state;
};
static PWMState pwm_states[NUM_ACTUATORS];

static uint32_t ipToU32(const IPAddress& ip) {
    return static_cast<uint32_t>(ip[0]) << 24 |
           static_cast<uint32_t>(ip[1]) << 16 |
           static_cast<uint32_t>(ip[2]) << 8 | static_cast<uint32_t>(ip[3]);
}

static IPAddress uint32ToIPAddress(uint32_t ip) {
    return IPAddress((ip >> 24) & 0xFF, (ip >> 16) & 0xFF, (ip >> 8) & 0xFF,
                     ip & 0xFF);
}

static uint32_t getSelfIP() {
    // Use the live stack address, not staticIP: the board sits on whatever
    // the server leased it, and self-matching against ACTUATOR_CONFIG
    // locations must reflect where we actually are.
    return ipToU32(Ethernet.localIP());
}

class BoardOutputs : public ActuatorHotfire::Outputs {
public:
    void setActuator(uint8_t actuator_id, bool on) override {
        const uint8_t idx = actuator_id - 1;
        // A plain command, vent or abort always wins over a running PWM.
        pwm_states[idx].active = false;
        const int pin = getActuatorPin(actuator_id);
        if (pin < 0)
            return;
        const uint8_t new_state = on ? 1 : 0;
        HF_VERBOSE("Actuator ");
        HF_VERBOSE(static_cast<unsigned>(actuator_id));
        HF_VERBOSELN(on ? " -> ON" : " -> OFF");
        if (actuator_states[idx] != new_state) {
            digitalWrite(pin, on ? HIGH : LOW);
            actuator_states[idx] = new_state;
        }
    }

    void startPwm(const daq::PWMActuatorCommand& cmd) override {
        const int pin = getActuatorPin(cmd.actuator_id);
        if (pin < 0)
            return;
        HF_VERBOSE("PWM actuator ");
        HF_VERBOSE(static_cast<unsigned>(cmd.actuator_id));
        HF_VERBOSE(" duration_ms=");
        HF_VERBOSE(cmd.duration);
        HF_VERBOSE(" duty_cycle=");
        HF_VERBOSE(cmd.duty_cycle);
        HF_VERBOSE(" frequency=");
        HF_VERBOSELN(cmd.frequency);
        const uint8_t i = cmd.actuator_id - 1;
        const uint32_t period_us =
            (cmd.frequency > 0) ? (1000000 / cmd.frequency) : 0;
        const uint32_t on_time_us =
            (uint32_t)(cmd.duty_cycle * (float)period_us);

        pwm_states[i].active = true;
        pwm_states[i].start_time = millis();
        pwm_states[i].duration = cmd.duration;
        pwm_states[i].duty_cycle = cmd.duty_cycle;
        pwm_states[i].period_micros = period_us;
        pwm_states[i].on_time_micros = on_time_us;
        pwm_states[i].last_cycle_start_micros = micros();

        const bool initial_state = (cmd.duty_cycle > 0.0f);
        pwm_states[i].current_pin_state = initial_state;
        digitalWrite(pin, initial_state ? HIGH : LOW);
        actuator_states[i] = initial_state ? 1 : 0;
    }

    void send(uint32_t ip, uint16_t port, const uint8_t* data,
              size_t len) override {
        const IPAddress dest = uint32ToIPAddress(ip);
        udp.beginPacket(dest, port);
        udp.write(data, len);
        udp.endPacket();
        HF_VERBOSE("Sent: type ");
        HF_VERBOSE(static_cast<unsigned>(data[0]));
        HF_VERBOSE(" to ");
        HF_VERBOSE(dest);
        HF_VERBOSE(":");
        HF_VERBOSELN(port);
    }

    void onStateChange(ActuatorHotfire::State,
                       ActuatorHotfire::State to) override {
        Serial.print("State -> ");
        Serial.println(ActuatorHotfire::stateName(to));
        Serial.flush();
    }

    void onCommandsIgnored(uint8_t packet_type,
                           ActuatorHotfire::State in_state) override {
        HF_VERBOSE("Ignored packet type ");
        HF_VERBOSE(static_cast<unsigned>(packet_type));
        HF_VERBOSE(" in state ");
        HF_VERBOSELN(ActuatorHotfire::stateName(in_state));
    }
};

static BoardOutputs g_outputs;
static ActuatorHotfire::Controller g_ctl(g_outputs, NUM_ACTUATORS);

//-----------------------------------------------------------------------------
// Status LED: blinks the state number
//-----------------------------------------------------------------------------
enum class LedPhase { Idle, On, Off };
static LedPhase led_phase = LedPhase::Idle;
static unsigned long led_cycle_start_ms = 0;
static uint8_t led_blink_index = 0;
static unsigned long led_phase_start_ms = 0;
static ActuatorHotfire::State last_led_state =
    ActuatorHotfire::State::WaitingForServer;

static void updateLedNonBlocking() {
    const unsigned long now = millis();
    const uint8_t nblinks = static_cast<uint8_t>(g_ctl.state());
    const int pin = Actuator_Board.LED;

    if (g_ctl.state() != last_led_state) {
        last_led_state = g_ctl.state();
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
// Heartbeat
//-----------------------------------------------------------------------------
static void sendBoardHeartbeatTo(IPAddress dest_ip, int dest_port) {
    daq::BoardHeartbeatPacket hb;
    memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
    hb.board_id = board_id;
    hb.engine_state = daq::EngineState::SAFE;
    hb.board_state = g_ctl.boardState();

    uint8_t packetBuffer[MAX_PACKET_SIZE];
    size_t len = daq::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                    sizeof(packetBuffer));
    if (len == 0)
        return;

    HF_VERBOSE("Sent: heartbeat to ");
    HF_VERBOSE(dest_ip);
    HF_VERBOSE(":");
    HF_VERBOSELN(dest_port);
    Serial.flush();
    udp.beginPacket(dest_ip, dest_port);
    udp.write(packetBuffer, len);
    udp.endPacket();
}

static void sendBoardHeartbeat() {
    sendBoardHeartbeatTo(serverIP, serverPort);
}

static void updatePWM() {
    unsigned long now_ms = millis();
    unsigned long now_us = micros();
    for (int i = 0; i < NUM_ACTUATORS; i++) {
        if (!pwm_states[i].active)
            continue;
        int pin = getActuatorPin(i + 1);
        if (pin < 0)
            continue;

        if (now_ms - pwm_states[i].start_time >= pwm_states[i].duration) {
            digitalWrite(pin, LOW);
            pwm_states[i].active = false;
            actuator_states[i] = 0;
            continue;
        }

        if (pwm_states[i].period_micros > 0) {
            unsigned long elapsed_in_cycle =
                now_us - pwm_states[i].last_cycle_start_micros;

            if (elapsed_in_cycle >= pwm_states[i].period_micros) {
                pwm_states[i].last_cycle_start_micros +=
                    (elapsed_in_cycle / pwm_states[i].period_micros) *
                    pwm_states[i].period_micros;
                elapsed_in_cycle =
                    now_us - pwm_states[i].last_cycle_start_micros;
            }

            if (elapsed_in_cycle >= pwm_states[i].on_time_micros) {
                if (pwm_states[i].current_pin_state &&
                    pwm_states[i].duty_cycle < 1.0f) {
                    digitalWrite(pin, LOW);
                    pwm_states[i].current_pin_state = false;
                }
            } else {
                if (!pwm_states[i].current_pin_state &&
                    pwm_states[i].duty_cycle > 0.0f) {
                    digitalWrite(pin, HIGH);
                    pwm_states[i].current_pin_state = true;
                }
            }
        }
    }
}

//-----------------------------------------------------------------------------
// Current-sense: 1-based (match Actuator_Testing), send to server only
//-----------------------------------------------------------------------------
static void readCurrentSensePinsAndSend() {
    daq::SensorDataChunkCollection chunk(millis(), NUM_SENSORS);
    for (uint8_t actuator_id = 1; actuator_id <= NUM_SENSORS; actuator_id++) {
        int pin = getCurrentSensePin(actuator_id);
        if (pin < 0)
            continue;
        int adcValue = analogRead(pin);
        float voltage = (static_cast<float>(adcValue) / 4095.0f) * 3.3f;
        uint32_t voltage_bits;
        memcpy(&voltage_bits, &voltage, sizeof(float));
        chunk.add_datapoint(actuator_id, voltage_bits);
    }
    if (chunk.empty())
        return;

    uint8_t packetBuffer[MAX_PACKET_SIZE];
    std::vector<daq::SensorDataChunkCollection> chunks;
    chunks.push_back(chunk);
    size_t packetSize = daq::create_sensor_data_packet(
        chunks, NUM_SENSORS, millis(), packetBuffer, sizeof(packetBuffer));
    if (packetSize == 0)
        return;

    udp.beginPacket(serverIP, serverPort);
    udp.write(packetBuffer, packetSize);
    udp.endPacket();
    HF_VERBOSE("Sent: sensor_data to ");
    HF_VERBOSE(serverIP);
    HF_VERBOSE(":");
    HF_VERBOSELN(serverPort);
}

static void streamSensorDataIfDue() {
    unsigned long now = millis();
    if (now - last_adc_read_ms >= ADC_READ_INTERVAL_MS) {
        last_adc_read_ms = now;
        readCurrentSensePinsAndSend();
    }
}

//-----------------------------------------------------------------------------
// Pin setup
//-----------------------------------------------------------------------------
static void initializeActuators() {
    HF_VERBOSELN("Initializing actuators...");
    for (int i = 1; i <= NUM_ACTUATORS; i++) {
        int pin = getActuatorPin(i);
        if (pin < 0)
            continue;
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        actuator_states[i - 1] = 0;
    }
    HF_VERBOSELN("All actuators initialized to OFF state");
}

static void initializeCurrentSensePins() {
    for (uint8_t actuator_id = 1; actuator_id <= NUM_SENSORS; actuator_id++) {
        int pin = getCurrentSensePin(actuator_id);
        if (pin >= 0)
            pinMode(pin, INPUT);
    }
}

static void initializePWMStates() {
    for (int i = 0; i < NUM_ACTUATORS; i++) {
        pwm_states[i].active = false;
        pwm_states[i].start_time = 0;
        pwm_states[i].duration = 0;
        pwm_states[i].duty_cycle = 0.0f;
        pwm_states[i].period_micros = 0;
        pwm_states[i].on_time_micros = 0;
        pwm_states[i].last_cycle_start_micros = 0;
        pwm_states[i].current_pin_state = false;
    }
}

//-----------------------------------------------------------------------------
// Log streaming: flush the buffer to the server as a LOGS packet (type 15).
// Board identified server-side by UDP source IP.
//-----------------------------------------------------------------------------
static void flushLogs() {
    static uint8_t pkt[sizeof(daq::PacketHeader) + 3 + LOG_BUF_SIZE];
    size_t n = 0;
    {
        HfLogLock lock;
        if (g_logbuf.empty())
            return;
        n = daq::create_log_packet(g_logbuf.flags(), g_logbuf.data(),
                                   g_logbuf.length(), millis(), pkt,
                                   sizeof(pkt));
        g_logbuf.clear();
    }
    if (n > 0) {
        udp.beginPacket(serverIP, serverPort);
        udp.write(pkt, n);
        udp.endPacket();
    }
}

//-----------------------------------------------------------------------------
// Setup and loop
//-----------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    delay(SERIAL_MONITOR_READY_DELAY_MS);
    FirmwareHash::print();
    Serial.println("Actuator Hotfire state machine starting...");

    board_id = (uint8_t)BOARD_ID;
    staticIP = IPAddress(192, 168, 2, (uint8_t)BOARD_ID);
    Serial.print("Board ID and IP: ");
    Serial.print(static_cast<unsigned>(board_id));
    Serial.print(" / 192.168.2.");
    Serial.println(static_cast<unsigned>(board_id));

    initializeActuators();
    initializeCurrentSensePins();
    initializePWMStates();

    pinMode(Actuator_Board.LED, OUTPUT);
    digitalWrite(Actuator_Board.LED, LOW);
    last_led_state = g_ctl.state();
    led_cycle_start_ms = millis();

    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
    BoardNet::configure(net, mac, staticIP, subnet);
    BoardNet::printMac(net);
    SPI.begin(Actuator_Board.ETH_SCLK, Actuator_Board.ETH_MISO,
              Actuator_Board.ETH_MOSI, Actuator_Board.ETH_CS);
    delay(ETHERNET_SPI_DELAY_MS);
    Ethernet.init(Actuator_Board.ETH_CS);
    delay(ETHERNET_INIT_DELAY_MS);
#ifdef SENSOR_ETH_USE_DHCP
    // The ground station decides our address; we only ask for one.
    BoardNet::begin(net, dns, gateway);
#else
    Ethernet.begin(mac, staticIP, dns, gateway, subnet);
#endif
    delay(ETHERNET_BEGIN_DELAY_MS);

    // W5500 / Ethernet status (same prints as the sense boards so the shared
    // test-GUI serial parser understands both)
    Serial.println("[ETH] Ethernet initialized (SPI WIZnet)");
    Serial.print("Address source: ");
    Serial.println(BoardNet::sourceName(net.source));
    Serial.print("Stack IP (Ethernet.localIP): ");
    Serial.println(Ethernet.localIP());
    Serial.print("Hardware: ");
    switch (Ethernet.hardwareStatus()) {
        case EthernetNoHardware:
            Serial.println("no chip detected — check CS / SPI wiring");
            break;
        case EthernetW5100:
            Serial.println("W5100");
            break;
        case EthernetW5200:
            Serial.println("W5200");
            break;
        case EthernetW5500:
            Serial.println("W5500");
            break;
        default:
            Serial.println("unknown");
            break;
    }
    Serial.print("Link status: ");
    if (Ethernet.linkStatus() == LinkON) {
        Serial.println("Connected");
    } else if (Ethernet.linkStatus() == LinkOFF) {
        Serial.println("Disconnected");
    } else {
        Serial.println("Unknown");
    }
    if (Ethernet.localIP() == IPAddress(0, 0, 0, 0)) {
        Serial.println(
            "[ETH] WARNING: stack IP is 0.0.0.0 — check cable / W5500");
    }
    Serial.flush();

    udp.begin(udpListenPort);
    otaServer.onStart(otaFreezeAddress);
    otaServer.begin();
    Serial.print("UDP listening on port ");
    Serial.println(udpListenPort);

    g_ctl.begin(millis());
    Serial.println("State -> WaitingForServer");
    Serial.flush();
#ifdef SENSOR_ETH_USE_DHCP
    Serial.println(
        "[NET] address assigned by the server; broadcasting until one is "
        "heard");
#endif

    Serial.println("Setup complete. State: WaitingForServer");

    // Ethernet is up — first log the server can receive. Announce identity + IP
    // and flush immediately so the server sees the board come online.
    HF_LOG("ONLINE board=");
    HF_LOG(static_cast<unsigned>(board_id));
    HF_LOG(" ip=");
    HF_LOG(Ethernet.localIP());
    HF_LOGLN_();
    flushLogs();
}

void loop() {
#ifdef SENSOR_ETH_USE_DHCP
    // Renew the lease as it expires; no-op while an OTA is in flight.
    BoardNet::maintainLease(net);
#endif
    // Non-blocking OTA check — blocks only if a client actually connects,
    // and never returns on success (the board reboots into the new image).
    otaServer.poll();
    // Bench marker: prints only on builds made with -DSTAR_OTA_TEST_MESSAGE,
    // so consecutive OTA uploads are visibly different on the serial monitor.
    StarOTA::printTestMessage();

    updateLedNonBlocking();
    updatePWM();

    int packetSize = udp.parsePacket();
    if (packetSize > 0) {
        IPAddress remoteIP = udp.remoteIP();
        uint8_t packetBuffer[MAX_PACKET_SIZE];
        int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
        if (bytesRead > 0) {
            HF_VERBOSE("Received packet from ");
            HF_VERBOSE(remoteIP);
            HF_VERBOSE(":");
            HF_VERBOSE(udp.remotePort());
            HF_VERBOSE(" type ");
            HF_VERBOSELN(static_cast<unsigned>(packetBuffer[0]));
            const ActuatorHotfire::PacketResult r =
                g_ctl.onPacket(packetBuffer, bytesRead, ipToU32(remoteIP),
                               ipToU32(serverIP), getSelfIP(), millis());
            if (r.has_log_mode) {
                // The mode byte (0..3): bit0 = USB verbose, upper part =
                // server log stream level. See hotfire_log.h.
                g_verbose = (r.log_mode & 1);
                g_log_stream_level = (r.log_mode >= 2) ? (r.log_mode - 1) : 0;
            }
#ifdef SENSOR_ETH_USE_DHCP
            if (r.kind == ActuatorHotfire::PacketKind::ServerHeartbeat ||
                r.kind == ActuatorHotfire::PacketKind::Config)
                BoardNet::onServerPacket(net, remoteIP, serverIP);
#endif
        }
    }

#ifdef SENSOR_ETH_USE_DHCP
    // Server gone quiet: forget it and resume discovery broadcasts so a new
    // (or restarted) server can find us. The address stays locked -- only the
    // outbound destination resets.
    if (BoardNet::serverWentSilent(net)) {
        net.serverLearned = false;
        serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
        Serial.println("[NET] server silent -- resuming discovery");
        Serial.flush();
    }
#endif

    g_ctl.tick(millis(), getSelfIP(), ipToU32(serverIP));
    if (g_ctl.state() == ActuatorHotfire::State::Active)
        streamSensorDataIfDue();

    unsigned long now = millis();
    if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMillis = now;
        if (g_ctl.state() == ActuatorHotfire::State::WaitingForServer) {
            HF_VERBOSELN("Setup state: sending heartbeat");
            Serial.flush();
        }
        sendBoardHeartbeat();
#ifdef SENSOR_ETH_USE_DHCP
        // Discovery: announce to everyone on the wire until a server is
        // learned. Reuses the normal heartbeat packet on the same 1 s tick.
        if (!net.serverLearned)
            sendBoardHeartbeatTo(IPAddress(255, 255, 255, 255),
                                 HOTFIRE_SERVER_PORT);
#endif
    }

    // Flush buffered logs to the server ~1 Hz (or sooner if the buffer is
    // filling).
    static unsigned long s_last_log_flush_ms = 0;
    if (!g_logbuf.empty() &&
        (g_logbuf.nearFull() || now - s_last_log_flush_ms >= 1000)) {
        s_last_log_flush_ms = now;
        flushLogs();
    }

    delay(LOOP_DELAY_MS);
}
