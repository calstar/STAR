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
#include <daq-protocol.h>
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

// Two-tier serial logging (HF_LOG* = always, HF_VERBOSE* = verbose-only, gated by
// g_verbose). Each board defines `bool g_verbose = true;` once in its main .cpp.
#include "hotfire_log.h"

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
                          std::vector<daq::SelfTestResult>& results_out);
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
                             daq::PacketHeader& hdr_out) {
    if (len < sizeof(daq::PacketHeader))
        return false;
    memcpy(&hdr_out, buffer, sizeof(daq::PacketHeader));
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

inline IncomingPacketKind processIncomingPacket(CoreState& s, const Config& cfg,
                                                const uint8_t* buffer,
                                                size_t len, IPAddress remote_ip,
                                                int remote_port) {
    daq::PacketHeader hdr;
    if (!readPacketHeader(buffer, len, hdr))
        return IncomingPacketKind::None;

    if (hdr.packet_type == daq::PacketType::SERVER_HEARTBEAT) {
        daq::PacketHeader dummy;
        daq::ServerHeartbeatPacket data;
        if (daq::parse_server_heartbeat_packet(buffer, len, dummy, data)) {
            // Server IP/port are hardcoded; do not update from packet
            return IncomingPacketKind::ServerHeartbeat;
        }
        return IncomingPacketKind::None;
    }

    if (hdr.packet_type == daq::PacketType::SENSOR_CONFIG) {
        daq::PacketHeader dummy;
        std::vector<uint8_t> sensor_ids;
        uint8_t reference_voltage = 0;
        bool necessary_for_abort = false;
        uint32_t controller_ip = 0;
        uint8_t enable_serial_printing = 1;

        if (!daq::parse_sensor_config_packet(
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

        g_verbose = (enable_serial_printing != 0);

        HF_LOGLN("SENSOR_CONFIG received (DAQv2-Comms):");
        // Field-by-field breakdown is verbose-only; the header above is Tier 1.
        HF_VERBOSE("  num_sensors=");
        HF_VERBOSELN(static_cast<unsigned>(sensor_ids.size()));
        HF_VERBOSE("  sensor_ids=");
        if (!sensor_ids.empty()) {
            for (size_t i = 0; i < sensor_ids.size(); ++i) {
                if (i)
                    HF_VERBOSE(",");
                HF_VERBOSE(static_cast<unsigned>(sensor_ids[i]));
            }
            HF_VERBOSELN_();
        } else {
            HF_VERBOSELN("(none)");
        }
        HF_VERBOSE("  reference_voltage=");
        HF_VERBOSELN(
            static_cast<unsigned>(s.stored_config.reference_voltage));
        HF_VERBOSE("  necessary_for_abort=");
        HF_VERBOSELN(s.stored_config.necessary_for_abort ? 1 : 0);
        HF_VERBOSE("  actuator_controller_ip=");
        if (s.stored_config.actuator_controller_ip != 0) {
            const uint8_t* ip_bytes = reinterpret_cast<const uint8_t*>(
                &s.stored_config.actuator_controller_ip);
            IPAddress actuatorIP(ip_bytes[0], ip_bytes[1], ip_bytes[2],
                                 ip_bytes[3]);
            HF_VERBOSELN(actuatorIP);
        } else {
            HF_VERBOSELN("0.0.0.0");
        }
        HF_VERBOSE("  enable_serial_printing=");
        HF_VERBOSELN(g_verbose ? 1 : 0);
        Serial.flush();
        return IncomingPacketKind::SensorConfig;
    }

    if (hdr.packet_type == daq::PacketType::CLEAR_ABORT)
        return IncomingPacketKind::ClearAbort;

    if (hdr.packet_type == daq::PacketType::NO_CONNECTION_ABORT) {
        if (len >= sizeof(daq::PacketHeader))
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
                               daq::BoardState board_state,
                               IPAddress dest_ip, int dest_port) {
    daq::BoardHeartbeatPacket hb;
    memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
    hb.board_id = s.board_id;
    hb.engine_state = daq::EngineState::SAFE;
    hb.board_state = board_state;

    uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
    size_t n = daq::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                     sizeof(packetBuffer));
    if (n == 0)
        return;
    HF_VERBOSE("Sent: heartbeat to ");
    HF_VERBOSE(dest_ip);
    HF_VERBOSE(":");
    HF_VERBOSELN(dest_port);
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
    HF_LOG(cfg.board_name);
    HF_LOGLN(" Hotfire state machine starting...");

    s.board_id = (uint8_t)BOARD_ID;
    s.staticIP = IPAddress(192, 168, 2, (uint8_t)BOARD_ID);
    HF_LOG("Board ID and IP: ");
    HF_LOG(static_cast<unsigned>(s.board_id));
    HF_LOG(" / 192.168.2.");
    HF_LOGLN(static_cast<unsigned>(s.board_id));

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
    Ethernet.begin(s.mac, s.staticIP, s.dns, s.gateway, s.subnet);
    delay(ETHERNET_BEGIN_DELAY_MS);

    // W5500 / Ethernet status (same pattern as Stream_ADC_Data and other DAQ
    // sketches)
    HF_LOGLN("[ETH] Ethernet initialized (SPI WIZnet)");
    HF_LOG("Configured static IP: ");
    HF_LOGLN(s.staticIP);
    HF_LOG("Stack IP (Ethernet.localIP): ");
    HF_LOGLN(Ethernet.localIP());
    HF_LOG("Hardware: ");
    switch (Ethernet.hardwareStatus()) {
        case EthernetNoHardware:
            HF_LOGLN(
                "no chip detected — check CS / SPI wiring");
            break;
        case EthernetW5100:
            HF_LOGLN("W5100");
            break;
        case EthernetW5200:
            HF_LOGLN("W5200");
            break;
        case EthernetW5500:
            HF_LOGLN("W5500");
            break;
        default:
            HF_LOGLN("unknown");
            break;
    }
    HF_LOG("Link status: ");
    if (Ethernet.linkStatus() == LinkON) {
        HF_LOGLN("Connected");
    } else if (Ethernet.linkStatus() == LinkOFF) {
        HF_LOGLN("Disconnected");
    } else {
        HF_LOGLN("Unknown");
    }
    if (Ethernet.localIP() == IPAddress(0, 0, 0, 0)) {
        HF_LOGLN(
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
    Serial.println("State -> WaitingForServer");
    Serial.flush();
    Serial.print("Config target: send SENSOR_CONFIG to 192.168.2.");
    Serial.print(static_cast<unsigned>(s.board_id));
    Serial.println(":5005");
    Serial.flush();
    HF_LOGLN("Setup complete. State: WaitingForServer");
}

inline void loop(CoreState& s, const Config& cfg) {
    // Non-blocking OTA check — blocks only if a client actually connects
    EthernetClient ota_client = g_ota_server.available();
    if (ota_client)
        hotfire_handleOTA(ota_client);

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
            HF_LOG("WARNING: parsePacket returned ");
            HF_LOG(packetSize);
            HF_LOGLN(" but read() returned 0");
        } else {
            HF_VERBOSE("Received packet from ");
            HF_VERBOSE(remoteIP);
            HF_VERBOSE(":");
            HF_VERBOSE(remotePort);
            HF_VERBOSE(" type ");
            HF_VERBOSE(static_cast<unsigned>(packetBuffer[0]));
            HF_VERBOSE(" (");
            HF_VERBOSE(packetTypeName(packetBuffer[0]));
            HF_VERBOSE(") len=");
            HF_VERBOSE(bytesRead);
            HF_VERBOSE(" hex:");
            for (int i = 0; i < bytesRead && i < 12; i++) {
                HF_VERBOSE(" ");
                if (packetBuffer[i] < 16)
                    HF_VERBOSE("0");
                HF_VERBOSE(packetBuffer[i], HEX);
            }
            HF_VERBOSELN_();
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

    if (s.state == State::Active || s.state == State::StandaloneAbort) {
        if (cfg.collect_chunk)
            cfg.collect_chunk(cfg.user_data);
    } else if (s.state == State::SelfTest) {
        if (cfg.run_self_test) {
            std::vector<daq::SelfTestResult> results;
            cfg.run_self_test(cfg.user_data, s.stored_config, results);

            uint8_t adc_good = 0;
            if (!results.empty() && results[0].sensor_id == 0) {
                adc_good = results[0].result;
                results.erase(results.begin());
            }

            uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
            size_t packetSize = daq::create_self_test_packet(
                adc_good, results, millis(), packetBuffer,
                sizeof(packetBuffer));
            if (packetSize > 0) {
                s.udp.beginPacket(s.serverIP, s.serverPort);
                s.udp.write(packetBuffer, packetSize);
                s.udp.endPacket();
                HF_VERBOSE("Sent: SELF_TEST to ");
                HF_VERBOSE(s.serverIP);
                HF_VERBOSE(":");
                HF_VERBOSELN(s.serverPort);
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
        HF_VERBOSE("PT debug: state=WaitingForServer IP=");
        HF_VERBOSE(Ethernet.localIP());
        HF_VERBOSE(" udp_checks=");
        HF_VERBOSE(s_udp_check_count);
        HF_VERBOSE(" last_parse=");
        HF_VERBOSELN(s_last_parse_result);
    }
    if (now - s.lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
        s.lastHeartbeatMillis = now;
        switch (s.state) {
            case State::WaitingForServer:
                HF_VERBOSELN("Setup state: sending heartbeat");
                sendBoardHeartbeat(s, cfg, daq::BoardState::SETUP,
                                   s.serverIP, s.serverPort);
                break;
            case State::Active:
                sendBoardHeartbeat(s, cfg, daq::BoardState::ACTIVE,
                                   s.serverIP, s.serverPort);
                break;
            case State::SelfTest:
                sendBoardHeartbeat(s, cfg, daq::BoardState::SELF_TEST,
                                   s.serverIP, s.serverPort);
                break;
            case State::StandaloneAbort:
                sendBoardHeartbeat(s, cfg, daq::BoardState::STANDALONE_ABORT,
                                   s.serverIP, s.serverPort);
                if (s.stored_config.valid &&
                    s.stored_config.actuator_controller_ip != 0) {
                    const uint8_t* ip_bytes = reinterpret_cast<const uint8_t*>(
                        &s.stored_config.actuator_controller_ip);
                    IPAddress actuatorIP(ip_bytes[0], ip_bytes[1], ip_bytes[2],
                                         ip_bytes[3]);
                    sendBoardHeartbeat(s, cfg,
                                       daq::BoardState::STANDALONE_ABORT,
                                       actuatorIP, s.serverPortDefault);
                }
                break;
        }
    }

    delay(LOOP_DELAY_MS);
}

}  // namespace SensorHotfire
