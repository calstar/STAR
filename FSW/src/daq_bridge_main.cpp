#include <signal.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>

#include "config/BoardDiscovery.hpp"
#include "elodin/ElodinClient.hpp"
#include "fsw/FSWConfigManager.hpp"
#include "routing/SensorRouter.hpp"
#include "streams/SensorFramePipeline.hpp"

using namespace fsw;

std::atomic<bool> running(true);

void signal_handler(int /* sig */) {
    running = false;
    std::cout << "\n[DAQ Bridge] Shutting down..." << std::endl;
}

int main(int argc, char* argv[]) {
    // Parse command line arguments
    std::string config_path = "config/config.toml";
    std::string bind_address = "0.0.0.0";
    uint16_t bind_port = 2244;
    bool enable_discovery = true;

    if (argc > 1) {
        config_path = argv[1];
    }
    if (argc > 2) {
        bind_address = argv[2];
    }
    if (argc > 3) {
        bind_port = static_cast<uint16_t>(std::stoi(argv[3]));
    }

    std::cout << "=== DAQ Bridge - DiabloAvionics Packet Receiver ===" << std::endl;
    std::cout << "Config: " << config_path << std::endl;
    std::cout << "Listening on: " << bind_address << ":" << bind_port << std::endl;
    std::cout << std::endl;

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Determine system mode from config path
    bool is_flight_daq = (config_path.find("flight") != std::string::npos);
    config::SystemState system_state =
        is_flight_daq ? config::SystemState::FLIGHT : config::SystemState::GSE;

    std::cout << "[System] Mode: " << (is_flight_daq ? "FLIGHT DAQ" : "GROUND DAQ") << std::endl;

    // Initialize FSW configuration manager (assigns IPs and sensors)
    fsw::FSWConfigManager fsw_config;
    if (enable_discovery) {
        std::cout << "[FSW] Initializing FSW configuration manager..." << std::endl;
        if (!fsw_config.initialize("0.0.0.0", 5008)) {  // Port for sending configs
            std::cerr << "❌ Failed to initialize FSW config manager" << std::endl;
            return 1;
        }

        // Set system state based on config file
        fsw_config.set_system_state(system_state);
    }

    // Initialize board discovery
    config::BoardDiscovery discovery;
    config::DynamicConfigManager config_manager;

    if (enable_discovery) {
        std::cout << "[Discovery] Initializing board discovery..." << std::endl;

        // Set IP range based on system state
        std::string base_ip = is_flight_daq ? "192.168.3.0" : "192.168.2.0";
        discovery.initialize("eth0", base_ip, 100, 150);
        discovery.start_discovery(config::BoardDiscovery::DiscoveryMode::HYBRID);

        // Register callback for board discovery - integrate with FSW config
        discovery.register_discovery_callback([&fsw_config](const config::DiscoveredBoard& board) {
            std::cout << "[Discovery] Board discovered: " << board.signature.to_string() << " at "
                      << board.current_ip << std::endl;
            std::cout << "  Sensors: " << board.active_sensors << " active" << std::endl;

            // Process heartbeat through FSW config manager
            // TODO: Parse heartbeat and send to FSW config manager
        });

        // Load base config
        config_manager.load_base_config(config_path);
    }

    // Initialize sensor pipeline (receives DiabloAvionics packets)
    streams::SensorFramePipeline pipeline(bind_address, bind_port);
    if (!pipeline.is_ready()) {
        std::cerr << "❌ Failed to initialize sensor pipeline: " << pipeline.last_error()
                  << std::endl;
        return 1;
    }

    std::cout << "✅ Sensor pipeline ready" << std::endl;

    // Initialize sensor router
    routing::SensorRouter router;
    std::cout << "✅ Sensor router initialized" << std::endl;

    // Initialize Elodin client
    elodin::ElodinClient elodin_client;
    if (!elodin_client.connect("127.0.0.1", 2240)) {
        std::cerr << "❌ Failed to connect to Elodin database" << std::endl;
        return 1;
    }

    std::cout << "✅ Connected to Elodin database" << std::endl;
    std::cout << std::endl;
    std::cout << "📡 Listening for DiabloAvionics packets..." << std::endl;
    std::cout << std::endl;

    // Main processing loop
    size_t packet_count = 0;
    auto last_stats_time = std::chrono::steady_clock::now();

    while (running) {
        // Poll for new packets
        auto batch = pipeline.poll();
        if (!batch.has_value()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        packet_count++;

        // Process sensor data for board discovery
        if (enable_discovery) {
            // Extract source IP from packet (would need to modify pipeline to track this)
            // For now, discovery happens via separate announcement packets
        }

        // Get receive timestamp
        auto now = std::chrono::steady_clock::now();
        auto duration = now.time_since_epoch();
        uint64_t receive_timestamp_ns =
            std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();

        // Route PT samples
        auto pt_messages = router.route_pt_samples(batch.value(), receive_timestamp_ns);
        for (const auto& [packet_id, msg] : pt_messages) {
            elodin_client.publish(packet_id, msg);
        }

        // Route TC samples
        auto tc_messages = router.route_tc_samples(batch.value(), receive_timestamp_ns);
        for (const auto& [packet_id, msg] : tc_messages) {
            elodin_client.publish(packet_id, msg);
        }

        // Route RTD samples
        auto rtd_messages = router.route_rtd_samples(batch.value(), receive_timestamp_ns);
        for (const auto& [packet_id, msg] : rtd_messages) {
            elodin_client.publish(packet_id, msg);
        }

        // Route LC samples
        auto lc_messages = router.route_lc_samples(batch.value(), receive_timestamp_ns);
        for (const auto& [packet_id, msg] : lc_messages) {
            elodin_client.publish(packet_id, msg);
        }

        // Periodic stats output
        auto elapsed = std::chrono::steady_clock::now() - last_stats_time;
        if (std::chrono::duration_cast<std::chrono::seconds>(elapsed).count() >= 5) {
            std::cout << "[Stats] Packets processed: " << packet_count << std::endl;
            last_stats_time = std::chrono::steady_clock::now();
        }
    }

    // Update config with discovered boards before shutdown
    if (enable_discovery) {
        auto boards = discovery.get_discovered_boards();
        config_manager.update_with_boards(boards);
        config_manager.save_config(config_path + ".auto");

        std::cout << "[Discovery] Discovered " << boards.size() << " boards" << std::endl;
        auto discovery_stats = discovery.get_stats();
        std::cout << "[Discovery] Sensors detected: " << discovery_stats.sensors_detected
                  << std::endl;
    }

    std::cout << "[DAQ Bridge] Shutdown complete" << std::endl;
    return 0;
}
