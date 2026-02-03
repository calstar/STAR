/**
 * @file daq_bridge_main.cpp
 * @brief Main executable for DAQ bridge - connects embedded sensor packets to Elodin
 * 
 * This is the main entry point for the groundstation-side DAQ bridge.
 * It receives encrypted sensor packets from embedded systems, decrypts them,
 * routes sensor data to appropriate Elodin tables, and publishes to the database.
 */

#include "streams/SensorFramePipeline.hpp"
#include "routing/SensorRouter.hpp"
#include "routing/FrameToElodinMapper.hpp"
#include "elodin/ElodinClient.hpp"
#include "elodin/DatabaseConfig.hpp"

#include <iostream>
#include <chrono>
#include <thread>
#include <csignal>
#include <atomic>

namespace {
    std::atomic<bool> g_running{true};
    
    void signal_handler(int signal) {
        if (signal == SIGINT || signal == SIGTERM) {
            std::cout << "\n[DAQ Bridge] Received shutdown signal, stopping...\n";
            g_running = false;
        }
    }
}

int main(int argc, char* argv[]) {
        // Ensure stdout is line-buffered for real-time output
        setvbuf(stdout, nullptr, _IOLBF, 0);
        setvbuf(stderr, nullptr, _IOLBF, 0);
        
        // Parse command line arguments
        std::string udp_bind_address = "0.0.0.0";
        uint16_t udp_bind_port = 8888;
        std::string elodin_host = "127.0.0.1";
        uint16_t elodin_port = 2240;
        std::string config_path = "config/sensor_routing.toml";
    
    if (argc > 1) {
        udp_bind_address = argv[1];
    }
    if (argc > 2) {
        udp_bind_port = static_cast<uint16_t>(std::stoi(argv[2]));
    }
    if (argc > 3) {
        elodin_host = argv[3];
    }
    if (argc > 4) {
        elodin_port = static_cast<uint16_t>(std::stoi(argv[4]));
    }
    if (argc > 5) {
        config_path = argv[5];
    }

    std::cout << "[DAQ Bridge] Starting DAQ bridge service\n";
    std::cout << "[DAQ Bridge] UDP bind: " << udp_bind_address << ":" << udp_bind_port << "\n";
    std::cout << "[DAQ Bridge] Elodin host: " << elodin_host << ":" << elodin_port << "\n";
    std::cout << "[DAQ Bridge] Config: " << config_path << "\n";

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Initialize components
    daq_comms::streams::SensorFramePipeline pipeline(udp_bind_address, udp_bind_port);
    if (!pipeline.is_ready()) {
        std::cerr << "[DAQ Bridge] ERROR: Failed to initialize sensor pipeline: " 
                  << pipeline.last_error() << "\n";
        return 1;
    }

    daq_comms::elodin::ElodinClient elodin_client;
    if (!elodin_client.connect(elodin_host, elodin_port)) {
        std::cerr << "[DAQ Bridge] ERROR: Failed to connect to Elodin: " 
                  << elodin_client.last_error() << "\n";
        return 1;
    }
    std::cout << "[DAQ Bridge] Connected to Elodin database\n";
    
    // Register database tables
    // NOTE: FSW's data also goes to entity_id 14002, suggesting Elodin uses this as default
    // Let's try registering VTables to see if it helps, but data might still go to 14002
    if (!daq_comms::elodin::DatabaseConfig::register_tables(elodin_client)) {
        std::cerr << "[DAQ Bridge] WARNING: Failed to register tables\n";
    }
    
    std::cout << "[DAQ Bridge] NOTE: Data may go to entity_id 14002 (Elodin default)\n";
    std::cout << "[DAQ Bridge] This matches FSW's behavior - check editor for entity_id 14002\n";
    
    // Small delay to ensure registration messages are processed
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    daq_comms::routing::SensorRouter router;
    if (!router.load_config(config_path)) {
        std::cerr << "[DAQ Bridge] WARNING: Failed to load config, using defaults\n";
    }

    daq_comms::routing::FrameToElodinMapper mapper(elodin_client, router);

    std::cout << "[DAQ Bridge] Ready, waiting for sensor packets...\n";

    // Main processing loop
    size_t total_batches = 0;
    auto last_stats_time = std::chrono::steady_clock::now();
    
    auto last_flush_time = std::chrono::steady_clock::now();
    
    while (g_running) {
        // Poll for new frames
        auto batch = pipeline.poll();
        
        if (batch.has_value()) {
            size_t published = mapper.map_and_publish(batch.value());
            total_batches++;
            
            if (total_batches <= 10 || total_batches % 100 == 0) {
                std::cout << "[DAQ Bridge] Processed " << total_batches 
                          << " batches, published " << published << " messages\n";
            }
        }

        // Flush Elodin buffer periodically (every 100ms) to ensure data is sent
        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_flush_time).count() >= 100) {
            elodin_client.flush_buffer();
            last_flush_time = now;
        }

        // Print statistics periodically (every 5 seconds for better visibility)
        if (std::chrono::duration_cast<std::chrono::seconds>(now - last_stats_time).count() >= 5) {
            auto pipeline_stats = pipeline.get_stats();
            auto mapper_stats = mapper.get_stats();
            
            std::cout << "[DAQ Bridge] Stats:\n";
            std::cout << "  Frames decoded: " << pipeline_stats.frames_decoded << "\n";
            std::cout << "  Frames dropped: " << pipeline_stats.frames_dropped << "\n";
            std::cout << "  Decryption failures: " << pipeline_stats.decryption_failures << "\n";
            std::cout << "  Unpack failures: " << pipeline_stats.unpack_failures << "\n";
            std::cout << "  Batches processed: " << mapper_stats.batches_processed << "\n";
            std::cout << "  Messages published: " << mapper_stats.messages_published << "\n";
            std::cout << "  Publish failures: " << mapper_stats.publish_failures << "\n";
            
            last_stats_time = now;
        }

        // Small sleep to avoid busy-waiting
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }

    std::cout << "[DAQ Bridge] Shutting down...\n";
    elodin_client.disconnect();
    
    return 0;
}

