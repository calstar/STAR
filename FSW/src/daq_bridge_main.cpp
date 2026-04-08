#include <signal.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
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

#include "../../daq_comms/include/comms/messages/board/BoardHeartbeatMessage.hpp"
#include "../../daq_comms/include/comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "../../daq_comms/include/comms/messages/sensor/SensorMessages.hpp"
#include "DAQv2-Comms.h"
#include "fsw/BoardTypeWire.hpp"

namespace {
constexpr uint8_t SERVER_HEARTBEAT_PACKET_TYPE = 2;

std::vector<uint8_t> build_server_heartbeat_packet() {
    std::vector<uint8_t> pkt(7);
    uint32_t ts = static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                            std::chrono::steady_clock::now().time_since_epoch())
                                            .count() &
                                        0xFFFFFFFF);
    pkt[0] = SERVER_HEARTBEAT_PACKET_TYPE;
    pkt[1] = DIABLO_COMMS_VERSION;
    pkt[2] = static_cast<uint8_t>(ts & 0xFF);
    pkt[3] = static_cast<uint8_t>((ts >> 8) & 0xFF);
    pkt[4] = static_cast<uint8_t>((ts >> 16) & 0xFF);
    pkt[5] = static_cast<uint8_t>((ts >> 24) & 0xFF);
    pkt[6] = 0;  // engine_state = SAFE
    return pkt;
}
}  // namespace
#include "calibration/PTCalibration.hpp"
#include "calibration/SensorCalibration.hpp"
#include "config/BoardDiscovery.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "fsw/FSWConfigManager.hpp"
#include "routing/HeartbeatRouter.hpp"
#include "routing/SensorRouter.hpp"
#include "streams/SensorFramePipeline.hpp"

std::atomic<bool> running(true);

void signal_handler(int /* sig */) {
    running = false;
    std::cout << "\n[DAQ Bridge] Shutting down..." << std::endl;
}

// Board type enum (matches DiabloAvionics)
enum class BoardType { PT, LC, TC, RTD, ACTUATOR, ENCODER, UNKNOWN };

struct BoardConfig {
    BoardType type;
    std::string ip;
    int num_sensors;
    bool enabled;
    int board_id;  // Added board_id
};

struct ServerHeartbeatConfig {
    uint32_t interval_ms = 1000;
    uint16_t broadcast_port = 5005;
    std::string broadcast_ip = "255.255.255.255";
    bool send_from_daq_bridge = true;  // false when heartbeat_service is used
};

// Ordered list of (ip, config) for enabled boards in parse order. Used when board_simulator
// falls back to 127.0.0.2, 127.0.0.3, ... so each simulated board gets correct board_id.
using BoardOrder = std::vector<std::pair<std::string, BoardConfig>>;

// Minimal config parse: [database] host/port, [network] sensor_port/bind_ip, [server_heartbeat],
// [boards.xxx] type/ip/enabled
static void load_board_map_from_config(const std::string& config_path,
                                       std::map<std::string, BoardConfig>& board_map,
                                       BoardOrder* out_board_order, std::string& db_host,
                                       uint16_t& db_port, uint16_t* out_sensor_port = nullptr,
                                       std::string* out_bind_ip = nullptr,
                                       ServerHeartbeatConfig* out_hb = nullptr) {
    db_host = "127.0.0.1";
    db_port = 2240;
    std::ifstream f(config_path);
    if (!f.is_open())
        return;
    std::string line, current_section;
    std::string board_type_str, board_ip;
    int board_num_sensors = 10;
    int board_id = -1;  // Added board_id
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
        else if (board_type_str == "ENCODER")
            bt = BoardType::ENCODER;
        if (bt != BoardType::UNKNOWN) {
            BoardConfig cfg{bt, board_ip, board_num_sensors, board_enabled, board_id};
            board_map[board_ip] = cfg;
            if (out_board_order && board_enabled)
                out_board_order->emplace_back(board_ip, std::move(cfg));
        }
        board_ip.clear();
        board_type_str.clear();
        board_id = -1;
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
            board_id = -1;
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
        } else if (current_section == "server_heartbeat" && out_hb) {
            if (key == "interval_ms")
                out_hb->interval_ms = std::stoul(val);
            else if (key == "broadcast_port")
                out_hb->broadcast_port = static_cast<uint16_t>(std::stoul(val));
            else if (key == "broadcast_ip")
                out_hb->broadcast_ip = val;
            else if (key == "send_from_daq_bridge")
                out_hb->send_from_daq_bridge = (val == "true" || val == "1");
        } else if (current_section == "heartbeat_service" && out_hb) {
            if (key == "enabled" && (val == "true" || val == "1"))
                out_hb->send_from_daq_bridge = false;  // heartbeat_service owns it
        } else if (current_section.compare(0, 7, "boards.") == 0) {
            if (key == "type")
                board_type_str = val;
            else if (key == "ip")
                board_ip = val;
            else if (key == "num_sensors")
                board_num_sensors = std::stoi(val);
            else if (key == "board_id")
                board_id = std::stoi(val);  // Parse board_id
            else if (key == "enabled")
                board_enabled = (val == "true" || val == "1");
        }
    }
    add_board();
    // NOTE: do NOT add 127.0.0.1→PT. When simulator can't bind to config IPs, it uses
    // 127.0.0.2, 127.0.0.3, ... (one per board). board_order maps index→config for that fallback.
}

// Collect active boards with their local channels per sensor type from config.toml [boards.*].
// Returns a map from BoardType to a vector of BoardChannels (one per enabled board).
// No channel_offset — channels are local connector IDs (1-10).
using BoardChannels = fsw::elodin::BoardChannels;

static std::map<BoardType, std::vector<BoardChannels>> load_active_boards(
    const std::string& config_path) {
    std::map<BoardType, std::vector<BoardChannels>> result;

    std::ifstream f(config_path);
    if (!f.is_open())
        return result;

    std::string line, section;
    std::string board_type_str;
    int board_id = -1;
    bool board_enabled = true;
    std::vector<uint8_t> active_conn;
    int num_sensors = 10;

    auto flush = [&]() {
        if (board_type_str.empty() || !board_enabled || board_id < 0)
            return;
        BoardType bt = BoardType::UNKNOWN;
        if (board_type_str == "PT")
            bt = BoardType::PT;
        else if (board_type_str == "TC")
            bt = BoardType::TC;
        else if (board_type_str == "RTD")
            bt = BoardType::RTD;
        else if (board_type_str == "LC")
            bt = BoardType::LC;
        else if (board_type_str == "ENCODER")
            bt = BoardType::ENCODER;
        else if (board_type_str == "ACTUATOR")
            bt = BoardType::ACTUATOR;
        if (bt == BoardType::UNKNOWN)
            return;

        BoardChannels bc;
        bc.board_id = static_cast<uint8_t>(board_id);
        {
            int m = board_id % 10;
            bc.board_number = static_cast<uint8_t>(m == 0 ? 10 : m);
        }
        if (!active_conn.empty()) {
            bc.channels = active_conn;
        } else {
            for (int i = 1; i <= num_sensors; i++)
                bc.channels.push_back(static_cast<uint8_t>(i));
        }
        result[bt].push_back(std::move(bc));
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
            flush();
            section = line.substr(1, line.size() - 2);
            if (section.rfind("boards.", 0) == 0) {
                board_type_str.clear();
                board_id = -1;
                board_enabled = true;
                active_conn.clear();
                num_sensors = 10;
            } else {
                board_type_str.clear();
            }
            continue;
        }
        if (section.rfind("boards.", 0) != 0)
            continue;

        size_t eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
            key.pop_back();
        while (!val.empty() && val[0] == ' ')
            val.erase(0, 1);

        if (key == "type") {
            if (val.size() >= 2 && val.front() == '"' && val.back() == '"')
                val = val.substr(1, val.size() - 2);
            board_type_str = val;
        } else if (key == "enabled" && val == "false") {
            board_enabled = false;
        } else if (key == "board_id") {
            try {
                board_id = std::stoi(val);
            } catch (...) {
            }
        } else if (key == "num_sensors") {
            try {
                num_sensors = std::stoi(val);
            } catch (...) {
            }
        } else if (key == "active_connectors") {
            size_t b = val.find('['), e = val.find(']');
            if (b != std::string::npos && e != std::string::npos) {
                std::string inner = val.substr(b + 1, e - b - 1);
                std::istringstream iss(inner);
                std::string tok;
                while (std::getline(iss, tok, ',')) {
                    try {
                        active_conn.push_back(static_cast<uint8_t>(std::stoi(tok)));
                    } catch (...) {
                    }
                }
            }
        }
    }
    flush();

    return result;
}

// Map discovery signature board_type (DAQv2 wire: 1=PT, 2=LC, 3=RTD, 4=TC, 5=ACT, 6=ENC)
static BoardType discovery_board_type_to_enum(uint8_t t) {
    switch (t) {
        case fsw::daq_wire::kPressureTransducer:
            return BoardType::PT;
        case fsw::daq_wire::kLoadCell:
            return BoardType::LC;
        case fsw::daq_wire::kRtd:
            return BoardType::RTD;
        case fsw::daq_wire::kThermocouple:
            return BoardType::TC;
        case fsw::daq_wire::kActuator:
            return BoardType::ACTUATOR;
        case 6:
            return BoardType::ENCODER;
        default:
            return BoardType::UNKNOWN;
    }
}

static uint8_t config_board_type_to_wire_u8(BoardType t) {
    switch (t) {
        case BoardType::PT:
            return fsw::daq_wire::kPressureTransducer;
        case BoardType::LC:
            return fsw::daq_wire::kLoadCell;
        case BoardType::RTD:
            return fsw::daq_wire::kRtd;
        case BoardType::TC:
            return fsw::daq_wire::kThermocouple;
        case BoardType::ACTUATOR:
            return fsw::daq_wire::kActuator;
        case BoardType::ENCODER:
            return 6;
        default:
            return fsw::daq_wire::kUnknown;
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
    BoardOrder board_order;
    std::string db_host;
    uint16_t db_port;
    uint16_t config_sensor_port = 0;
    std::string config_bind_ip;
    ServerHeartbeatConfig hb_config;
    load_board_map_from_config(config_path, board_map, &board_order, db_host, db_port,
                               &config_sensor_port, &config_bind_ip, &hb_config);
    if (config_sensor_port != 0)
        bind_port = config_sensor_port;
    if (!config_bind_ip.empty())
        bind_address = config_bind_ip;

    std::cout << "[Config] Board order (127.0.0.x fallback): " << board_order.size()
              << " enabled boards" << std::endl;
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
            case BoardType::ENCODER:
                type_str = "ENCODER";
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
    for (const auto& [ip, cfg] : board_map) {
        if (cfg.board_id >= 0 && cfg.board_id <= 255)
            discovery.set_static_ip_for_board(static_cast<uint8_t>(cfg.board_id), ip);
    }
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

    if (pipeline.set_broadcast(true)) {
        if (hb_config.send_from_daq_bridge)
            std::cout << "✅ Broadcast enabled for SERVER_HEARTBEAT" << std::endl;
        else
            std::cout << "✅ SERVER_HEARTBEAT from heartbeat_service (daq_bridge skipping)"
                      << std::endl;
    } else {
        std::cerr << "⚠️  Failed to enable broadcast (heartbeat may not reach boards)" << std::endl;
    }

    // Proactively send SENSOR_CONFIG to all configured sense boards (PT/TC/RTD/LC).
    // Boards need SENSOR_CONFIG to transition from WaitingForServer → Active and start streaming.
    int proactive_count = 0;
    for (const auto& [ip, cfg] : board_map) {
        if (cfg.board_id < 0 || !cfg.enabled || cfg.type == BoardType::ACTUATOR)
            continue;
        Diablo::BoardHeartbeatPacket synthetic{};
        synthetic.board_id = static_cast<uint8_t>(cfg.board_id);
        synthetic.engine_state = Diablo::EngineState::SAFE;
        synthetic.board_state = Diablo::BoardState::SETUP;
        Diablo::PacketHeader syn_hdr{};
        syn_hdr.packet_type = Diablo::PacketType::BOARD_HEARTBEAT;
        syn_hdr.version = DIABLO_COMMS_VERSION;
        syn_hdr.timestamp =
            static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                      std::chrono::steady_clock::now().time_since_epoch())
                                      .count() &
                                  0xFFFFFFFF);
        std::string mac = "00:00:00:00:" + std::to_string(cfg.board_id) + ":00";
        fsw_config->process_board_heartbeat(syn_hdr, synthetic, ip, mac);
        proactive_count++;
    }
    if (proactive_count > 0)
        std::cout << "✅ Proactive SENSOR_CONFIG sent to " << proactive_count << " sense boards"
                  << std::endl;

    fsw::routing::SensorRouter router;

    // ── Inline Calibration (Elodin only supports 1 stream subscriber, so calibration runs here) ──
    fsw::calibration::PTCalibrationManager pt_calibration;
    pt_calibration.load_calibration();
    fsw::calibration::SensorCalibrationManager tc_calibration("TC", "°C", 3);
    tc_calibration.load_calibration(
        "scripts/calibration/calibrations/tc",
        "external/DiabloAvionics/TC_Board/Calibration/tc_calibration.csv");
    fsw::calibration::SensorCalibrationManager rtd_calibration("RTD", "°C", 3);
    rtd_calibration.load_calibration(
        "scripts/calibration/calibrations/rtd",
        "external/DiabloAvionics/RTD_Board/Calibration/rtd_calibration.csv");
    fsw::calibration::SensorCalibrationManager lc_calibration("LC", "lbf", 3);
    lc_calibration.load_calibration(
        "scripts/calibration/calibrations/lc",
        "external/DiabloAvionics/LC_Board/Calibration/lc_calibration.csv");
    router.set_pt_calibration(&pt_calibration);
    router.set_tc_calibration(&tc_calibration);
    router.set_rtd_calibration(&rtd_calibration);
    router.set_lc_calibration(&lc_calibration);
    std::cout << "✅ Sensor router initialized (with inline calibration: PT="
              << pt_calibration.get_calibrated_count() << " channels)" << std::endl;

    // ── Elodin Client (host/port from config [database]) ──
    fsw::elodin::ElodinClient elodin_client;
    fsw::routing::HeartbeatRouter heartbeat_router(elodin_client);
    bool elodin_connected = false;
    // Collect active boards with local channels from config (board-namespaced, no channel_offset)
    auto active_boards = load_active_boards(config_path);
    const auto& pt_boards = active_boards[BoardType::PT];
    const auto& act_boards = active_boards[BoardType::ACTUATOR];
    const auto& tc_boards = active_boards[BoardType::TC];
    const auto& rtd_boards = active_boards[BoardType::RTD];
    const auto& lc_boards = active_boards[BoardType::LC];
    const auto& enc_boards = active_boards[BoardType::ENCODER];

    std::vector<uint8_t> config_board_ids;
    for (const auto& [ip, cfg] : board_map) {
        if (cfg.enabled && cfg.board_id > 0 && cfg.board_id <= 254)
            config_board_ids.push_back(static_cast<uint8_t>(cfg.board_id));
    }

    if (elodin_client.connect(db_host, db_port)) {
        elodin_connected = true;
        std::cout << "✅ Connected to Elodin database" << std::endl;
        // Register RAW VTables (board-namespaced TYPE<n>.CH<m> names)
        if (!fsw::elodin::DatabaseConfig::register_tables(elodin_client, pt_boards, act_boards,
                                                          tc_boards, rtd_boards, lc_boards,
                                                          enc_boards)) {
            std::cerr << "⚠️  RAW VTable registration failed" << std::endl;
        }
        // Register CALIBRATED VTables
        fsw::elodin::DatabaseConfig::register_calibrated_tables(
            elodin_client, pt_boards, tc_boards, rtd_boards, lc_boards, enc_boards, act_boards);
        // Register BOARD_HEARTBEAT and SELF_TEST VTables only for boards in config
        fsw::elodin::DatabaseConfig::register_heartbeat_tables(elodin_client, config_board_ids);
        fsw::elodin::DatabaseConfig::register_self_test_tables(elodin_client, config_board_ids);
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
    auto last_heartbeat_send = std::chrono::steady_clock::now();
    auto last_config_save = std::chrono::steady_clock::now();

    while (running) {
        auto now = std::chrono::steady_clock::now();
        // Broadcast SERVER_HEARTBEAT only when heartbeat_service is not used
        if (hb_config.send_from_daq_bridge) {
            auto elapsed_ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(now - last_heartbeat_send)
                    .count();
            if (elapsed_ms >= static_cast<int64_t>(hb_config.interval_ms)) {
                auto pkt = build_server_heartbeat_packet();
                ssize_t sent = pipeline.send_to(hb_config.broadcast_ip, hb_config.broadcast_port,
                                                pkt.data(), pkt.size());
                if (sent > 0)
                    last_heartbeat_send = now;
            }
        }

        auto batch = pipeline.poll();
        if (!batch.has_value()) {
            // When last packet was a BOARD_HEARTBEAT, run discovery and broadcast config to that
            // board
            auto hb = pipeline.get_last_heartbeat();
            if (hb) {
                discovery.process_board_announcement(hb->data.data(), hb->data.size(),
                                                     hb->source_ip);
                Diablo::PacketHeader ph;
                Diablo::BoardHeartbeatPacket hb_body;
                if (Diablo::parse_board_heartbeat_packet(hb->data.data(), hb->data.size(), ph,
                                                         hb_body)) {
                    uint8_t board_type_wire = fsw::daq_wire::kUnknown;
                    auto cfg_it = board_map.find(hb->source_ip);
                    if (cfg_it != board_map.end()) {
                        board_type_wire = config_board_type_to_wire_u8(cfg_it->second.type);
                    }
                    std::hash<std::string> hasher;
                    uint32_t ip_hash = static_cast<uint32_t>(hasher(hb->source_ip));
                    uint32_t sig_id =
                        (static_cast<uint32_t>(board_type_wire) << 8) | hb_body.board_id;
                    std::ostringstream mac;
                    mac << std::hex << std::setw(2) << std::setfill('0') << ((ip_hash >> 16) & 0xFF)
                        << ":" << std::setw(2) << ((ip_hash >> 8) & 0xFF) << ":" << std::setw(2)
                        << (ip_hash & 0xFF) << ":" << std::setw(2) << ((ip_hash >> 24) & 0xFF)
                        << ":" << std::setw(2) << ((sig_id >> 8) & 0xFF) << ":" << std::setw(2)
                        << (sig_id & 0xFF);
                    fsw_config->process_board_heartbeat(ph, hb_body, hb->source_ip, mac.str());

                    uint64_t hb_receive_ts_ns =
                        std::chrono::duration_cast<std::chrono::nanoseconds>(
                            std::chrono::steady_clock::now().time_since_epoch())
                            .count();
                    heartbeat_router.process_heartbeat(ph, hb_body, board_type_wire,
                                                       hb_receive_ts_ns);
                }
                // Periodic save of discovery state so actuator_service can use board IPs
                auto elapsed =
                    std::chrono::duration_cast<std::chrono::seconds>(now - last_config_save)
                        .count();
                if (elapsed >= 5) {
                    auto boards = discovery.get_discovered_boards();
                    if (!boards.empty()) {
                        config_manager.update_with_boards(boards);
                        config_manager.save_config(config_path + ".auto");
                        last_config_save = now;
                    }
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
                        fsw::elodin::DatabaseConfig::register_tables(
                            elodin_client, pt_boards, act_boards, tc_boards, rtd_boards, lc_boards,
                            enc_boards);
                        fsw::elodin::DatabaseConfig::register_calibrated_tables(
                            elodin_client, pt_boards, tc_boards, rtd_boards, lc_boards, enc_boards,
                            act_boards);
                        fsw::elodin::DatabaseConfig::register_heartbeat_tables(elodin_client,
                                                                               config_board_ids);
                        fsw::elodin::DatabaseConfig::register_self_test_tables(elodin_client,
                                                                               config_board_ids);
                    }
                }
            }
            continue;
        }

        packet_count++;
        const std::string& source_ip = pipeline.last_source_ip();
        packets_per_board[source_ip]++;

        // Use system_clock (epoch) so timestamps align with JS Date.now() — prevents
        // boot-relative vs epoch confusion that causes plot spikes when sources mix.
        uint64_t receive_timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                            std::chrono::system_clock::now().time_since_epoch())
                                            .count();

        // ── Route based on source IP → board type (config, then 127.0.0.x simulator fallback,
        // then discovery, else treat as PT) ──
        auto board_it = board_map.find(source_ip);
        const BoardConfig* effective_cfg = nullptr;
        if (board_it != board_map.end() && board_it->second.enabled)
            effective_cfg = &board_it->second;
        else if (source_ip.compare(0, 8, "127.0.0.") == 0 && !board_order.empty()) {
            // 127.0.0.2→first board, 127.0.0.3→second, etc. 127.0.0.1→first (fallback when bind
            // fails)
            int idx = (source_ip.size() >= 9) ? (std::atoi(source_ip.c_str() + 8) - 2) : -1;
            if (idx < 0)
                idx = 0;  // 127.0.0.1 or malformed: use first board
            if (idx < static_cast<int>(board_order.size()))
                effective_cfg = &board_order[idx].second;
        }
        // Use board type from config even when disabled — we still publish actuator/PT data to DB
        BoardType board_type = board_it != board_map.end()
                                   ? board_it->second.type
                                   : (effective_cfg ? effective_cfg->type : BoardType::UNKNOWN);
        if (board_type == BoardType::UNKNOWN) {
            auto discovered = discovery.get_board_by_ip(source_ip);
            if (discovered) {
                board_type = discovery_board_type_to_enum(discovered->signature.board_type);
                if (board_type != BoardType::UNKNOWN)
                    board_map[source_ip] = {board_type, source_ip, 10, true, -1};
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

        // ── Publish SELF_TEST back to Elodin ──
        if (elodin_connected && elodin_client.is_connected() && !batch.value().self_tests.empty()) {
            elodin_client.begin_batch();
            for (const auto& st_packet : batch.value().self_tests) {
                // board_id is retrieved from heartbeat or routing. However, self test doesn't have
                // board_id in the packet. We use discovery to map IP to board_id.
                auto cfg_it = board_map.find(source_ip);
                uint8_t board_id = (cfg_it != board_map.end() && cfg_it->second.board_id >= 0)
                                       ? cfg_it->second.board_id
                                       : 0;

                if (board_id == 0) {
                    auto discovered = discovery.get_board_by_ip(source_ip);
                    if (discovered)
                        board_id = discovered->signature.board_id;
                }
                // Integration fallback: startup sim commonly uses loopback board IPs
                // like 127.0.0.60. If config/discovery mapping is unavailable, derive
                // board_id from the last octet so SELF_TEST still reaches Elodin.
                if (board_id == 0 && source_ip.compare(0, 8, "127.0.0.") == 0) {
                    int ip_octet = (source_ip.size() >= 9) ? std::atoi(source_ip.c_str() + 8) : 0;
                    if (ip_octet > 0 && ip_octet <= 255) {
                        board_id = static_cast<uint8_t>(ip_octet);
                    }
                }

                if (board_id != 0) {
                    std::array<uint8_t, 2> pkt_id = {0x60, board_id};
                    using SelfTestElodinMsg = comms::CommsMessage<uint64_t, uint8_t, uint8_t>;
                    for (const auto& res : st_packet.results) {
                        SelfTestElodinMsg msg;
                        msg.setField<0>(receive_timestamp_ns);
                        msg.setField<1>(res.sensor_id);
                        msg.setField<2>(res.result);
                        elodin_client.publish(pkt_id, msg);
                    }
                }
            }
            if (elodin_client.flush_batch())
                elodin_publish_count++;

            std::array<uint8_t, 4096> drain_buf;
            while (elodin_client.read_data(drain_buf.data(), drain_buf.size()) > 0) {
            }
        }

        // ── Begin batch: all publishes from this packet go into one buffer ──
        bool publishing = elodin_connected && elodin_client.is_connected();
        if (publishing)
            elodin_client.begin_batch();

        // Board-namespaced packet IDs: low byte = (board_number-1)*0x10 + local_channel
        // Match GUI / sequencer: board_id % 10 == 0 → use slot 10 (boards 10, 20, …).
        uint8_t board_number = 1;
        if (effective_cfg) {
            int bn = static_cast<int>(effective_cfg->board_id % 10);
            board_number = static_cast<uint8_t>(bn == 0 ? 10 : bn);
        }
        uint8_t board_offset =
            static_cast<uint8_t>((static_cast<unsigned>(board_number) - 1u) * 0x20u);

        // Helper lambda: build board-namespaced packet and publish a raw sample
        auto publish_raw_sample = [&](uint8_t type_hi, const auto& sample) {
            uint8_t pkt_lo = static_cast<uint8_t>(board_offset + sample.channel_id);
            std::array<uint8_t, 2> pkt_id = {type_hi, pkt_lo};
            comms::messages::sensor::RawPTMessage msg;
            msg.setField<0>(receive_timestamp_ns);
            msg.setField<1>(sample.channel_id);
            msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
            msg.setField<3>(sample.raw_adc_counts);
            msg.setField<4>(sample.sample_timestamp_ms);
            msg.setField<5>(sample.status_flags);
            if (publishing)
                elodin_client.publish(pkt_id, msg);
        };

        switch (board_type) {
            case BoardType::PT: {
                for (const auto& sample : batch.value().pt_samples)
                    publish_raw_sample(0x20, sample);
                break;
            }
            case BoardType::ACTUATOR: {
                for (const auto& sample : batch.value().pt_samples)
                    publish_raw_sample(0x30, sample);
                break;
            }
            case BoardType::LC: {
                for (const auto& sample : batch.value().pt_samples)
                    publish_raw_sample(0x23, sample);
                break;
            }
            case BoardType::TC: {
                for (const auto& sample : batch.value().pt_samples)
                    publish_raw_sample(0x21, sample);
                break;
            }
            case BoardType::RTD: {
                for (const auto& sample : batch.value().pt_samples)
                    publish_raw_sample(0x22, sample);
                break;
            }
            case BoardType::ENCODER: {
                for (const auto& sample : batch.value().pt_samples)
                    publish_raw_sample(0x24, sample);
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
                const BoardConfig* cfg = (it != board_map.end()) ? &it->second : nullptr;
                if (!cfg && ip.compare(0, 8, "127.0.0.") == 0 && !board_order.empty()) {
                    int idx = (ip.size() >= 9) ? (std::atoi(ip.c_str() + 8) - 2) : -1;
                    if (idx < 0)
                        idx = 0;
                    if (idx < static_cast<int>(board_order.size()))
                        cfg = &board_order[idx].second;
                }
                const char* tag = "???";
                if (cfg) {
                    switch (cfg->type) {
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
                        case BoardType::ENCODER:
                            tag = "ENC";
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

            // Print raw PT ADC counts instead of calibrated pressures (removed logic)
            if (board_type == BoardType::PT && !batch.value().pt_samples.empty()) {
                std::cout << "[PT Raw] ";
                for (const auto& sample : batch.value().pt_samples) {
                    std::cout << "CH" << (int)sample.channel_id << ":" << sample.raw_adc_counts
                              << " ";
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
