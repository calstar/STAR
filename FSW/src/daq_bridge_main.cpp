#include <signal.h>

#include <atomic>
#include <chrono>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <thread>

#include "../../daq_comms/include/comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "../../daq_comms/include/comms/messages/sensor/SensorMessages.hpp"
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
};

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

    // ── Board IP → Type mapping (from config) ──
    // This is the key routing table: source IP determines what type of data we got
    std::map<std::string, BoardConfig> board_map;
    board_map["192.168.2.101"] = {BoardType::PT, "192.168.2.101", 10, true};
    board_map["192.168.2.201"] = {BoardType::ACTUATOR, "192.168.2.201", 10, true};
    board_map["192.168.2.202"] = {BoardType::ACTUATOR, "192.168.2.202", 10, true};
    // Future boards:
    // board_map["192.168.2.102"] = {BoardType::LC,  "192.168.2.102", 4, false};
    // board_map["192.168.2.103"] = {BoardType::TC,  "192.168.2.103", 4, false};
    // board_map["192.168.2.104"] = {BoardType::RTD, "192.168.2.104", 4, false};

    std::cout << "[Config] Board routing table:" << std::endl;
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

    // ── FSW Config Manager ──
    std::cout << "[FSW] Initializing configuration manager..." << std::endl;
    auto fsw_config = std::make_unique<fsw::fsw::FSWConfigManager>();
    if (!fsw_config->initialize("0.0.0.0", 5008)) {
        std::cerr << "❌ Failed to initialize FSW config manager" << std::endl;
        return 1;
    }
    fsw_config->set_system_state(system_state);

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

    // ── Elodin Client ──
    fsw::elodin::ElodinClient elodin_client;
    bool elodin_connected = false;
    if (elodin_client.connect("127.0.0.1", 2240)) {
        elodin_connected = true;
        std::cout << "✅ Connected to Elodin database" << std::endl;
        // Register VTables so Elodin knows how to interpret our messages
        if (!fsw::elodin::DatabaseConfig::register_tables(elodin_client)) {
            std::cerr << "⚠️  VTable registration failed — editor may not display data" << std::endl;
        }
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
            std::this_thread::sleep_for(std::chrono::microseconds(500));

            // Try reconnect every 5 seconds if disconnected
            if (elodin_connected && !elodin_client.is_connected()) {
                auto since = std::chrono::steady_clock::now() - last_reconnect_time;
                if (std::chrono::duration_cast<std::chrono::seconds>(since).count() >= 5) {
                    last_reconnect_time = std::chrono::steady_clock::now();
                    if (elodin_client.reconnect()) {
                        std::cout << "✅ Reconnected to Elodin — re-registering VTables"
                                  << std::endl;
                        fsw::elodin::DatabaseConfig::register_tables(elodin_client);
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

        // ── Route based on source IP → board type ──
        auto board_it = board_map.find(source_ip);
        BoardType board_type = BoardType::UNKNOWN;
        if (board_it != board_map.end() && board_it->second.enabled) {
            board_type = board_it->second.type;
        } else if (unknown_ips.find(source_ip) == unknown_ips.end()) {
            unknown_ips.insert(source_ip);
            std::cout << "[Discovery] Unknown board at " << source_ip << " — add to [boards] config"
                      << std::endl;
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
                        elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : cal_msgs)
                        elodin_client.publish(id, msg);
                }
                break;
            }
            case BoardType::ACTUATOR: {
                for (const auto& sample : batch.value().pt_samples) {
                    std::array<uint8_t, 2> act_pkt = {0x30, sample.channel_id};
                    comms::messages::sensor::RawPTMessage msg;
                    msg.setField<0>(receive_timestamp_ns);
                    msg.setField<1>(sample.channel_id);
                    msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                    msg.setField<3>(sample.raw_adc_counts);
                    msg.setField<4>(sample.sample_timestamp_ms);
                    msg.setField<5>(sample.status_flags);
                    if (publishing)
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
                        elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : lc_cal)
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
                        elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : tc_cal)
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
                        elodin_client.publish(id, msg);
                    for (const auto& [id, msg] : rtd_cal)
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
