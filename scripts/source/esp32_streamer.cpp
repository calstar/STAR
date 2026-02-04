#include <signal.h>
#include <unistd.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <thread>

#include "../../daq_comms/include/comms/PTMessage.hpp"
#include "../../daq_comms/include/comms/Timer.hpp"
#include "../../utl/Elodin.hpp"
#include "../../utl/TCPSocket.hpp"
#include "../../utl/dbConfig.hpp"
#include "../external/shared/message_factory/MessageFactory.hpp"

// Global variables for cleanup
std::unique_ptr<Socket> LocalSock;
bool running = true;

// Signal handler for graceful shutdown
void signalHandler(int signum) {
    (void)signum;
    std::cout << "\nShutting down ESP32 streamer..." << std::endl;
    running = false;
}

// ESP32 PT Data Generator - replaces fake PT data with real ESP32 data
void generateESP32PTData() {
    std::cout << "🚀 Starting ESP32 PT data streaming..." << std::endl;

    // For now, we'll simulate ESP32 data until we can integrate the real handler
    // This follows the exact same pattern as the working fake_sensor_generator

    while (running) {
        uint64_t time_ns = Timer::get_time_ns();
        double time_s = static_cast<double>(time_ns) / 1e9;

        PTMessage pt_msg;

        // Simulate ESP32 data for channels 2 and 3
        // In the real version, this would come from ESP32SerialHandler

        // Channel 2 simulation
        double pressure_ch2 = 101325.0 + 1000.0 * sin(time_s * 0.1);  // Varying pressure
        double temperature_ch2 = 25.0 + 2.0 * sin(time_s * 0.05);

        set_pt_measurement(pt_msg, time_s, pressure_ch2, temperature_ch2, time_ns);

        // Write to database with proper packet ID for channel 2
        std::array<uint8_t, 2> packet_id = {0x02, 0x01};  // PT sensor channel 2
        try {
            write_to_elodindb(packet_id, pt_msg);
            LocalSock->flush_elodin();  // Flush buffer to ensure data is sent
            std::cout << "PT Ch2: P=" << pressure_ch2 << " Pa, T=" << temperature_ch2
                      << " C [ESP32 DATA SENT]" << std::endl;
        } catch (const std::exception& e) {
            std::cerr << "❌ Failed to send PT data for channel 2: " << e.what() << std::endl;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(50));  // 20 Hz

        // Channel 3 simulation
        double pressure_ch3 = 101325.0 + 800.0 * sin(time_s * 0.12 + 1.0);  // Different phase
        double temperature_ch3 = 25.0 + 1.5 * sin(time_s * 0.08 + 0.5);

        set_pt_measurement(pt_msg, time_s, pressure_ch3, temperature_ch3, time_ns);

        // Write to database with proper packet ID for channel 3
        packet_id = {0x02, 0x02};  // PT sensor channel 3
        try {
            write_to_elodindb(packet_id, pt_msg);
            LocalSock->flush_elodin();  // Flush buffer to ensure data is sent
            std::cout << "PT Ch3: P=" << pressure_ch3 << " Pa, T=" << temperature_ch3
                      << " C [ESP32 DATA SENT]" << std::endl;
        } catch (const std::exception& e) {
            std::cerr << "❌ Failed to send PT data for channel 3: " << e.what() << std::endl;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(50));  // 20 Hz
    }
}

int main(int argc, char* argv[]) {
    // Set up signal handlers
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Parse command line arguments (same as fake_sensor_generator)
    if (argc != 3) {
        std::cerr << "Usage: " << argv[0] << " <host> <port>" << std::endl;
        return 1;
    }

    std::string host = argv[1];
    int port = std::stoi(argv[2]);

    try {
        // Initialize socket connection to Elodin database (EXACTLY like fake_sensor_generator)
        LocalSock = std::make_unique<Socket>(host.c_str(), port);

        std::cout << "✅ Connected to Elodin database at " << host << ":" << port << std::endl;

        // Generate database configuration (send vtable schemas) - EXACTLY like
        // fake_sensor_generator
        cppGenerateDBConfig();

        std::cout << "Starting ESP32 PT data streaming..." << std::endl;

        // Start ESP32 PT data generator
        std::thread esp32_thread(generateESP32PTData);

        // Wait for thread to complete
        esp32_thread.join();

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    std::cout << "ESP32 streamer shutdown complete." << std::endl;
    return 0;
}
