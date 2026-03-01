#include <signal.h>

#include <array>
#include <atomic>
#include <chrono>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "../../daq_comms/include/comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "../../daq_comms/include/comms/messages/sensor/SensorMessages.hpp"
#include "../../daq_comms/include/protocol/DiabloBoardPacketParser.hpp"
#include "calibration/PTCalibration.hpp"
#include "calibration/SensorCalibration.hpp"
#include "config/BoardDiscovery.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "fsw/FSWConfigManager.hpp"
#include "routing/SensorRouter.hpp"
#include "streams/SensorFramePipeline.hpp"

std::atomic<bool> running(true);

void signal_handler(int /* sig */) {
    running = false;
    std::cout << "\n[DAQ Bridge] Shutting down..." << std::endl;
}

// Board type enum (matches DiabloAvionics)
enum class BoardType { PT, LC, TC, RTD, ACTUATOR, UNKNOWN };

struct BoardConfig {
    BoardType type;
    std::string ip;
    int num_sensors;
    bool enabled;
    int board_id; // Added board_id
};

// Minimal config parse: [database] host/port, [network] sensor_port/bind_ip, [boards.xxx]
// type/ip/enabled
static void load_board_map_from_config(const std::string& config_path,
                                       std::map<std::string, BoardConfig>& board_map,
                                       std::string& db_host, uint16_t& db_port,
                                       uint16_t* out_sensor_port = nullptr,
                                       std::string* out_bind_ip = nullptr) {
    db_host = "127.0.0.1";
    db_port = 2240;
    std::ifstream f(config_path);
    if (!f.is_open())
        return;
    std::string line, current_section;
    std::string board_type_str, board_ip;
    int board_num_sensors = 10;
    int board_id = -1; // Added board_id
    bool board_enabled = true;
    auto add_board = [&]() {
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
        if (bt != BoardType::UNKNOWN)
            board_map[board_ip] = {bt, board_ip, board_num_sensors, board_enabled, board_id};
        board_ip.clear();
        board_type_str.clear();
        board_id = -1; // Reset board_id
    };
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
            add_board();
            current_section = line.substr(1, line.size() - 2);
            board_num_sensors = 10;
            board_id = -1; // Reset board_id for new section
            board_enabled = true;
            continue;
        }
        size_t eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
            key.pop_back();
        while (!val.empty() && (val[0] == ' ' || val[0] == '\t'))
            val.erase(0, 1);
        if (val.size() >= 2 && val.front() == '"' && val.back() == '"')
            val = val.substr(1, val.size() - 2);
        if (current_section == "database") {
            if (key == "host")
                db_host = val;
            else if (key == "port")
                db_port = static_cast<uint16_t>(std::stoul(val));
        } else if (current_section == "network") {
            if (out_sensor_port && key == "sensor_port")
                *out_sensor_port = static_cast<uint16_t>(std::stoul(val));
            else if (out_bind_ip && key == "bind_ip")
                *out_bind_ip = val;
        } else if (current_section.compare(0, 7, "boards.") == 0) {
            if (key == "type")
                board_type_str = val;
            else if (key == "ip")
                board_ip = val;
            else if (key == "num_sensors")
                board_num_sensors = std::stoi(val);
            else if (key == "board_id")
                board_id = std::stoi(val); // Parse board_id
            else if (key == "enabled")
                board_enabled = (val == "true" || val == "1");
        }
    }
    add_board();
    // Simulator (e.g. board_simulator.py) sends from 127.0.0.1 — treat as PT so routing works
    if (board_map.find("127.0.0.1") == board_map.end())
        board_map["127.0.0.1"] = {BoardType::PT, "127.0.0.1", 10, true, 0};
}

// Config-driven publish allowlist: [routing.*] packet_id + channels, [daq_bridge] publish = [...]
// Emulates backend (server.ts) loading mapping from config; no fixed hex codes in code.
struct PublishRange {
    uint8_t high;
    uint8_t low_max;  // allow low byte 0x01 .. low_max (1-based channel count)
};
static std::vector<PublishRange> load_publish_ranges(const std::string& config_path) {
    std::vector<PublishRange> out;
    std::map<std::string, std::pair<uint8_t, int>> routing;  // name -> (high, channels)
    std::set<std::string> publish_names;
    std::ifstream f(config_path);
    if (!f.is_open())
        return out;
    std::string line, current_section;
    auto parse_hex_byte = [](const std::string& s) -> int {
        if (s.size() >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
            return static_cast<int>(std::strtoul(s.c_str(), nullptr, 16));
        }
        return static_cast<int>(std::strtoul(s.c_str(), nullptr, 10));
    };
    auto parse_array_first_byte = [&parse_hex_byte](const std::string& val) -> int {
        size_t i = val.find('0');
        if (i == std::string::npos)
            return -1;
        size_t j = val.find_first_of(",]", i);
        std::string sub = (j != std::string::npos) ? val.substr(i, j - i) : val.substr(i);
        return parse_hex_byte(sub);
    };
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
            current_section = line.substr(1, line.size() - 2);
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
        if (current_section.compare(0, 8, "routing.") == 0) {
            std::string rname = current_section.substr(8);
            if (key == "packet_id") {
                int high = parse_array_first_byte(val);
                if (high >= 0 && high <= 255) {
                    auto& p = routing[rname];
                    p.first = static_cast<uint8_t>(high);
                    if (p.second == 0)
                        p.second = 10;
                }
            } else if (key == "channels") {
                int ch = parse_hex_byte(val);
                if (ch > 0 && ch <= 255)
                    routing[current_section.substr(8)].second = ch;
            }
        } else if (current_section == "daq_bridge" && key == "publish") {
            // Parse ["pt_raw", "actuator_status"] - extract quoted tokens
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
        if (it != routing.end() && it->second.second > 0) {
            uint8_t low_max = static_cast<uint8_t>(std::min(255, it->second.second));
            out.push_back({it->second.first, low_max});
        }
    }
    return out;
}
static bool is_publish_allowed(uint8_t high, uint8_t low, const std::vector<PublishRange>& ranges) {
    if (low < 0x01)
        return false;
    for (const auto& r : ranges) {
        if (r.high == high && low <= r.low_max)
            return true;
    }
    return false;
}

// Load channel → name from config.toml [sensor_roles*] and [actuator_roles] so DB matches backend.
static void load_sensor_and_actuator_maps(const std::string& config_path,
                                          std::map<int, std::string>& pt_channel_to_name,
                                          std::map<int, std::string>& act_channel_to_name) {
    std::ifstream f(config_path);
    if (!f.is_open())
        return;
    std::string line, current_section;
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
            current_section = line.substr(1, line.size() - 2);
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
        auto to_entity_name = [](std::string s) {
            if (s.size() >= 2 && s.front() == '"' && s.back() == '"')
                s = s.substr(1, s.size() - 2);
            for (size_t i = 0; i < s.size(); ++i)
                if (s[i] == ' ')
                    s[i] = '_';
            return s;
        };
        if (current_section == "sensor_roles_pt_board" || current_section == "sensor_roles") {
            int channel = 0;
            try {
                channel = std::stoi(val);
            } catch (...) {
                continue;
            }
            if (channel >= 1 && channel <= 10)
                pt_channel_to_name[channel] = to_entity_name(key);
        } else if (current_section == "sensor_roles_pt2") {
            // PT board 2 connectors are globally offset by +10 (connector 1 → global channel 11)
            int connector = 0;
            try {
                connector = std::stoi(val);
            } catch (...) {
                continue;
            }
            int global_ch = connector + 10;
            if (global_ch >= 11 && global_ch <= 14)
                pt_channel_to_name[global_ch] = to_entity_name(key);
        } else if (current_section == "actuator_roles") {
            size_t comma = val.find(',');
            if (comma == std::string::npos)
                continue;
            try {
                int channel = std::stoi(val.substr(comma + 1));
                if (channel >= 1 && channel <= 10)
                    act_channel_to_name[channel] = to_entity_name(key);
            } catch (...) {
            }
        }
    }
}

// Map discovery signature board_type (DiabloAvionics enum 1=PT,2=TC,3=RTD,4=LC,5=ACTUATOR) to our
// BoardType
static BoardType discovery_board_type_to_enum(uint8_t t) {
    switch (t) {
        case 1:
            return BoardType::PT;
        case 2:
            return BoardType::TC;
        case 3:
            return BoardType::RTD;
        case 4:
            return BoardType::LC;
        case 5:
            return BoardType::ACTUATOR;
        default:
            return BoardType::UNKNOWN;
    }
}

int main(int argc, char* argv[]) {
    // Parse command line arguments
    std::string config_path = "config/config.toml";
    std::string bind_address = "0.0.0.0";
    uint16_t bind_port = 5006;  // DiabloAvionics default sensor port

    if (argc > 1)
        config_path = argv[1];
    if (argc > 2)
        bind_address = argv[2];
    if (argc > 3)
        bind_port = static_cast<uint16_t>(std::stoi(argv[3]));

    std::cout << "=== DAQ Bridge - DiabloAvionics Packet Receiver ===" << std::endl;
    std::cout << "Config: " << config_path << std::endl;
    std::cout << "Listening on: " << bind_address << ":" << bind_port << std::endl;
    std::cout << std::endl;

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // ── Board IP → Type mapping from config ([boards.*]), DB host/port, network sensor_port ──
    std::map<std::string, BoardConfig> board_map;
    std::string db_host;
    uint16_t db_port;
    uint16_t config_sensor_port = 0;
    std::string config_bind_ip;
    load_board_map_from_config(config_path, board_map, db_host, db_port, &config_sensor_port,
                               &config_bind_ip);
    if (config_sensor_port != 0)
        bind_port = config_sensor_port;
    if (!config_bind_ip.empty())
        bind_address = config_bind_ip;

    std::cout << "[Config] Board routing table (from " << config_path << "):" << std::endl;
    for (const auto& [ip, cfg] : board_map) {
        const char* type_str = "UNKNOWN";
        switch (cfg.type) {
            case BoardType::PT:
                type_str = "PT";
                break;
            case BoardType::LC:
                type_str = "LC";
                break;
            case BoardType::TC:
                type_str = "TC";
                break;
            case BoardType::RTD:
                type_str = "RTD";
                break;
            case BoardType::ACTUATOR:
                type_str = "ACTUATOR";
                break;
            default:
                break;
        }
        std::cout << "  " << ip << " → " << type_str << " (" << cfg.num_sensors << " sensors)"
                  << (cfg.enabled ? " ✅" : " ❌") << std::endl;
    }

    // ── System mode ──
    bool is_flight_daq = (config_path.find("flight") != std::string::npos);
    fsw::config::SystemState system_state =
        is_flight_daq ? fsw::config::SystemState::FLIGHT : fsw::config::SystemState::GSE;
    std::cout << "[System] Mode: " << (is_flight_daq ? "FLIGHT" : "GROUND") << std::endl;

    // ── Publish allowlist from config [routing.*] + [daq_bridge] publish (modular, no fixed hexes)
    std::vector<PublishRange> publish_ranges = load_publish_ranges(config_path);
    std::cout << "[Config] Publish to DB (from config):";
    for (const auto& r : publish_ranges)
        std::cout << " 0x" << std::hex << (int)r.high << std::dec << "/1.." << (int)r.low_max;
    std::cout << std::endl;

    // ── FSW Config Manager ──
    std::cout << "[FSW] Initializing configuration manager..." << std::endl;
    auto fsw_config = std::make_unique<fsw::fsw::FSWConfigManager>();
    if (!fsw_config->initialize("0.0.0.0", 5008)) {
        std::cerr << "❌ Failed to initialize FSW config manager" << std::endl;
        return 1;
    }
    fsw_config->set_system_state(system_state);
    
    // Add static IPs to FSW config manager
    for (const auto& [ip, cfg] : board_map) {
        if (cfg.board_id >= 0) {
            fsw_config->set_board_static_ip(cfg.board_id, ip);
        }
    }

    // ── Board Discovery ──
    fsw::config::BoardDiscovery discovery;
    fsw::config::DynamicConfigManager config_manager;
    std::string network_interface = "eth0";
    std::string target_subnet = is_flight_daq ? "192.168.3." : "192.168.2.";

    std::string cmd = "ip -4 addr show | grep -B 2 'inet.*" + target_subnet +
                      "' | grep -E '^[0-9]+:' | head -1 | awk -F: '{print $2}' | tr -d ' '";
    FILE* fp = popen(cmd.c_str(), "r");
    if (fp) {
        char iface[64] = {0};
        if (fgets(iface, sizeof(iface), fp)) {
            size_t len = strlen(iface);
            if (len > 0 && iface[len - 1] == '\n')
                iface[len - 1] = '\0';
            if (strlen(iface) > 0)
                network_interface = iface;
        }
        pclose(fp);
    }
    std::cout << "[Discovery] Interface: " << network_interface << std::endl;

    std::string base_ip = is_flight_daq ? "192.168.3.0" : "192.168.2.0";
    discovery.initialize(network_interface, base_ip, 100, 150);
    discovery.start_discovery(fsw::config::BoardDiscovery::DiscoveryMode::HYBRID);
    config_manager.load_base_config(config_path);

    // ── Sensor Pipeline ──
    fsw::streams::SensorFramePipeline pipeline(bind_address, bind_port);
    if (!pipeline.is_ready()) {
        std::cerr << "❌ Failed to initialize sensor pipeline: " << pipeline.last_error()
                  << std::endl;
        return 1;
    }
    std::cout << "✅ Sensor pipeline ready on port " << bind_port << std::endl;

    // ── Calibration Managers ──
    fsw::calibration::PTCalibrationManager pt_calibration;
    std::cout << "[Calibration] PT:  " << pt_calibration.get_calibrated_count() << " channels"
              << std::endl;

    fsw::calibration::SensorCalibrationManager tc_calibration("TC", "°C", 3);
    tc_calibration.load_calibration(
        "scripts/calibration/calibrations/tc",
        "external/DiabloAvionics/TC_Board/Calibration/tc_calibration.csv");
    std::cout << "[Calibration] TC:  " << tc_calibration.calibrated_count() << " channels"
              << std::endl;

    fsw::calibration::SensorCalibrationManager rtd_calibration("RTD", "°C", 3);
    rtd_calibration.load_calibration(
        "scripts/calibration/calibrations/rtd",
        "external/DiabloAvionics/RTD_Board/Calibration/rtd_calibration.csv");
    std::cout << "[Calibration] RTD: " << rtd_calibration.calibrated_count() << " channels"
              << std::endl;

    fsw::calibration::SensorCalibrationManager lc_calibration("LC", "lbf", 3);
    lc_calibration.load_calibration(
        "scripts/calibration/calibrations/lc",
        "external/DiabloAvionics/LC_Board/Calibration/lc_calibration.csv");
    std::cout << "[Calibration] LC:  " << lc_calibration.calibrated_count() << " channels"
              << std::endl;

    // ── Sensor Router ──
    fsw::routing::SensorRouter router;
    router.set_pt_calibration(&pt_calibration);
    router.set_tc_calibration(&tc_calibration);
    router.set_rtd_calibration(&rtd_calibration);
    router.set_lc_calibration(&lc_calibration);
    std::cout << "✅ Sensor router initialized" << std::endl;

    // ── Elodin Client (host/port from config [database]) ──
    fsw::elodin::ElodinClient elodin_client;
    bool elodin_connected = false;
    std::map<int, std::string> pt_channel_to_name, act_channel_to_name;
    load_sensor_and_actuator_maps(config_path, pt_channel_to_name, act_channel_to_name);
    const std::map<int, std::string>* pt_names =
        pt_channel_to_name.empty() ? nullptr : &pt_channel_to_name;
    const std::map<int, std::string>* act_names =
        act_channel_to_name.empty() ? nullptr : &act_channel_to_name;

    if (elodin_client.connect(db_host, db_port)) {
        elodin_connected = true;
        std::cout << "✅ Connected to Elodin database" << std::endl;
        // Register VTables with config-driven names so DB is a replica of backend
        if (!fsw::elodin::DatabaseConfig::register_tables(elodin_client, pt_names, act_names)) {
            std::cerr << "⚠️  VTable registration failed — editor may not display data" << std::endl;
        }
        // Drain any response from DB after registration; otherwise recv buffer fills and TABLE
        // writes stall after ~3s
        std::array<uint8_t, 4096> drain_buf;
        auto drain_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
        while (std::chrono::steady_clock::now() < drain_deadline && elodin_client.is_connected()) {
            while (elodin_client.read_data(drain_buf.data(), drain_buf.size()) > 0) {
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        std::cout << "[Elodin] Drain complete, ready for TABLE data" << std::endl;
    } else {
        std::cerr << "⚠️  Elodin not connected (packets will be parsed but not published)"
                  << std::endl;
    }

    std::cout << "\n📡 Listening for DiabloAvionics packets...\n" << std::endl;

    // ── Main Loop ──
    size_t packet_count = 0;
    size_t elodin_publish_count = 0;
    size_t elodin_drop_count = 0;
    std::map<std::string, size_t> packets_per_board;  // IP → count
    std::set<std::string> unknown_ips;
    auto last_stats_time = std::chrono::steady_clock::now();
    auto last_reconnect_time = std::chrono::steady_clock::now();

    while (running) {
        auto batch = pipeline.poll();
        if (!batch.has_value()) {
            // When last packet was a BOARD_HEARTBEAT, run discovery and broadcast config to that
            // board
            auto hb = pipeline.get_last_heartbeat();
            if (hb) {
                discovery.process_board_announcement(hb->data.data(), hb->data.size(),
                                                     hb->source_ip);
                auto parsed =
                    pipeline.get_parser().parse_board_heartbeat(hb->data.data(), hb->data.size());
                if (parsed && parsed->is_valid) {
                    // MAC for FSWConfigManager (same formula as BoardDiscovery)
                    std::hash<std::string> hasher;
                    uint32_t ip_hash = static_cast<uint32_t>(hasher(hb->source_ip));
                    uint32_t sig_id = (static_cast<uint32_t>(parsed->heartbeat.board_type) << 8) |
                                      parsed->heartbeat.board_id;
                    std::ostringstream mac;
                    mac << std::hex << std::setw(2) << std::setfill('0') << ((ip_hash >> 16) & 0xFF)
                        << ":" << std::setw(2) << ((ip_hash >> 8) & 0xFF) << ":" << std::setw(2)
                        << (ip_hash & 0xFF) << ":" << std::setw(2) << ((ip_hash >> 24) & 0xFF)
                        << ":" << std::setw(2) << ((sig_id >> 8) & 0xFF) << ":" << std::setw(2)
                        << (sig_id & 0xFF);
                    fsw_config->process_board_heartbeat(*parsed, hb->source_ip, mac.str());
                }
            }

            std::this_thread::sleep_for(std::chrono::microseconds(500));

            // Drain Elodin socket: we only write TABLE packets; if the DB sends anything back
            // (acks, errors, etc.) and we never read, the TCP recv buffer fills and the connection
            // stalls after ~10–20s. Non-blocking read and discard keeps the connection alive.
            if (elodin_connected && elodin_client.is_connected()) {
                std::array<uint8_t, 4096> drain_buf;
                while (elodin_client.read_data(drain_buf.data(), drain_buf.size()) > 0) {
                    /* discard */
                }
            }

            // Try reconnect every 5 seconds if disconnected
            if (elodin_connected && !elodin_client.is_connected()) {
                auto since = std::chrono::steady_clock::now() - last_reconnect_time;
                if (std::chrono::duration_cast<std::chrono::seconds>(since).count() >= 5) {
                    last_reconnect_time = std::chrono::steady_clock::now();
                    if (elodin_client.reconnect()) {
                        std::cout << "✅ Reconnected to Elodin — re-registering VTables"
                                  << std::endl;
                        fsw::elodin::DatabaseConfig::register_tables(elodin_client, pt_names,
                                                                     act_names);
                    }
                }
            }
            continue;
        }

        packet_count++;
        const std::string& source_ip = pipeline.last_source_ip();
        packets_per_board[source_ip]++;

        auto now = std::chrono::steady_clock::now();
        uint64_t receive_timestamp_ns =
            std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch()).count();

        // ── Route based on source IP → board type (config, then discovery, else treat as PT so DB
        // gets data) ──
        auto board_it = board_map.find(source_ip);
        BoardType board_type = BoardType::UNKNOWN;
        if (board_it != board_map.end() && board_it->second.enabled) {
            board_type = board_it->second.type;
        } else {
            auto discovered = discovery.get_board_by_ip(source_ip);
            if (discovered) {
                board_type = discovery_board_type_to_enum(discovered->signature.board_type);
                if (board_type != BoardType::UNKNOWN)
                    board_map[source_ip] = {board_type, source_ip, 10, true};
            }
            if (board_type == BoardType::UNKNOWN) {
                if (unknown_ips.find(source_ip) == unknown_ips.end()) {
                    unknown_ips.insert(source_ip);
                    std::cout << "[Discovery] Unknown board at " << source_ip
                              << " — treating as PT so data is written to DB" << std::endl;
                }
                board_type = BoardType::PT;
            }
        }

        // ── Begin batch: all publishes from this packet go into one buffer ──
        bool publishing = elodin_connected && elodin_client.is_connected();
        if (publishing)
            elodin_client.begin_batch();

        switch (board_type) {
            case BoardType::PT: {
                auto pt_msgs = router.route_pt_samples(batch.value(), receive_timestamp_ns);
                auto cal_msgs =
                    router.route_pt_samples_calibrated(batch.value(), receive_timestamp_ns);
                if (publishing) {
                    for (const auto& [id, msg] : pt_msgs)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : cal_msgs)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                }
                break;
            }
            case BoardType::ACTUATOR: {
                for (const auto& sample : batch.value().pt_samples) {
                    std::array<uint8_t, 2> act_pkt = {0x30, static_cast<uint8_t>(sample.channel_id + 1)};
                    comms::messages::sensor::RawPTMessage msg;
                    msg.setField<0>(receive_timestamp_ns);
                    msg.setField<1>(static_cast<uint8_t>(sample.channel_id + 1));
                    msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                    msg.setField<3>(sample.raw_adc_counts);
                    msg.setField<4>(sample.sample_timestamp_ms);
                    msg.setField<5>(sample.status_flags);
                    if (publishing && is_publish_allowed(act_pkt[0], act_pkt[1], publish_ranges))
                        elodin_client.publish(act_pkt, msg);
                }
                break;
            }
            case BoardType::LC: {
                daq_comms::protocol::SensorBatch lc_batch = batch.value();
                lc_batch.lc_samples.clear();
                for (const auto& s : lc_batch.pt_samples) {
                    daq_comms::protocol::RawLCSample lc;
                    lc.channel_id = s.channel_id;
                    lc.raw_adc_counts = s.raw_adc_counts;
                    lc.sample_timestamp_ms = s.sample_timestamp_ms;
                    lc.status_flags = s.status_flags;
                    lc_batch.lc_samples.push_back(lc);
                }
                lc_batch.pt_samples.clear();
                auto lc_raw = router.route_lc_samples(lc_batch, receive_timestamp_ns);
                auto lc_cal = router.route_lc_samples_calibrated(lc_batch, receive_timestamp_ns);
                if (publishing) {
                    for (const auto& [id, msg] : lc_raw)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : lc_cal)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                }
                break;
            }
            case BoardType::TC: {
                daq_comms::protocol::SensorBatch tc_batch = batch.value();
                tc_batch.tc_samples.clear();
                for (const auto& s : tc_batch.pt_samples) {
                    daq_comms::protocol::RawTCSample tc;
                    tc.channel_id = s.channel_id;
                    tc.raw_adc_counts = s.raw_adc_counts;
                    tc.sample_timestamp_ms = s.sample_timestamp_ms;
                    tc.status_flags = s.status_flags;
                    tc_batch.tc_samples.push_back(tc);
                }
                tc_batch.pt_samples.clear();
                auto tc_raw = router.route_tc_samples(tc_batch, receive_timestamp_ns);
                auto tc_cal = router.route_tc_samples_calibrated(tc_batch, receive_timestamp_ns);
                if (publishing) {
                    for (const auto& [id, msg] : tc_raw)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : tc_cal)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                }
                break;
            }
            case BoardType::RTD: {
                daq_comms::protocol::SensorBatch rtd_batch = batch.value();
                rtd_batch.rtd_samples.clear();
                for (const auto& s : rtd_batch.pt_samples) {
                    daq_comms::protocol::RawRTDSample rtd;
                    rtd.channel_id = s.channel_id;
                    rtd.raw_resistance_counts = s.raw_adc_counts;
                    rtd.sample_timestamp_ms = s.sample_timestamp_ms;
                    rtd.status_flags = s.status_flags;
                    rtd_batch.rtd_samples.push_back(rtd);
                }
                rtd_batch.pt_samples.clear();
                auto rtd_raw = router.route_rtd_samples(rtd_batch, receive_timestamp_ns);
                auto rtd_cal = router.route_rtd_samples_calibrated(rtd_batch, receive_timestamp_ns);
                if (publishing) {
                    for (const auto& [id, msg] : rtd_raw)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : rtd_cal)
                        if (is_publish_allowed(id[0], id[1], publish_ranges))
                            elodin_client.publish(id, msg);
                }
                break;
            }
            default:
                break;
        }

        // ── Flush entire batch as one TCP write ──
        if (publishing) {
            if (elodin_client.flush_batch()) {
                elodin_publish_count++;
            } else {
                elodin_drop_count++;
            }
            // Drain any response from DB so recv buffer doesn't fill and stall the connection
            std::array<uint8_t, 4096> drain_buf;
            while (elodin_client.read_data(drain_buf.data(), drain_buf.size()) > 0) {
            }
        }

        // ── Periodic stats (every 2 seconds) ──
        auto elapsed = std::chrono::steady_clock::now() - last_stats_time;
        if (std::chrono::duration_cast<std::chrono::seconds>(elapsed).count() >= 2) {
            last_stats_time = std::chrono::steady_clock::now();

            std::cout << "\n[Stats] Total: " << packet_count << " pkts";
            for (const auto& [ip, cnt] : packets_per_board) {
                auto it = board_map.find(ip);
                const char* tag = "???";
                if (it != board_map.end()) {
                    switch (it->second.type) {
                        case BoardType::PT:
                            tag = "PT";
                            break;
                        case BoardType::LC:
                            tag = "LC";
                            break;
                        case BoardType::TC:
                            tag = "TC";
                            break;
                        case BoardType::RTD:
                            tag = "RTD";
                            break;
                        case BoardType::ACTUATOR:
                            tag = "ACT";
                            break;
                        default:
                            break;
                    }
                }
                std::cout << " | " << tag << "(" << ip << "):" << cnt;
            }
            if (elodin_connected && elodin_client.is_connected())
                std::cout << " | DB: ✅ " << elodin_publish_count << "ok/" << elodin_drop_count
                          << "drop";
            else if (elodin_connected)
                std::cout << " | DB: ⚠️  disconnected (reconnecting)";
            else
                std::cout << " | DB: ❌";
            std::cout << std::endl;

            // Print calibrated PT values if we have PT data
            if (board_type == BoardType::PT && !batch.value().pt_samples.empty()) {
                std::cout << "[PT Cal] ";
                for (const auto& sample : batch.value().pt_samples) {
                    int32_t adc_code = static_cast<int32_t>(sample.raw_adc_counts);
                    double psi = pt_calibration.calculate_pressure(sample.channel_id, adc_code);
                    bool cal = pt_calibration.is_calibrated(sample.channel_id);
                    std::cout << "CH" << (int)sample.channel_id << ":" << (cal ? "" : "~")
                              << std::fixed << std::setprecision(1) << psi << "psi ";
                }
                std::cout << std::endl;
            }
        }
    }

    // Shutdown
    auto boards = discovery.get_discovered_boards();
    config_manager.update_with_boards(boards);
    config_manager.save_config(config_path + ".auto");
    std::cout << "[Discovery] Found " << boards.size() << " boards" << std::endl;
    std::cout << "[DAQ Bridge] Shutdown complete" << std::endl;
    return 0;
}
