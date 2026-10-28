/**
 * Ball Valve Hotfire — motorized ball valve prototype board.
 *
 * Each valve has an enable line and a position readback:
 *
 *   enable    A pull-up holds the 4-20 mA driver's input at 5 V; an NMOS on
 *             the enable pin pulls it to 0 V. ACTUATOR_COMMAND state 1 leaves
 *             the NMOS off (pin LOW, 5 V to the driver: 20 mA, valve open);
 *             state 0 turns it on (pin HIGH, line pulled low: valve closed).
 *   position  The valve's 4-20 mA position signal across a 100 ohm shunt
 *             (0.4-2.0 V) on an ADC1 pin, streamed to the server as
 *             SENSOR_DATA: raw 12-bit ADC counts, which is what daq_bridge
 *             and calibration_service read for an ACTUATOR board
 *             (V = counts / 4095 * 3.3; mA = V * 1000 / 100).
 *
 * State machine: WaitingForServer -> Active while SERVER_HEARTBEATs are
 * current, back to WaitingForServer with every valve in SAFE_STATE (1, open)
 * when they stop for HEARTBEAT_TIMEOUT_MS, and when an OTA starts. A command
 * to SAFE_STATE is always obeyed; leaving it needs Active. Losing the ESP32's
 * 3.3 V fails the same way: the NMOS gate drops and 5 V reaches the driver.
 * Boot is 0 (closed), from the first instruction of setup(), as the gate
 * pull-up holds it before the firmware runs. Position is streamed in both
 * states.
 *
 * Prototype: pins are hardcoded below; one valve is fitted. A second is one
 * more row in `valves`. Networking, heartbeats, logs, firmware hash and
 * Ethernet OTA match the hotfire boards (Actuator_Hotfire, common/).
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

#include "actuator_config.h"
#include "board_net.h"
#include "firmware_hash.h"

//-----------------------------------------------------------------------------
// Pin definitions — prototype, ESP32-WROOM-32
//-----------------------------------------------------------------------------

// W5500 Ethernet on the default VSPI pins
static constexpr int ETH_CS = 5;
static constexpr int ETH_MOSI = 23;
static constexpr int ETH_SCLK = 18;
static constexpr int ETH_MISO = 19;

// Position readback samples averaged per reading; the ESP32 ADC is noisy
static constexpr int POSITION_SAMPLES = 16;

// Where every valve goes when the server is lost: 1 = 20 mA = open.
static constexpr uint8_t SAFE_STATE = 1;

struct Valve {
    uint8_t actuator_id;  // ACTUATOR_COMMAND id (1-based)
    uint8_t sensor_id;    // SENSOR_DATA id of its position readback
    int enable_pin;       // NMOS gate: LOW = state 1, HIGH = state 0
    int position_pin;     // ADC1 (GPIO32-39): 4-20 mA across a 100 ohm shunt
    uint8_t state;        // last state written to the pin
};

// GPIO25 has no boot strapping role, and a 10k pull-up to 3.3 V on the gate
// holds it at state 0 through boot and uploads.
static Valve valves[] = {
    {1, 1, 25, 32, 0},
};
static constexpr uint8_t NUM_VALVES = sizeof(valves) / sizeof(valves[0]);

//-----------------------------------------------------------------------------
// Board identity and network
//-----------------------------------------------------------------------------
static uint8_t board_id = BOARD_ID;
static byte mac[6];
static IPAddress staticIP(192, 168, 2, BOARD_ID);
static IPAddress gateway(0, 0, 0, 0);
static IPAddress subnet(255, 255, 255, 0);
static IPAddress dns(192, 168, 2, 1);
static IPAddress serverIP(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
static const int udpListenPort = 5005;
static const int serverPort = HOTFIRE_SERVER_PORT;
static EthernetUDP udp;
static StarOTA::Server otaServer(HOTFIRE_OTA_PORT);
static BoardNet::State net;
// False when no W5500 answered at boot. The Ethernet library then reads
// garbage socket state and network calls can stall, so they are all skipped
// and the valves stay at 0.
static bool eth_present = false;

#include "hotfire_log.h"
bool g_verbose = true;

//-----------------------------------------------------------------------------
// State machine
//-----------------------------------------------------------------------------
enum class BallValveState : uint8_t {
    WaitingForServer = 1,  // SETUP
    Active = 2
};

static BallValveState state = BallValveState::WaitingForServer;
static unsigned long last_server_heartbeat_ms = 0;
static unsigned long last_position_read_ms = 0;
static unsigned long lastHeartbeatMillis = 0;

static const char* stateName(BallValveState s) {
    switch (s) {
        case BallValveState::WaitingForServer:
            return "WaitingForServer";
        case BallValveState::Active:
            return "Active";
        default:
            return "?";
    }
}

static void setState(BallValveState new_state) {
    if (state != new_state) {
        HF_LOG("State -> ");
        HF_LOGLN(stateName(new_state));
        Serial.flush();
        state = new_state;
    }
}

//-----------------------------------------------------------------------------
// Valves
//-----------------------------------------------------------------------------
static Valve* findValve(uint8_t actuator_id) {
    for (auto& v : valves)
        if (v.actuator_id == actuator_id)
            return &v;
    return nullptr;
}

static void setValve(Valve& v, uint8_t new_state, const char* reason) {
    digitalWrite(v.enable_pin, new_state ? LOW : HIGH);
    if (v.state != new_state) {
        v.state = new_state;
        HF_LOG("[VALVE ");
        HF_LOG(static_cast<unsigned>(v.actuator_id));
        HF_LOG("] -> ");
        HF_LOG(static_cast<unsigned>(new_state));
        HF_LOG(" (");
        HF_LOG(reason);
        HF_LOGLN(")");
    }
}

static void setAllValvesSafe(const char* reason) {
    for (auto& v : valves)
        setValve(v, SAFE_STATE, reason);
}

static void processActuatorCommands(
    const std::vector<daq::ActuatorCommand>& commands) {
    for (const auto& cmd : commands) {
        Valve* v = findValve(cmd.actuator_id);
        if (v == nullptr)
            continue;
        uint8_t new_state = (cmd.actuator_state != 0) ? 1 : 0;
        if (new_state == SAFE_STATE || state == BallValveState::Active) {
            setValve(*v, new_state, "command");
        } else {
            HF_LOG("[VALVE ");
            HF_LOG(static_cast<unsigned>(v->actuator_id));
            HF_LOG("] ");
            HF_LOG(static_cast<unsigned>(new_state));
            HF_LOGLN(" ignored -- no current SERVER_HEARTBEAT");
        }
    }
}

/** Raw 12-bit ADC counts, averaged over POSITION_SAMPLES. */
static uint32_t readPositionCounts(const Valve& v) {
    uint32_t sum = 0;
    for (int i = 0; i < POSITION_SAMPLES; i++)
        sum += analogRead(v.position_pin);
    return (sum + POSITION_SAMPLES / 2) / POSITION_SAMPLES;
}

//-----------------------------------------------------------------------------
// Outgoing packets
//-----------------------------------------------------------------------------
static daq::BoardState getBoardStateForHeartbeat() {
    switch (state) {
        case BallValveState::Active:
            return daq::BoardState::ACTIVE;
        case BallValveState::WaitingForServer:
        default:
            return daq::BoardState::SETUP;
    }
}

static void sendBoardHeartbeatTo(IPAddress dest_ip, int dest_port) {
    daq::BoardHeartbeatPacket hb;
    memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
    hb.board_id = board_id;
    hb.engine_state = daq::EngineState::SAFE;
    hb.board_state = getBoardStateForHeartbeat();

    uint8_t packetBuffer[MAX_PACKET_SIZE];
    size_t len = daq::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                    sizeof(packetBuffer));
    if (len == 0)
        return;

    udp.beginPacket(dest_ip, dest_port);
    udp.write(packetBuffer, len);
    udp.endPacket();
    HF_VERBOSE("Sent: heartbeat to ");
    HF_VERBOSE(dest_ip);
    HF_VERBOSE(":");
    HF_VERBOSELN(dest_port);
}

static void sendPositions() {
    daq::SensorDataChunkCollection chunk(millis(), NUM_VALVES);
    for (const auto& v : valves)
        chunk.add_datapoint(v.sensor_id, readPositionCounts(v));

    uint8_t packetBuffer[MAX_PACKET_SIZE];
    std::vector<daq::SensorDataChunkCollection> chunks;
    chunks.push_back(chunk);
    size_t len = daq::create_sensor_data_packet(
        chunks, NUM_VALVES, millis(), packetBuffer, sizeof(packetBuffer));
    if (len == 0)
        return;

    udp.beginPacket(serverIP, serverPort);
    udp.write(packetBuffer, len);
    udp.endPacket();
    HF_VERBOSE("Sent: sensor_data to ");
    HF_VERBOSE(serverIP);
    HF_VERBOSE(":");
    HF_VERBOSELN(serverPort);
}

static void flushLogs() {
    if (g_logbuf.empty())
        return;
    static uint8_t pkt[sizeof(daq::PacketHeader) + 3 + LOG_BUF_SIZE];
    size_t n =
        daq::create_log_packet(g_logbuf.flags(), g_logbuf.data(),
                               g_logbuf.length(), millis(), pkt, sizeof(pkt));
    if (n > 0) {
        udp.beginPacket(serverIP, serverPort);
        udp.write(pkt, n);
        udp.endPacket();
    }
    g_logbuf.clear();
}

//-----------------------------------------------------------------------------
// Incoming packets
//-----------------------------------------------------------------------------
static void processIncomingPacket(const uint8_t* buffer, size_t len,
                                  IPAddress remoteIP) {
    if (len < sizeof(daq::PacketHeader))
        return;
    daq::PacketHeader hdr;
    memcpy(&hdr, buffer, sizeof(hdr));

    switch (hdr.packet_type) {
        case daq::PacketType::SERVER_HEARTBEAT: {
            daq::PacketHeader dummy;
            daq::ServerHeartbeatPacket data;
            if (daq::parse_server_heartbeat_packet(buffer, len, dummy, data)) {
                last_server_heartbeat_ms = millis();
#ifdef SENSOR_ETH_USE_DHCP
                BoardNet::onServerPacket(net, remoteIP, serverIP);
#endif
                setState(BallValveState::Active);
            }
            break;
        }
        case daq::PacketType::ACTUATOR_CONFIG: {
            // Only the logging mode is used; this board takes no part in the
            // abort sequence.
            daq::PacketHeader dummy;
            uint8_t is_controller = 0;
            uint8_t enable_serial = 0;
            std::vector<daq::AbortActuatorLocation> act_locs;
            std::vector<daq::AbortPTLocation> pt_locs;
            if (daq::parse_actuator_config_packet(buffer, len, dummy,
                                                  is_controller, act_locs,
                                                  pt_locs, enable_serial)) {
                g_verbose = (enable_serial & 1);
                g_log_stream_level =
                    (enable_serial >= 2) ? (enable_serial - 1) : 0;
            }
            break;
        }
        case daq::PacketType::ACTUATOR_COMMAND: {
            daq::PacketHeader dummy;
            std::vector<daq::ActuatorCommand> commands;
            if (daq::parse_actuator_command_packet(buffer, len, dummy,
                                                   commands))
                processActuatorCommands(commands);
            break;
        }
        default:
            break;
    }
}

//-----------------------------------------------------------------------------
// Setup and loop
//-----------------------------------------------------------------------------

/**
 * An OTA blocks the loop until the board reboots, so the heartbeat watchdog
 * cannot run: put every valve in SAFE_STATE first, then freeze our DHCP
 * address for the duration of the flash.
 */
static void otaStart(void*, uint32_t) {
    setAllValvesSafe("OTA starting");
    BoardNet::beginOtaHold(net);
}

/**
 * Read the W5500's VERSIONR (common register 0x0039, always 0x04) straight
 * over SPI and say what the answer implies, so a dead link can be traced to
 * a wire without a logic analyser.
 */
static void probeW5500Version() {
    SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
    digitalWrite(ETH_CS, LOW);
    SPI.transfer(0x00);  // address high
    SPI.transfer(0x39);  // address low: VERSIONR
    SPI.transfer(0x00);  // control: common block, read, variable length
    uint8_t version = SPI.transfer(0x00);
    digitalWrite(ETH_CS, HIGH);
    SPI.endTransaction();

    Serial.print("[ETH] W5500 VERSIONR read: 0x");
    if (version < 0x10)
        Serial.print("0");
    Serial.print(version, HEX);
    if (version == 0x04)
        Serial.println(" -- chip answers; init failed, try a reset");
    else if (version == 0x00)
        Serial.println(
            " -- MISO stuck low: check MISO (19), SCK (18), CS (5)"
            " and the module's GND");
    else if (version == 0xFF)
        Serial.println(
            " -- MISO floating/high: check MISO (19), CS (5) and"
            " the module's 3.3 V");
    else
        Serial.println(" -- garbled: check MOSI (23), SCK (18), loose jumpers");
}

static void initializeValves() {
    for (auto& v : valves) {
        // Write the level before switching to OUTPUT so the pin never
        // glitches LOW (= state 1) on the way.
        digitalWrite(v.enable_pin, HIGH);
        pinMode(v.enable_pin, OUTPUT);
        v.state = 0;
        pinMode(v.position_pin, INPUT);
        analogSetPinAttenuation(v.position_pin, ADC_11db);  // 0-3.3 V range
    }
}

void setup() {
    // First thing: every valve to 0 before anything that waits.
    initializeValves();

    Serial.begin(115200);
    delay(SERIAL_MONITOR_READY_DELAY_MS);
    FirmwareHash::print();
    Serial.println("Ball Valve Hotfire starting...");

    board_id = static_cast<uint8_t>(BOARD_ID);
    staticIP = IPAddress(192, 168, 2, board_id);
    Serial.print("Board ID and IP: ");
    Serial.print(static_cast<unsigned>(board_id));
    Serial.print(" / 192.168.2.");
    Serial.println(static_cast<unsigned>(board_id));

    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
    BoardNet::configure(net, mac, staticIP, subnet);
    BoardNet::printMac(net);
    SPI.begin(ETH_SCLK, ETH_MISO, ETH_MOSI, ETH_CS);
    delay(ETHERNET_SPI_DELAY_MS);
    Ethernet.init(ETH_CS);
    delay(ETHERNET_INIT_DELAY_MS);
#ifdef SENSOR_ETH_USE_DHCP
    // The ground station decides our address; we only ask for one.
    BoardNet::begin(net, dns, gateway);
#else
    Ethernet.begin(mac, staticIP, dns, gateway, subnet);
#endif
    delay(ETHERNET_BEGIN_DELAY_MS);

    // Same prints as the other hotfire boards so the shared test-GUI serial
    // parser understands this one too.
    eth_present = Ethernet.hardwareStatus() == EthernetW5500;
    Serial.println("[ETH] Ethernet initialized (SPI WIZnet)");
    Serial.print("Address source: ");
    Serial.println(BoardNet::sourceName(net.source));
    Serial.print("Stack IP (Ethernet.localIP): ");
    Serial.println(Ethernet.localIP());
    Serial.print("Hardware: ");
    Serial.println(eth_present ? "W5500"
                               : "no chip detected — check CS / SPI wiring. "
                                 "Ethernet disabled; valves held at 0.");
    if (!eth_present) {
        probeW5500Version();
    } else {
        Serial.print("Link status: ");
        Serial.println(Ethernet.linkStatus() == LinkON ? "Connected"
                                                       : "Disconnected");
        udp.begin(udpListenPort);
        otaServer.onStart(otaStart);
        otaServer.begin();
        Serial.print("UDP listening on port ");
        Serial.println(udpListenPort);
    }

    for (const auto& v : valves) {
        Serial.print("Valve: actuator_id ");
        Serial.print(static_cast<unsigned>(v.actuator_id));
        Serial.print(" (GPIO");
        Serial.print(v.enable_pin);
        Serial.print("), position sensor_id ");
        Serial.print(static_cast<unsigned>(v.sensor_id));
        Serial.print(" (GPIO");
        Serial.print(v.position_pin);
        Serial.println("), state 0");
    }
    Serial.println("State -> WaitingForServer");
    Serial.flush();

    HF_LOG("ONLINE board=");
    HF_LOG(static_cast<unsigned>(board_id));
    HF_LOG(" ip=");
    HF_LOG(Ethernet.localIP());
    HF_LOGLN_();
    if (eth_present)
        flushLogs();
}

static void pollNetwork() {
#ifdef SENSOR_ETH_USE_DHCP
    // Renew the lease as it expires; no-op while an OTA is in flight.
    BoardNet::maintainLease(net);
#endif
    // Blocks only if a client connects; never returns on success.
    otaServer.poll();
    StarOTA::printTestMessage();

    int packetSize = udp.parsePacket();
    if (packetSize > 0) {
        IPAddress remoteIP = udp.remoteIP();
        uint8_t packetBuffer[MAX_PACKET_SIZE];
        int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
        if (bytesRead > 0)
            processIncomingPacket(packetBuffer, static_cast<size_t>(bytesRead),
                                  remoteIP);
    }

#ifdef SENSOR_ETH_USE_DHCP
    // Server gone quiet: forget it and resume discovery broadcasts. Our
    // address stays; only the outbound destination resets.
    if (BoardNet::serverWentSilent(net)) {
        net.serverLearned = false;
        serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
        Serial.println("[NET] server silent -- resuming discovery");
        Serial.flush();
    }
#endif

    unsigned long now = millis();
    if (now - last_position_read_ms >= ADC_READ_INTERVAL_MS) {
        last_position_read_ms = now;
        sendPositions();
    }

    if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMillis = now;
        sendBoardHeartbeatTo(serverIP, serverPort);
#ifdef SENSOR_ETH_USE_DHCP
        // Discovery: announce to everyone until a server is learned.
        if (!net.serverLearned)
            sendBoardHeartbeatTo(IPAddress(255, 255, 255, 255),
                                 HOTFIRE_SERVER_PORT);
#endif
    }

    // Flush buffered logs to the server ~1 Hz (or sooner if filling).
    static unsigned long s_last_log_flush_ms = 0;
    if (!g_logbuf.empty() &&
        (g_logbuf.nearFull() || now - s_last_log_flush_ms >= 1000)) {
        s_last_log_flush_ms = now;
        flushLogs();
    }
}

void loop() {
    // Failsafe: no current server heartbeat -> every valve to SAFE_STATE.
    if (state == BallValveState::Active &&
        millis() - last_server_heartbeat_ms > HEARTBEAT_TIMEOUT_MS) {
        setAllValvesSafe("server heartbeat lost");
        setState(BallValveState::WaitingForServer);
    }

    if (eth_present)
        pollNetwork();

    delay(LOOP_DELAY_MS);
}
