/**
 * Shared sensor hotfire state machine core — PT / TC / LC boards
 *
 * Single implementation of: UDP rx, packet processing, 3-state machine,
 * state LED, board heartbeat, Ethernet init.
 * Board-specific: ADC init, collect_chunk(), send_chunks_to() via callbacks.
 *
 * Include after: Arduino.h, Ethernet, DAQv2-Comms, main.h, sense_board_pins.h
 * Define before include (or use defaults):
 *   SENSOR_HOTFIRE_MAX_PACKET_SIZE (default 512)
 *   SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE (default 11)
 */

#pragma once

#include <Arduino.h>
#include <DAQv2-Comms.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <esp_mac.h>

#include <cstring>

#include "firmware_hash.h"
#include "hotfire_ota.h"

#ifndef SENSOR_HOTFIRE_MAX_PACKET_SIZE
#define SENSOR_HOTFIRE_MAX_PACKET_SIZE 512
#endif
#ifndef SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE
#define SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE 11
#endif
#ifndef SENSOR_UDP_LISTEN_PORT
#define SENSOR_UDP_LISTEN_PORT 5005
#endif

// Serial output gated by this flag (define in one .cpp per project, e.g.
// main.cpp). Default is true until SENSOR_CONFIG is received; the packet's
// enable_serial_printing field then updates g_sensor_hotfire_serial for loop()
// / runtime SENSOR_HOTFIRE_PRINT*. setup() uses SENSOR_HOTFIRE_BOOT_* so boot
// diagnostics always appear on Serial.
extern bool g_sensor_hotfire_serial;
#define SENSOR_HOTFIRE_PRINT(x)      \
    do {                             \
        if (g_sensor_hotfire_serial) \
            Serial.print(x);         \
    } while (0)
#define SENSOR_HOTFIRE_PRINTLN(x)    \
    do {                             \
        if (g_sensor_hotfire_serial) \
            Serial.println(x);       \
    } while (0)
#define SENSOR_HOTFIRE_PRINTLN_()    \
    do {                             \
        if (g_sensor_hotfire_serial) \
            Serial.println();        \
    } while (0)
#define SENSOR_HOTFIRE_BOOT_PRINT(x) \
    do {                             \
        Serial.print(x);             \
    } while (0)
#define SENSOR_HOTFIRE_BOOT_PRINTLN(x) \
    do {                               \
        Serial.println(x);             \
    } while (0)

namespace SensorHotfire {

inline OTAEthernetServer g_ota_server{HOTFIRE_OTA_PORT};

enum class State : uint8_t {
    WaitingForServer = 1,  // SETUP
    Active = 2,            // ACTIVE
    StandaloneAbort = 9,   // STANDALONE_ABORT
    SelfTest = 10          // SELF_TEST
};

enum class IncomingPacketKind {
    None,
    ServerHeartbeat,
    SensorConfig,
    ClearAbort,
    NoConnAbort
};

struct StoredSensorConfig {
    bool valid;
    uint8_t reference_voltage;  // 0 = internal 2.5V, 1 = VDD, 2 = 5V (ignored;
                                // treat as 0)
    bool necessary_for_abort;
    uint32_t actuator_controller_ip;
    uint8_t num_sensors;                        // 0 = use board default
    uint8_t sensor_ids[MAX_SENSORS_PER_BOARD];  // connector IDs to read and
                                                // transmit
};

struct Config {
    const char* board_name;
    const sense_board_pins::Layout* pins;
    void (*init_adc)(void* user_data);
    void (*collect_chunk)(void* user_data);
    /** Send collected chunks to primary dest; if also_to_abort_controller then
     * send same data to abort_controller_ip:port as well, then drain. */
    void (*send_chunks_to)(void* user_data, IPAddress dest_ip, int dest_port,
                           bool also_to_abort_controller,
                           IPAddress abort_controller_ip,
                           int abort_controller_port);
    /** Called when SENSOR_CONFIG is received with reference_voltage byte
     * (0=2.5V internal, 1=VDD, 2=ignore). */
    void (*on_reference_voltage_config)(void* user_data,
                                        uint8_t reference_voltage);
    /**
     * Called once when entering SelfTest state.
     * Performs ADC self-test and connector continuity check, fills
     * `results_out`. After return, core sends the SELF_TEST packet and goes to
     * Active.
     */
    void (*run_self_test)(void* user_data, const StoredSensorConfig& config,
                          std::vector<Diablo::SelfTestResult>& results_out);
    void* user_data;
};

struct CoreState {
    uint8_t board_id;
    byte mac[6];
    IPAddress staticIP;
    IPAddress gateway;
    IPAddress subnet;
    IPAddress dns;
    IPAddress serverIP;
    int serverPort;
    const int udpListenPort = 5005;
    const int serverPortDefault = 5006;
    bool usingDhcp = false;  // true if a DHCP lease is active (see setup())
#ifdef SENSOR_ETH_ZEROCONF
    bool serverLearned = false;  // server IP adopted from an inbound packet
    bool addrLocked = false;     // one-way: set on first server contact / OTA
    bool inLinkLocal = false;    // current phase: static vs 169.254.x.y
    unsigned long phaseStartMillis = 0;
    unsigned long lastServerPacketMillis = 0;
#endif
    EthernetUDP udp;
    State state;
    StoredSensorConfig stored_config;
    unsigned long lastHeartbeatMillis;
    unsigned long last_led_cycle_millis;
    unsigned long last_led_edge_millis;
    int led_blink_index;
    bool led_on;
};

//-----------------------------------------------------------------------------
// Packet header / parsing helpers
//-----------------------------------------------------------------------------
inline bool readPacketHeader(const uint8_t* buffer, size_t len,
                             Diablo::PacketHeader& hdr_out) {
    if (len < sizeof(Diablo::PacketHeader))
        return false;
    memcpy(&hdr_out, buffer, sizeof(Diablo::PacketHeader));
    return true;
}

inline const char* packetTypeName(uint8_t type) {
    switch (type) {
        case 1:
            return "BOARD_HEARTBEAT";
        case 2:
            return "SERVER_HEARTBEAT";
        case 3:
            return "SENSOR_DATA";
        case 4:
            return "ACTUATOR_COMMAND";
        case 5:
            return "SENSOR_CONFIG";
        case 6:
            return "ACTUATOR_CONFIG";
        case 7:
            return "ABORT";
        case 8:
            return "ABORT_DONE";
        case 9:
            return "CLEAR_ABORT";
        case 10:
            return "PWM_ACTUATOR_COMMAND";
        case SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE:
            return "NO_CONNECTION_ABORT";
        case 12:
            return "SELF_TEST";
        default:
            return "UNKNOWN";
    }
}

//-----------------------------------------------------------------------------
// Zero-config discovery (see hotfire_config.h). While no server is known the
// board broadcasts BOARD_HEARTBEAT; the server's IP is learned from inbound
// server packets; with neither DHCP nor a server on the static subnet, the
// address alternates between static 192.168.2.<BOARD_ID> and a MAC-derived
// link-local 169.254.x.y so an unconfigured (self-assigned) laptop can reach
// it. The first server contact locks the address until reboot.
//-----------------------------------------------------------------------------
#ifdef SENSOR_ETH_ZEROCONF
inline IPAddress zeroconfLinkLocalIP(const byte mac[6]) {
    // RFC 3927 space minus its reserved first/last /24s; clamping both host
    // octets to [1,254] also keeps the low octet clear of .0/.255.
    uint8_t x = mac[4];
    uint8_t y = mac[5];
    if (x < 1)
        x = 1;
    if (x > 254)
        x = 254;
    if (y < 1)
        y = 1;
    if (y > 254)
        y = 254;
    return IPAddress(169, 254, x, y);
}

inline void zeroconfSetPhase(CoreState& s, bool toLinkLocal) {
    IPAddress ip = toLinkLocal ? zeroconfLinkLocalIP(s.mac) : s.staticIP;
    // Single SIPR register write; the W5500's UDP and OTA sockets are
    // port-bound and survive it.
    Ethernet.setLocalIP(ip);
    s.inLinkLocal = toLinkLocal;
    s.phaseStartMillis = millis();
    Serial.print("[ZEROCONF] address phase -> ");
    Serial.println(ip);
    Serial.flush();
}

inline void zeroconfOnServerPacket(CoreState& s, IPAddress remote_ip) {
    s.lastServerPacketMillis = millis();
    if (!s.addrLocked) {
        if (!s.usingDhcp) {
            // Snap to the server's address family before locking.
            bool wantLinkLocal = (remote_ip[0] == 169 && remote_ip[1] == 254);
            if (wantLinkLocal != s.inLinkLocal)
                zeroconfSetPhase(s, wantLinkLocal);
        }
        s.addrLocked = true;  // one-way: never re-address mid-test
        Serial.println("[ZEROCONF] address locked");
        Serial.flush();
    }
    if (!s.serverLearned || !(remote_ip == s.serverIP)) {
        s.serverIP = remote_ip;
        s.serverLearned = true;
        Serial.print("[ZEROCONF] server learned: ");
        Serial.println(remote_ip);
        Serial.flush();
    }
}
#endif  // SENSOR_ETH_ZEROCONF

inline bool zeroconfSkipDefaultUnicast(const CoreState& s) {
#ifdef SENSOR_ETH_ZEROCONF
    // In link-local phase with no server known, the unicast to the default
    // 192.168.2.x server is guaranteed dead and each attempt blocks ~1.8 s
    // in W5500 ARP retries; the broadcast heartbeat still announces us.
    return s.inLinkLocal && !s.serverLearned;
#else
    (void)s;
    return false;
#endif
}

inline IncomingPacketKind processIncomingPacket(CoreState& s, const Config& cfg,
                                                const uint8_t* buffer,
                                                size_t len, IPAddress remote_ip,
                                                int remote_port) {
    Diablo::PacketHeader hdr;
    if (!readPacketHeader(buffer, len, hdr))
        return IncomingPacketKind::None;

    if (hdr.packet_type == Diablo::PacketType::SERVER_HEARTBEAT) {
        Diablo::PacketHeader dummy;
        Diablo::ServerHeartbeatPacket data;
        if (Diablo::parse_server_heartbeat_packet(buffer, len, dummy, data)) {
#ifdef SENSOR_ETH_ZEROCONF
            zeroconfOnServerPacket(s, remote_ip);
#else
            // Server IP/port are hardcoded; do not update from packet
#endif
            return IncomingPacketKind::ServerHeartbeat;
        }
        return IncomingPacketKind::None;
    }

    if (hdr.packet_type == Diablo::PacketType::SENSOR_CONFIG) {
        Diablo::PacketHeader dummy;
        std::vector<uint8_t> sensor_ids;
        uint8_t reference_voltage = 0;
        bool necessary_for_abort = false;
        uint32_t controller_ip = 0;
        uint8_t enable_serial_printing = 1;

        if (!Diablo::parse_sensor_config_packet(
                buffer, len, dummy, sensor_ids, reference_voltage,
                necessary_for_abort, controller_ip, enable_serial_printing)) {
            Serial.println("SENSOR_CONFIG parse failed (DAQv2-Comms)");
            Serial.flush();
            return IncomingPacketKind::None;
        }

        s.stored_config.valid = true;
        s.stored_config.reference_voltage = reference_voltage;
        s.stored_config.necessary_for_abort = necessary_for_abort;
        s.stored_config.actuator_controller_ip = controller_ip;
        s.stored_config.num_sensors = static_cast<uint8_t>(
            sensor_ids.size() <= MAX_SENSORS_PER_BOARD ? sensor_ids.size()
                                                       : MAX_SENSORS_PER_BOARD);
        for (uint8_t i = 0; i < s.stored_config.num_sensors; ++i)
            s.stored_config.sensor_ids[i] = sensor_ids[i];

        if (cfg.on_reference_voltage_config)
            cfg.on_reference_voltage_config(cfg.user_data,
                                            s.stored_config.reference_voltage);

        g_sensor_hotfire_serial = (enable_serial_printing != 0);

        Serial.println("SENSOR_CONFIG received (DAQv2-Comms):");
        Serial.print("  num_sensors=");
        Serial.println(static_cast<unsigned>(sensor_ids.size()));
        Serial.print("  sensor_ids=");
        if (!sensor_ids.empty()) {
            for (size_t i = 0; i < sensor_ids.size(); ++i) {
                if (i)
                    Serial.print(",");
                Serial.print(static_cast<unsigned>(sensor_ids[i]));
            }
            Serial.println();
        } else {
            Serial.println("(none)");
        }
        Serial.print("  reference_voltage=");
        Serial.println(
            static_cast<unsigned>(s.stored_config.reference_voltage));
        Serial.print("  necessary_for_abort=");
        Serial.println(s.stored_config.necessary_for_abort ? 1 : 0);
        Serial.print("  actuator_controller_ip=");
        if (s.stored_config.actuator_controller_ip != 0) {
            const uint8_t* ip_bytes = reinterpret_cast<const uint8_t*>(
                &s.stored_config.actuator_controller_ip);
            IPAddress actuatorIP(ip_bytes[0], ip_bytes[1], ip_bytes[2],
                                 ip_bytes[3]);
            Serial.println(actuatorIP);
        } else {
            Serial.println("0.0.0.0");
        }
        Serial.print("  enable_serial_printing=");
        Serial.println(g_sensor_hotfire_serial ? 1 : 0);
        Serial.flush();
#ifdef SENSOR_ETH_ZEROCONF
        zeroconfOnServerPacket(s, remote_ip);
#endif
        return IncomingPacketKind::SensorConfig;
    }

    if (hdr.packet_type == Diablo::PacketType::CLEAR_ABORT)
        return IncomingPacketKind::ClearAbort;

    if (hdr.packet_type == Diablo::PacketType::NO_CONNECTION_ABORT) {
        if (len >= sizeof(Diablo::PacketHeader))
            return IncomingPacketKind::NoConnAbort;
        return IncomingPacketKind::None;
    }
    return IncomingPacketKind::None;
}

inline void applyPacketTransition(CoreState& s, const Config& cfg,
                                  IncomingPacketKind kind) {
    switch (s.state) {
        case State::WaitingForServer:
            if (kind == IncomingPacketKind::SensorConfig) {
                if (cfg.run_self_test) {
                    s.state = State::SelfTest;
                    Serial.println("State -> SelfTest");
                } else {
                    s.state = State::Active;
                    Serial.println("State -> Active");
                }
                Serial.flush();
            }
            break;
        case State::Active:
            if (kind == IncomingPacketKind::NoConnAbort &&
                s.stored_config.necessary_for_abort) {
                s.state = State::StandaloneAbort;
                Serial.println("State -> StandaloneAbort");
                Serial.flush();
            }
            break;
        case State::StandaloneAbort:
            if (kind == IncomingPacketKind::ClearAbort) {
                s.state = State::Active;
                Serial.println("State -> Active");
                Serial.flush();
            }
            break;
        case State::SelfTest:
            // State handled in loop(), it's a transient state returning to
            // Active
            break;
    }
}

inline void sendBoardHeartbeat(CoreState& s, const Config& cfg,
                               Diablo::BoardState board_state,
                               IPAddress dest_ip, int dest_port) {
    Diablo::BoardHeartbeatPacket hb;
    memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
    hb.board_id = s.board_id;
    hb.engine_state = Diablo::EngineState::SAFE;
    hb.board_state = board_state;

    uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
    size_t n = Diablo::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                     sizeof(packetBuffer));
    if (n == 0)
        return;
    Serial.print("Sent: heartbeat to ");
    Serial.print(dest_ip);
    Serial.print(":");
    Serial.println(dest_port);
    Serial.flush();
    s.udp.beginPacket(dest_ip, dest_port);
    s.udp.write(packetBuffer, n);
    s.udp.endPacket();
}

inline void updateStateLed(CoreState& s, const Config& cfg, int state_num) {
    if (state_num < 1)
        state_num = 1;
    if (state_num > 10)
        state_num = 10;
    const int led_pin = cfg.pins->LED;
    unsigned long now = millis();
    const unsigned long STATE_LED_CYCLE_MS = 2500;
    const unsigned long BLINK_ON_MS = 120;
    const unsigned long BLINK_OFF_MS = 120;

    if (now - s.last_led_cycle_millis >= STATE_LED_CYCLE_MS) {
        s.last_led_cycle_millis = now;
        s.last_led_edge_millis = now;
        s.led_blink_index = 0;
        s.led_on = true;
        digitalWrite(led_pin, HIGH);
        return;
    }
    if (s.led_blink_index >= state_num)
        return;
    if (s.led_on) {
        if (now - s.last_led_edge_millis >= BLINK_ON_MS) {
            digitalWrite(led_pin, LOW);
            s.led_on = false;
            s.led_blink_index++;
            s.last_led_edge_millis = now;
        }
    } else {
        if (now - s.last_led_edge_millis >= BLINK_OFF_MS) {
            digitalWrite(led_pin, HIGH);
            s.led_on = true;
            s.last_led_edge_millis = now;
        }
    }
}

inline void setup(CoreState& s, const Config& cfg) {
    Serial.begin(115200);
    delay(SERIAL_MONITOR_READY_DELAY_MS);
    FirmwareHash::print();
    SENSOR_HOTFIRE_BOOT_PRINT(cfg.board_name);
    SENSOR_HOTFIRE_BOOT_PRINTLN(" Hotfire state machine starting...");

    s.board_id = (uint8_t)BOARD_ID;
    s.staticIP = IPAddress(192, 168, 2, (uint8_t)BOARD_ID);
    SENSOR_HOTFIRE_BOOT_PRINT("Board ID and IP: ");
    SENSOR_HOTFIRE_BOOT_PRINT(static_cast<unsigned>(s.board_id));
    SENSOR_HOTFIRE_BOOT_PRINT(" / 192.168.2.");
    SENSOR_HOTFIRE_BOOT_PRINTLN(static_cast<unsigned>(s.board_id));

    const sense_board_pins::Layout& Pins = *cfg.pins;
    pinMode(Pins.LED, OUTPUT);
    digitalWrite(Pins.LED, LOW);

    if (cfg.init_adc)
        cfg.init_adc(cfg.user_data);

    ESP_ERROR_CHECK(esp_read_mac(s.mac, ESP_MAC_ETH));
    SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI, Pins.ETH_CS);
    delay(ETHERNET_SPI_DELAY_MS);
    Ethernet.init(Pins.ETH_CS);
    delay(ETHERNET_INIT_DELAY_MS);
#ifdef SENSOR_ETH_USE_DHCP
    // Try DHCP first (short timeout), fall back to the deterministic static
    // address on failure. NOTE: inbound commands and OTA still target the
    // static 192.168.2.<BOARD_ID>. A successful DHCP lease that differs from
    // staticIP moves this board off its well-known address, so control/OTA
    // will not reach it until it falls back or is rediscovered.
    SENSOR_HOTFIRE_BOOT_PRINTLN("[ETH] Attempting DHCP...");
    if (Ethernet.begin(s.mac, SENSOR_ETH_DHCP_TIMEOUT_MS,
                       SENSOR_ETH_DHCP_RESPONSE_TIMEOUT_MS) == 1) {
        s.usingDhcp = true;
        SENSOR_HOTFIRE_BOOT_PRINT("[ETH] DHCP lease acquired: ");
        SENSOR_HOTFIRE_BOOT_PRINTLN(Ethernet.localIP());
    } else {
        s.usingDhcp = false;
        SENSOR_HOTFIRE_BOOT_PRINTLN(
            "[ETH] DHCP failed — falling back to static IP");
        Ethernet.begin(s.mac, s.staticIP, s.dns, s.gateway, s.subnet);
    }
#else
    Ethernet.begin(s.mac, s.staticIP, s.dns, s.gateway, s.subnet);
#endif
    delay(ETHERNET_BEGIN_DELAY_MS);

    // W5500 / Ethernet status (same pattern as Stream_ADC_Data and other DAQ
    // sketches)
    SENSOR_HOTFIRE_BOOT_PRINTLN("[ETH] Ethernet initialized (SPI WIZnet)");
    SENSOR_HOTFIRE_BOOT_PRINT("Configured static IP: ");
    SENSOR_HOTFIRE_BOOT_PRINTLN(s.staticIP);
    SENSOR_HOTFIRE_BOOT_PRINT("Stack IP (Ethernet.localIP): ");
    SENSOR_HOTFIRE_BOOT_PRINTLN(Ethernet.localIP());
    SENSOR_HOTFIRE_BOOT_PRINT("Hardware: ");
    switch (Ethernet.hardwareStatus()) {
        case EthernetNoHardware:
            SENSOR_HOTFIRE_BOOT_PRINTLN(
                "no chip detected — check CS / SPI wiring");
            break;
        case EthernetW5100:
            SENSOR_HOTFIRE_BOOT_PRINTLN("W5100");
            break;
        case EthernetW5200:
            SENSOR_HOTFIRE_BOOT_PRINTLN("W5200");
            break;
        case EthernetW5500:
            SENSOR_HOTFIRE_BOOT_PRINTLN("W5500");
            break;
        default:
            SENSOR_HOTFIRE_BOOT_PRINTLN("unknown");
            break;
    }
    SENSOR_HOTFIRE_BOOT_PRINT("Link status: ");
    if (Ethernet.linkStatus() == LinkON) {
        SENSOR_HOTFIRE_BOOT_PRINTLN("Connected");
    } else if (Ethernet.linkStatus() == LinkOFF) {
        SENSOR_HOTFIRE_BOOT_PRINTLN("Disconnected");
    } else {
        SENSOR_HOTFIRE_BOOT_PRINTLN("Unknown");
    }
    if (Ethernet.localIP() == IPAddress(0, 0, 0, 0)) {
        SENSOR_HOTFIRE_BOOT_PRINTLN(
            "[ETH] WARNING: stack IP is 0.0.0.0 — check cable / W5500");
    }
    Serial.flush();

    s.udp.begin(SENSOR_UDP_LISTEN_PORT);
    Serial.print("UDP listening on port ");
    Serial.println(SENSOR_UDP_LISTEN_PORT);
    Serial.println(
        "(Expect SENSOR_CONFIG packet type 5 to transition to Active)");
    g_ota_server.begin();
    Serial.print("OTA TCP server listening on port ");
    Serial.println(HOTFIRE_OTA_PORT);
    Serial.flush();

    s.state = State::WaitingForServer;
    s.serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
    s.serverPort = HOTFIRE_SERVER_PORT;
    s.lastHeartbeatMillis = 0;
#ifdef SENSOR_ETH_ZEROCONF
    s.phaseStartMillis = millis();
    SENSOR_HOTFIRE_BOOT_PRINTLN(
        "[ZEROCONF] enabled: broadcast discovery + AutoIP fallback");
#endif
    Serial.println("State -> WaitingForServer");
    Serial.flush();
    Serial.print("Config target: send SENSOR_CONFIG to 192.168.2.");
    Serial.print(static_cast<unsigned>(s.board_id));
    Serial.println(":5005");
    Serial.flush();
    SENSOR_HOTFIRE_BOOT_PRINTLN("Setup complete. State: WaitingForServer");
}

inline void loop(CoreState& s, const Config& cfg) {
#ifdef SENSOR_ETH_USE_DHCP
    // Renew/rebind the DHCP lease as it expires. No-op on the static path.
    if (s.usingDhcp)
        Ethernet.maintain();
#endif
#ifdef SENSOR_ETH_ZEROCONF
    // Address hunting: only before any server contact, and only while still
    // waiting for configuration -- a locked or configured board never moves.
    if (!s.usingDhcp && !s.addrLocked && s.state == State::WaitingForServer &&
        millis() - s.phaseStartMillis >= SENSOR_ZEROCONF_PHASE_MS)
        zeroconfSetPhase(s, !s.inLinkLocal);
#endif
    // Non-blocking OTA check — blocks only if a client actually connects
    EthernetClient ota_client = g_ota_server.available();
    if (ota_client) {
#ifdef SENSOR_ETH_ZEROCONF
        s.addrLocked = true;  // never re-address mid-flash
#endif
        hotfire_handleOTA(ota_client);
    }

    const size_t maxPacket = SENSOR_HOTFIRE_MAX_PACKET_SIZE;
    static uint32_t s_udp_check_count = 0;
    static unsigned long s_last_debug_ms = 0;
    static int s_last_parse_result = -1;

    s_udp_check_count++;
    int packetSize = s.udp.parsePacket();
    s_last_parse_result = packetSize;

    if (packetSize > 0) {
        IPAddress remoteIP = s.udp.remoteIP();
        int remotePort = s.udp.remotePort();
        uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
        int bytesRead = s.udp.read(packetBuffer, maxPacket);
        if (bytesRead <= 0) {
            Serial.print("WARNING: parsePacket returned ");
            Serial.print(packetSize);
            Serial.println(" but read() returned 0");
            Serial.flush();
        } else {
            Serial.print("Received packet from ");
            Serial.print(remoteIP);
            Serial.print(":");
            Serial.print(remotePort);
            Serial.print(" type ");
            Serial.print(static_cast<unsigned>(packetBuffer[0]));
            Serial.print(" (");
            Serial.print(packetTypeName(packetBuffer[0]));
            Serial.print(") len=");
            Serial.print(bytesRead);
            Serial.print(" hex:");
            for (int i = 0; i < bytesRead && i < 12; i++) {
                Serial.print(" ");
                if (packetBuffer[i] < 16)
                    Serial.print("0");
                Serial.print(packetBuffer[i], HEX);
            }
            Serial.println();
            Serial.flush();
            IncomingPacketKind kind = processIncomingPacket(
                s, cfg, packetBuffer, bytesRead, remoteIP, remotePort);
            if (kind == IncomingPacketKind::SensorConfig) {
                Serial.println("SENSOR_CONFIG parsed -> transitioning");
                Serial.flush();
            } else if (static_cast<uint8_t>(packetBuffer[0]) == 6) {
                Serial.println(
                    "(Packet type 6 = ACTUATOR_CONFIG; PT expects "
                    "SENSOR_CONFIG type 5)");
                Serial.flush();
            } else if (static_cast<uint8_t>(packetBuffer[0]) == 5) {
                Serial.println(
                    "(Type 5 received but parse failed - check header/length)");
                Serial.flush();
            }
            applyPacketTransition(s, cfg, kind);
        }
    }

#ifdef SENSOR_ETH_ZEROCONF
    // Server gone quiet: forget it and resume discovery broadcasts so a new
    // (or restarted) server can find us. The address stays locked -- an
    // Active board never moves; only the outbound destination resets.
    if (s.serverLearned && millis() - s.lastServerPacketMillis >=
                               SENSOR_ZEROCONF_SERVER_SILENCE_MS) {
        s.serverLearned = false;
        s.serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
        Serial.println("[ZEROCONF] server silent -- resuming discovery");
        Serial.flush();
    }
#endif

    if (s.state == State::Active || s.state == State::StandaloneAbort) {
        if (cfg.collect_chunk)
            cfg.collect_chunk(cfg.user_data);
    } else if (s.state == State::SelfTest) {
        if (cfg.run_self_test) {
            std::vector<Diablo::SelfTestResult> results;
            cfg.run_self_test(cfg.user_data, s.stored_config, results);

            uint8_t adc_good = 0;
            if (!results.empty() && results[0].sensor_id == 0) {
                adc_good = results[0].result;
                results.erase(results.begin());
            }

            uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
            size_t packetSize = Diablo::create_self_test_packet(
                adc_good, results, millis(), packetBuffer,
                sizeof(packetBuffer));
            if (packetSize > 0) {
                s.udp.beginPacket(s.serverIP, s.serverPort);
                s.udp.write(packetBuffer, packetSize);
                s.udp.endPacket();
                SENSOR_HOTFIRE_PRINT("Sent: SELF_TEST to ");
                SENSOR_HOTFIRE_PRINT(s.serverIP);
                SENSOR_HOTFIRE_PRINT(":");
                SENSOR_HOTFIRE_PRINTLN(s.serverPort);
            }
        }
        s.state = State::Active;
        Serial.println("State -> Active");
        Serial.flush();
    }

    switch (s.state) {
        case State::WaitingForServer:
            break;
        case State::Active:
            if (cfg.send_chunks_to)
                cfg.send_chunks_to(cfg.user_data, s.serverIP, s.serverPort,
                                   false, IPAddress(0, 0, 0, 0), 0);
            break;
        case State::StandaloneAbort:
            if (cfg.send_chunks_to) {
                bool also_abort = s.stored_config.valid &&
                                  s.stored_config.actuator_controller_ip != 0;
                IPAddress actuatorIP(0, 0, 0, 0);
                if (also_abort) {
                    const uint8_t* ip_bytes = reinterpret_cast<const uint8_t*>(
                        &s.stored_config.actuator_controller_ip);
                    actuatorIP = IPAddress(ip_bytes[0], ip_bytes[1],
                                           ip_bytes[2], ip_bytes[3]);
                }
                cfg.send_chunks_to(cfg.user_data, s.serverIP, s.serverPort,
                                   also_abort, actuatorIP, s.serverPortDefault);
            }
            break;
        case State::SelfTest:
            break;
    }

    int state_num = static_cast<int>(s.state);
    updateStateLed(s, cfg, state_num);

    unsigned long now = millis();
    if (s.state == State::WaitingForServer && (now - s_last_debug_ms >= 2000)) {
        s_last_debug_ms = now;
        Serial.print("PT debug: state=WaitingForServer IP=");
        Serial.print(Ethernet.localIP());
        Serial.print(" udp_checks=");
        Serial.print(s_udp_check_count);
        Serial.print(" last_parse=");
        Serial.println(s_last_parse_result);
        Serial.flush();
    }
    if (now - s.lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
        s.lastHeartbeatMillis = now;
        switch (s.state) {
            case State::WaitingForServer:
                if (!zeroconfSkipDefaultUnicast(s)) {
                    Serial.println("Setup state: sending heartbeat");
                    Serial.flush();
                    sendBoardHeartbeat(s, cfg, Diablo::BoardState::SETUP,
                                       s.serverIP, s.serverPort);
                }
                break;
            case State::Active:
                sendBoardHeartbeat(s, cfg, Diablo::BoardState::ACTIVE,
                                   s.serverIP, s.serverPort);
                break;
            case State::SelfTest:
                sendBoardHeartbeat(s, cfg, Diablo::BoardState::SELF_TEST,
                                   s.serverIP, s.serverPort);
                break;
            case State::StandaloneAbort:
                sendBoardHeartbeat(s, cfg, Diablo::BoardState::STANDALONE_ABORT,
                                   s.serverIP, s.serverPort);
                if (s.stored_config.valid &&
                    s.stored_config.actuator_controller_ip != 0) {
                    const uint8_t* ip_bytes = reinterpret_cast<const uint8_t*>(
                        &s.stored_config.actuator_controller_ip);
                    IPAddress actuatorIP(ip_bytes[0], ip_bytes[1], ip_bytes[2],
                                         ip_bytes[3]);
                    sendBoardHeartbeat(s, cfg,
                                       Diablo::BoardState::STANDALONE_ABORT,
                                       actuatorIP, s.serverPortDefault);
                }
                break;
        }
#ifdef SENSOR_ETH_ZEROCONF
        // Discovery: announce to everyone on the wire until a server is
        // learned. Reuses the normal heartbeat packet on the same 1 s tick.
        if (!s.serverLearned) {
            Diablo::BoardState bs = Diablo::BoardState::SETUP;
            if (s.state == State::Active)
                bs = Diablo::BoardState::ACTIVE;
            else if (s.state == State::SelfTest)
                bs = Diablo::BoardState::SELF_TEST;
            else if (s.state == State::StandaloneAbort)
                bs = Diablo::BoardState::STANDALONE_ABORT;
            sendBoardHeartbeat(s, cfg, bs, IPAddress(255, 255, 255, 255),
                               HOTFIRE_SERVER_PORT);
        }
#endif
    }

    delay(LOOP_DELAY_MS);
}

}  // namespace SensorHotfire
