/**
 * @file daq_bridge_main.cpp
 * @brief DAQ Bridge — receives DiabloAvionics UDP packets, publishes to Elodin database.
 *
 * This is the simplified bridge. It does exactly three things:
 *   1. Receives raw sensor/heartbeat packets over UDP
 *   2. Parses them using the real DAQv2-Comms library (Diablo::)
 *   3. Publishes to Elodin database (raw sensor data + heartbeats)
 *
 * Calibration is handled by calibration_service.
 * Board config broadcast is handled by config_broadcast_service.
 * Board discovery is handled by those services, not here.
 */

#include <signal.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// DAQv2-Comms: the real protocol library (no copy)
#include "DAQv2-Comms.h"

#include "../../daq_comms/include/comms/messages/sensor/SensorMessages.hpp"
#include "../../daq_comms/include/transport/NetworkSocket.hpp"

#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "routing/HeartbeatRouter.hpp"

// ─────────────────────────────────────────────────────────────────────────────
// Signal handling
// ─────────────────────────────────────────────────────────────────────────────

static std::atomic<bool> running(true);

static void signal_handler(int /* sig */) {
    running = false;
    std::cout << "\n[DAQ Bridge] Shutting down..." << std::endl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Board type mapping
// ─────────────────────────────────────────────────────────────────────────────

enum class BoardType { PT, LC, TC, RTD, ACTUATOR, ENCODER, UNKNOWN };

struct BoardConfig {
    BoardType type;
    std::string ip;
    int num_sensors;
    bool enabled;
    int board_id;
    int channel_offset = 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Server heartbeat packet construction
// ─────────────────────────────────────────────────────────────────────────────

struct ServerHeartbeatConfig {
    uint32_t interval_ms = 1000;
    uint16_t broadcast_port = 5005;
    std::string broadcast_ip = "255.255.255.255";
    bool send_from_daq_bridge = true;
};

static std::vector<uint8_t> build_server_heartbeat_packet() {
    std::vector<uint8_t> pkt(7);
    uint32_t ts = static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                            std::chrono::steady_clock::now().time_since_epoch())
                                            .count() &
                                        0xFFFFFFFF);
    pkt[0] = 2;  // SERVER_HEARTBEAT
    pkt[1] = 0;  // DIABLO_COMMS_VERSION
    pkt[2] = static_cast<uint8_t>(ts & 0xFF);
    pkt[3] = static_cast<uint8_t>((ts >> 8) & 0xFF);
    pkt[4] = static_cast<uint8_t>((ts >> 16) & 0xFF);
    pkt[5] = static_cast<uint8_t>((ts >> 24) & 0xFF);
    pkt[6] = 0;  // engine_state = SAFE
    return pkt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config parsing — board map, database, network, heartbeat, sensor names
// ─────────────────────────────────────────────────────────────────────────────

using BoardOrder = std::vector<std::pair<std::string, BoardConfig>>;

static void load_config(const std::string& config_path,
                         std::map<std::string, BoardConfig>& board_map, BoardOrder& board_order,
                         std::string& db_host, uint16_t& db_port, uint16_t& sensor_port,
                         std::string& bind_ip, ServerHeartbeatConfig& hb_config,
                         std::map<int, std::string>& pt_channel_to_name,
                         std::map<int, std::string>& act_channel_to_name) {
    db_host = "127.0.0.1";
    db_port = 2240;
    sensor_port = 0;

    std::ifstream f(config_path);
    if (!f.is_open())
        return;

    std::string line, section;
    std::string board_type_str, board_ip;
    int board_num_sensors = 10, board_id = -1, board_channel_offset = 0;
    bool board_enabled = true;

    auto flush_board = [&]() {
        if (board_ip.empty())
            return;
        BoardType bt = BoardType::UNKNOWN;
        if (board_type_str == "PT")
            bt = BoardType::PT;
        else if (board_type_str == "LC")
            bt = BoardType::LC;
        else if (board_type_str == "TC")
            bt = BoardType::TC;
        else if (board_type_str == "RTD")
            bt = BoardType::RTD;
        else if (board_type_str == "ACTUATOR")
            bt = BoardType::ACTUATOR;
        else if (board_type_str == "ENCODER")
            bt = BoardType::ENCODER;
        if (bt != BoardType::UNKNOWN) {
            BoardConfig cfg{bt, board_ip, board_num_sensors, board_enabled, board_id,
                            board_channel_offset};
            board_map[board_ip] = cfg;
            if (board_enabled)
                board_order.emplace_back(board_ip, std::move(cfg));
        }
        board_ip.clear();
        board_type_str.clear();
        board_id = -1;
        board_channel_offset = 0;
    };

    auto strip = [](std::string& s) {
        while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r'))
            s.pop_back();
        size_t start = s.find_first_not_of(" \t");
        if (start != std::string::npos)
            s = s.substr(start);
    };

    auto unquote = [](std::string& s) {
        if (s.size() >= 2 && s.front() == '"' && s.back() == '"')
            s = s.substr(1, s.size() - 2);
    };

    auto to_entity_name = [](std::string s) {
        if (s.size() >= 2 && s.front() == '"' && s.back() == '"')
            s = s.substr(1, s.size() - 2);
        for (auto& c : s)
            if (c == ' ')
                c = '_';
        return s;
    };

    while (std::getline(f, line)) {
        size_t c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
        strip(line);
        if (line.empty())
            continue;

        if (line.size() >= 2 && line[0] == '[' && line.back() == ']') {
            flush_board();
            section = line.substr(1, line.size() - 2);
            board_num_sensors = 10;
            board_id = -1;
            board_enabled = true;
            continue;
        }

        size_t eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        strip(key);
        strip(val);
        unquote(val);

        if (section == "database") {
            if (key == "host")
                db_host = val;
            else if (key == "port")
                db_port = static_cast<uint16_t>(std::stoul(val));
        } else if (section == "network") {
            if (key == "sensor_port")
                sensor_port = static_cast<uint16_t>(std::stoul(val));
            else if (key == "bind_ip")
                bind_ip = val;
        } else if (section == "server_heartbeat") {
            if (key == "interval_ms")
                hb_config.interval_ms = std::stoul(val);
            else if (key == "broadcast_port")
                hb_config.broadcast_port = static_cast<uint16_t>(std::stoul(val));
            else if (key == "broadcast_ip")
                hb_config.broadcast_ip = val;
            else if (key == "send_from_daq_bridge")
                hb_config.send_from_daq_bridge = (val == "true" || val == "1");
        } else if (section == "heartbeat_service") {
            if (key == "enabled" && (val == "true" || val == "1"))
                hb_config.send_from_daq_bridge = false;
        } else if (section.compare(0, 7, "boards.") == 0) {
            if (key == "type")
                board_type_str = val;
            else if (key == "ip")
                board_ip = val;
            else if (key == "num_sensors")
                board_num_sensors = std::stoi(val);
            else if (key == "board_id")
                board_id = std::stoi(val);
            else if (key == "channel_offset")
                board_channel_offset = std::stoi(val);
            else if (key == "enabled")
                board_enabled = (val == "true" || val == "1");
        } else if (section == "sensor_roles_pt_board" || section == "sensor_roles") {
            int channel = 0;
            try {
                channel = std::stoi(val);
            } catch (...) {
                continue;
            }
            if (channel >= 1 && channel <= 10)
                pt_channel_to_name[channel] = to_entity_name(key);
        } else if (section == "sensor_roles_pt2") {
            int connector = 0;
            try {
                connector = std::stoi(val);
            } catch (...) {
                continue;
            }
            int global_ch = connector + 10;
            if (global_ch >= 11 && global_ch <= 14)
                pt_channel_to_name[global_ch] = to_entity_name(key);
        } else if (section == "actuator_roles") {
            size_t comma = val.find(',');
            if (comma == std::string::npos)
                continue;
            try {
                int channel = std::stoi(val.substr(comma + 1));
                size_t second_comma = val.find(',', comma + 1);
                int act_board_id = -1;
                if (second_comma != std::string::npos)
                    act_board_id = std::stoi(val.substr(second_comma + 1));
                int global_ch = channel;
                if (act_board_id == 14)
                    global_ch += 10;
                if (global_ch >= 1 && global_ch <= 20)
                    act_channel_to_name[global_ch] = to_entity_name(key);
            } catch (...) {
            }
        }
    }
    flush_board();
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish allowlist — [routing.*] + [daq_bridge] publish
// ─────────────────────────────────────────────────────────────────────────────

struct PublishRange {
    uint8_t high;
    uint8_t low_max;
};

static std::vector<PublishRange> load_publish_ranges(const std::string& config_path) {
    std::vector<PublishRange> out;
    std::map<std::string, std::pair<uint8_t, int>> routing;
    std::set<std::string> publish_names;
    std::ifstream f(config_path);
    if (!f.is_open())
        return out;

    auto parse_hex = [](const std::string& s) -> int {
        if (s.size() >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
            return static_cast<int>(std::strtoul(s.c_str(), nullptr, 16));
        return static_cast<int>(std::strtoul(s.c_str(), nullptr, 10));
    };

    std::string line, section;
    while (std::getline(f, line)) {
        size_t c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
        while (!line.empty() && (line.back() == ' ' || line.back() == '\r'))
            line.pop_back();
        size_t start = line.find_first_not_of(" \t");
        if (start != std::string::npos)
            line = line.substr(start);
        if (line.empty())
            continue;
        if (line.size() >= 2 && line[0] == '[' && line.back() == ']') {
            section = line.substr(1, line.size() - 2);
            continue;
        }
        size_t eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
            key.pop_back();
        while (!val.empty() && val[0] == ' ')
            val.erase(0, 1);

        if (section.compare(0, 8, "routing.") == 0) {
            std::string rname = section.substr(8);
            if (key == "packet_id") {
                size_t i = val.find('0');
                if (i != std::string::npos) {
                    size_t j = val.find_first_of(",]", i);
                    std::string sub = (j != std::string::npos) ? val.substr(i, j - i) : val.substr(i);
                    int high = parse_hex(sub);
                    if (high >= 0 && high <= 255) {
                        auto& p = routing[rname];
                        p.first = static_cast<uint8_t>(high);
                        if (p.second == 0)
                            p.second = 10;
                    }
                }
            } else if (key == "channels") {
                int ch = parse_hex(val);
                if (ch > 0 && ch <= 255)
                    routing[section.substr(8)].second = ch;
            }
        } else if (section == "daq_bridge" && key == "publish") {
            for (size_t i = 0; i < val.size(); ++i) {
                if (val[i] == '"') {
                    size_t j = val.find('"', i + 1);
                    if (j != std::string::npos) {
                        publish_names.insert(val.substr(i + 1, j - i - 1));
                        i = j;
                    }
                }
            }
        }
    }

    for (const auto& name : publish_names) {
        auto it = routing.find(name);
        if (it != routing.end() && it->second.second > 0)
            out.push_back({it->second.first, static_cast<uint8_t>(std::min(255, it->second.second))});
    }
    return out;
}

static bool is_publish_allowed(uint8_t high, uint8_t low,
                                const std::vector<PublishRange>& ranges) {
    if (low < 0x01)
        return false;
    for (const auto& r : ranges) {
        if (r.high == high && low <= r.low_max)
            return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline message creation helpers
// ─────────────────────────────────────────────────────────────────────────────

static void publish_raw_sensor(fsw::elodin::ElodinClient& client, uint8_t type_hi, uint8_t channel,
                                uint64_t timestamp_ns, uint32_t raw_adc, uint32_t sample_ts_ms,
                                uint8_t status, const std::vector<PublishRange>& ranges) {
    if (!is_publish_allowed(type_hi, channel, ranges))
        return;
    comms::messages::sensor::RawPTMessage msg;
    msg.setField<0>(timestamp_ns);
    msg.setField<1>(channel);
    msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
    msg.setField<3>(raw_adc);
    msg.setField<4>(sample_ts_ms);
    msg.setField<5>(status);
    std::array<uint8_t, 2> pkt_id = {type_hi, channel};
    client.publish(pkt_id, msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════════

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::string bind_address = "0.0.0.0";
    uint16_t bind_port = 5006;

    if (argc > 1)
        config_path = argv[1];
    if (argc > 2)
        bind_address = argv[2];
    if (argc > 3)
        bind_port = static_cast<uint16_t>(std::stoi(argv[3]));

    std::cout << "=== DAQ Bridge ===" << std::endl;
    std::cout << "Config: " << config_path << std::endl;

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // ── Load config ──────────────────────────────────────────────────────────
    std::map<std::string, BoardConfig> board_map;
    BoardOrder board_order;
    std::string db_host;
    uint16_t db_port;
    uint16_t config_sensor_port = 0;
    std::string config_bind_ip;
    ServerHeartbeatConfig hb_config;
    std::map<int, std::string> pt_channel_to_name, act_channel_to_name;

    load_config(config_path, board_map, board_order, db_host, db_port, config_sensor_port,
                config_bind_ip, hb_config, pt_channel_to_name, act_channel_to_name);

    if (config_sensor_port != 0)
        bind_port = config_sensor_port;
    if (!config_bind_ip.empty())
        bind_address = config_bind_ip;

    std::cout << "Listening on: " << bind_address << ":" << bind_port << std::endl;
    std::cout << "Board map (" << board_map.size() << " boards):" << std::endl;
    for (const auto& [ip, cfg] : board_map) {
        const char* t = "?";
        switch (cfg.type) {
            case BoardType::PT: t = "PT"; break;
            case BoardType::LC: t = "LC"; break;
            case BoardType::TC: t = "TC"; break;
            case BoardType::RTD: t = "RTD"; break;
            case BoardType::ACTUATOR: t = "ACT"; break;
            default: break;
        }
        std::cout << "  " << ip << " -> " << t
                  << (cfg.enabled ? "" : " (disabled)") << std::endl;
    }

    // ── Publish allowlist ────────────────────────────────────────────────────
    std::vector<PublishRange> publish_ranges = load_publish_ranges(config_path);

    // ── Open UDP socket ──────────────────────────────────────────────────────
    daq_comms::transport::UDPSocket udp_socket(bind_address, bind_port);
    if (!udp_socket.is_valid()) {
        std::cerr << "Failed to bind UDP socket: " << udp_socket.last_error() << std::endl;
        return 1;
    }
    udp_socket.set_broadcast(true);

    std::vector<uint8_t> recv_buf(8192);

    // ── Connect to Elodin ────────────────────────────────────────────────────
    fsw::elodin::ElodinClient elodin;
    fsw::routing::HeartbeatRouter heartbeat_router(elodin);
    bool elodin_connected = false;

    const std::map<int, std::string>* pt_names =
        pt_channel_to_name.empty() ? nullptr : &pt_channel_to_name;
    const std::map<int, std::string>* act_names =
        act_channel_to_name.empty() ? nullptr : &act_channel_to_name;

    auto register_all_vtables = [&]() {
        fsw::elodin::DatabaseConfig::register_tables(elodin, pt_names, act_names);
        fsw::elodin::DatabaseConfig::register_calibrated_tables(elodin, pt_names);
        fsw::elodin::DatabaseConfig::register_heartbeat_tables(elodin, 64);
        fsw::elodin::DatabaseConfig::register_self_test_tables(elodin, 64);
    };

    auto drain_elodin = [&]() {
        std::array<uint8_t, 4096> drain;
        while (elodin.read_data(drain.data(), drain.size()) > 0) {
        }
    };

    if (elodin.connect(db_host, db_port)) {
        elodin_connected = true;
        register_all_vtables();
        // Drain registration responses
        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
        while (std::chrono::steady_clock::now() < deadline && elodin.is_connected()) {
            drain_elodin();
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        std::cout << "Connected to Elodin at " << db_host << ":" << db_port << std::endl;
    } else {
        std::cerr << "Elodin not available — packets will be parsed but not published" << std::endl;
    }

    std::cout << "\nListening for packets...\n" << std::endl;

    // ── Main loop ────────────────────────────────────────────────────────────
    size_t packet_count = 0;
    size_t publish_count = 0;
    size_t drop_count = 0;
    std::map<std::string, size_t> packets_per_board;
    std::set<std::string> unknown_ips;
    auto last_stats = std::chrono::steady_clock::now();
    auto last_reconnect = std::chrono::steady_clock::now();
    auto last_hb_send = std::chrono::steady_clock::now();

    while (running) {
        auto now = std::chrono::steady_clock::now();

        // ── Broadcast SERVER_HEARTBEAT ───────────────────────────────────────
        if (hb_config.send_from_daq_bridge) {
            auto elapsed_ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(now - last_hb_send).count();
            if (elapsed_ms >= static_cast<int64_t>(hb_config.interval_ms)) {
                auto pkt = build_server_heartbeat_packet();
                ssize_t sent = udp_socket.send_to(hb_config.broadcast_ip, hb_config.broadcast_port,
                                                   pkt.data(), pkt.size());
                if (sent > 0)
                    last_hb_send = now;
            }
        }

        // ── Receive UDP packet ───────────────────────────────────────────────
        std::string source_ip;
        uint16_t source_port = 0;
        ssize_t received =
            udp_socket.receive_from(recv_buf.data(), recv_buf.size(), source_ip, source_port);

        if (received <= 0) {
            // Drain Elodin socket to prevent TCP buffer stall
            if (elodin_connected && elodin.is_connected())
                drain_elodin();

            // Reconnect every 5s if disconnected
            if (elodin_connected && !elodin.is_connected()) {
                auto since =
                    std::chrono::duration_cast<std::chrono::seconds>(now - last_reconnect).count();
                if (since >= 5) {
                    last_reconnect = now;
                    if (elodin.reconnect()) {
                        std::cout << "Reconnected to Elodin — re-registering VTables" << std::endl;
                        register_all_vtables();
                    }
                }
            }

            std::this_thread::sleep_for(std::chrono::microseconds(500));
            continue;
        }

        // ── Parse packet type (first byte of PacketHeader) ─────────────────
        if (received < static_cast<ssize_t>(sizeof(Diablo::PacketHeader)))
            continue;

        Diablo::PacketHeader pkt_header;
        std::memcpy(&pkt_header, recv_buf.data(), sizeof(Diablo::PacketHeader));

        // ── Handle BOARD_HEARTBEAT ───────────────────────────────────────────
        if (pkt_header.packet_type == Diablo::PacketType::BOARD_HEARTBEAT) {
            Diablo::PacketHeader hb_header;
            Diablo::BoardHeartbeatPacket hb_data;
            if (Diablo::parse_board_heartbeat_packet(recv_buf.data(), received, hb_header, hb_data)) {
                // Override board_type from config when firmware omits it
                auto cfg_it = board_map.find(source_ip);
                if (cfg_it != board_map.end() &&
                    hb_data.board_type == Diablo::BoardType::UNKNOWN) {
                    switch (cfg_it->second.type) {
                        case BoardType::PT: hb_data.board_type = Diablo::BoardType::PRESSURE_TRANSDUCER; break;
                        case BoardType::TC: hb_data.board_type = Diablo::BoardType::THERMOCOUPLE; break;
                        case BoardType::RTD: hb_data.board_type = Diablo::BoardType::RTD; break;
                        case BoardType::LC: hb_data.board_type = Diablo::BoardType::LOAD_CELL; break;
                        case BoardType::ACTUATOR: hb_data.board_type = Diablo::BoardType::ACTUATOR; break;
                        case BoardType::ENCODER:
                            // TODO(encoder-daqv2): use Diablo::BoardType::ENCODER when DAQv2-Comms adds it
                            hb_data.board_type = Diablo::BoardType::UNKNOWN;
                            break;
                        default: break;
                    }
                }
                uint64_t hb_ts = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                     std::chrono::steady_clock::now().time_since_epoch())
                                     .count();
                heartbeat_router.process_heartbeat(hb_header, hb_data, hb_ts);
            }
            continue;
        }

        // ── Handle SELF_TEST ─────────────────────────────────────────────────
        if (pkt_header.packet_type == Diablo::PacketType::SELF_TEST) {
            Diablo::PacketHeader st_header;
            std::vector<Diablo::SelfTestResult> st_results;
            if (Diablo::parse_self_test_packet(recv_buf.data(), received, st_header, st_results)) {
                uint8_t board_id = 0;
                auto cfg_it = board_map.find(source_ip);
                if (cfg_it != board_map.end() && cfg_it->second.board_id >= 0)
                    board_id = static_cast<uint8_t>(cfg_it->second.board_id);
                if (board_id == 0 && source_ip.compare(0, 8, "127.0.0.") == 0 && !board_order.empty()) {
                    int idx = (source_ip.size() >= 9) ? (std::atoi(source_ip.c_str() + 8) - 2) : 0;
                    if (idx < 0) idx = 0;
                    if (idx < static_cast<int>(board_order.size()) &&
                        board_order[idx].second.board_id >= 0)
                        board_id = static_cast<uint8_t>(board_order[idx].second.board_id);
                }
                if (board_id != 0 && elodin_connected && elodin.is_connected() && !st_results.empty()) {
                    uint64_t st_ts_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                            std::chrono::system_clock::now().time_since_epoch())
                                            .count();
                    std::array<uint8_t, 2> st_pkt = {0x60, board_id};
                    using SelfTestElodinMsg = comms::CommsMessage<uint64_t, uint8_t, uint8_t>;
                    elodin.begin_batch();
                    for (const auto& res : st_results) {
                        SelfTestElodinMsg msg;
                        msg.setField<0>(st_ts_ns);
                        msg.setField<1>(res.sensor_id);
                        msg.setField<2>(res.result);
                        elodin.publish(st_pkt, msg);
                    }
                    if (elodin.flush_batch()) {
                        publish_count++;
                        drain_elodin();
                    } else {
                        drop_count++;
                    }
                }
            }
            continue;
        }

        // ── Handle SENSOR_DATA ───────────────────────────────────────────────
        if (pkt_header.packet_type != Diablo::PacketType::SENSOR_DATA)
            continue;

        Diablo::PacketHeader sensor_header;
        std::vector<Diablo::SensorDataChunkCollection> chunks;
        if (!Diablo::parse_sensor_data_packet(recv_buf.data(), received, sensor_header, chunks))
            continue;

        packet_count++;
        packets_per_board[source_ip]++;

        // Resolve board type from source IP
        auto board_it = board_map.find(source_ip);
        const BoardConfig* effective_cfg = nullptr;
        if (board_it != board_map.end() && board_it->second.enabled)
            effective_cfg = &board_it->second;
        else if (source_ip.compare(0, 8, "127.0.0.") == 0 && !board_order.empty()) {
            int idx = (source_ip.size() >= 9) ? (std::atoi(source_ip.c_str() + 8) - 2) : 0;
            if (idx < 0) idx = 0;
            if (idx < static_cast<int>(board_order.size()))
                effective_cfg = &board_order[idx].second;
        }

        BoardType board_type = board_it != board_map.end()
                                   ? board_it->second.type
                                   : (effective_cfg ? effective_cfg->type : BoardType::UNKNOWN);
        if (board_type == BoardType::UNKNOWN) {
            if (unknown_ips.find(source_ip) == unknown_ips.end()) {
                unknown_ips.insert(source_ip);
                std::cout << "Unknown board at " << source_ip << " — treating as PT" << std::endl;
            }
            board_type = BoardType::PT;
        }

        int ch_offset = effective_cfg ? effective_cfg->channel_offset : 0;

        // Epoch timestamp for Elodin (matches JS Date.now())
        uint64_t ts_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count();

        bool publishing = elodin_connected && elodin.is_connected();
        if (publishing)
            elodin.begin_batch();

        // ── Create and publish messages directly ─────────────────────────────
        for (const auto& chunk : chunks) {
            for (const auto& dp : chunk.datapoints) {
                uint8_t channel = static_cast<uint8_t>(dp.sensor_id + ch_offset);

                switch (board_type) {
                    case BoardType::PT:
                        if (publishing)
                            publish_raw_sensor(elodin, 0x20, channel, ts_ns, dp.data,
                                               chunk.timestamp, 0, publish_ranges);
                        break;

                    case BoardType::TC:
                        if (publishing)
                            publish_raw_sensor(elodin, 0x21, channel, ts_ns, dp.data,
                                               chunk.timestamp, 0, publish_ranges);
                        break;

                    case BoardType::RTD:
                        if (publishing)
                            publish_raw_sensor(elodin, 0x22, channel, ts_ns, dp.data,
                                               chunk.timestamp, 0, publish_ranges);
                        break;

                    case BoardType::LC:
                        if (publishing)
                            publish_raw_sensor(elodin, 0x23, channel, ts_ns, dp.data,
                                               chunk.timestamp, 0, publish_ranges);
                        break;

                    case BoardType::ACTUATOR: {
                        if (publishing) {
                            publish_raw_sensor(elodin, 0x30, channel, ts_ns, dp.data,
                                               chunk.timestamp, 0, publish_ranges);
                            // Actuator state (0=closed, 1=open)
                            constexpr uint32_t ACT_THRESHOLD = 1500;
                            if (is_publish_allowed(0x31, channel, publish_ranges)) {
                                comms::messages::sensor::ActuatorStateMessage state_msg;
                                state_msg.setField<0>(ts_ns);
                                state_msg.setField<1>(channel);
                                state_msg.setField<2>(dp.data > ACT_THRESHOLD ? 1 : 0);
                                std::array<uint8_t, 2> state_pkt = {0x31, channel};
                                elodin.publish(state_pkt, state_msg);
                            }
                        }
                        break;
                    }

                    case BoardType::ENCODER:
                        if (publishing)
                            publish_raw_sensor(elodin, 0x24, channel, ts_ns, dp.data, chunk.timestamp, 0,
                                               publish_ranges);
                        break;

                    default:
                        break;
                }
            }
        }

        // ── Flush batch ──────────────────────────────────────────────────────
        if (publishing) {
            if (elodin.flush_batch())
                publish_count++;
            else
                drop_count++;
            drain_elodin();
        }

        // ── Stats (every 2s) ─────────────────────────────────────────────────
        auto elapsed = std::chrono::steady_clock::now() - last_stats;
        if (std::chrono::duration_cast<std::chrono::seconds>(elapsed).count() >= 2) {
            last_stats = std::chrono::steady_clock::now();
            std::cout << "[Stats] " << packet_count << " pkts";
            for (const auto& [ip, cnt] : packets_per_board) {
                auto it = board_map.find(ip);
                const char* tag = "?";
                if (it != board_map.end()) {
                    switch (it->second.type) {
                        case BoardType::PT: tag = "PT"; break;
                        case BoardType::LC: tag = "LC"; break;
                        case BoardType::TC: tag = "TC"; break;
                        case BoardType::RTD: tag = "RTD"; break;
                        case BoardType::ACTUATOR: tag = "ACT"; break;
                        case BoardType::ENCODER: tag = "ENC"; break;
                        default: break;
                    }
                }
                std::cout << " | " << tag << "(" << ip << "):" << cnt;
            }
            if (elodin_connected && elodin.is_connected())
                std::cout << " | DB: " << publish_count << "ok/" << drop_count << "drop";
            else if (elodin_connected)
                std::cout << " | DB: disconnected";
            else
                std::cout << " | DB: off";
            std::cout << std::endl;
        }
    }

    std::cout << "[DAQ Bridge] Shutdown complete" << std::endl;
    return 0;
}
