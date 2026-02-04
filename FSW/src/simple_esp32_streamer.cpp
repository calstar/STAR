/**
 * @file simple_esp32_streamer.cpp
 * @brief Simple ESP32 to Elodin DB streamer - replaces fake_sensor_generator
 *
 * This streams real ESP32 PT data from channels 2 & 3 to Elodin DB
 * Uses the exact same interface as fake_sensor_generator
 */

#include <signal.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <thread>

// Flight software includes
#include "ESP32SerialHandler.hpp"
#include "PTMessage.hpp"
#include "Timer.hpp"

// Elodin DB includes (same as fake_sensor_generator)
#include "../external/shared/message_factory/MessageFactory.hpp"
#include "../utl/Elodin.hpp"
#include "../utl/TCPSocket.hpp"
#include "../utl/dbConfig.hpp"

// Global variables for cleanup
std::unique_ptr<Socket> LocalSock;
std::atomic<bool> running(true);

// Signal handler for graceful shutdown
void signalHandler(int signum) {
    (void)signum;
    std::cout << "\nShutting down ESP32 streamer..." << std::endl;
    running = false;
}

class SimpleESP32Streamer {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::atomic<bool> streaming_active_;

    // Statistics
    uint64_t channel_2_count_ = 0;
    uint64_t channel_3_count_ = 0;

public:
    SimpleESP32Streamer() : streaming_active_(false) {
        std::cout << "=== SIMPLE ESP32 TO ELODIN DB STREAMER ===" << std::endl;
        std::cout << "Initializing real ESP32 PT data streaming..." << std::endl;

        // Initialize ESP32 handler for channels 2 and 3
        esp32_handler_ = createESP32Handler("/dev/ttyACM0", 115200);

        // Register callback for sensor data
        esp32_handler_->registerPTCallback([this](uint8_t sensor_id, double raw_voltage_v,
                                                  uint64_t timestamp, uint8_t pt_location) {
            this->onSensorData(sensor_id, raw_voltage_v, timestamp, pt_location);
        });

        std::cout << "✓ ESP32 handler configured for /dev/ttyACM0" << std::endl;
        std::cout << "✓ Streaming channels 2 & 3 to Elodin DB" << std::endl;
    }

    ~SimpleESP32Streamer() {
        stop();
    }

    bool start() {
        if (streaming_active_) {
            return true;
        }

        if (!esp32_handler_->start()) {
            std::cerr << "Failed to start ESP32 handler" << std::endl;
            return false;
        }

        streaming_active_ = true;

        std::cout << "\n🚀 ESP32 STREAMING STARTED!" << std::endl;
        std::cout << "📡 ESP32 data → Elodin DB" << std::endl;

        return true;
    }

    void stop() {
        if (!streaming_active_) {
            return;
        }

        streaming_active_ = false;

        if (esp32_handler_) {
            esp32_handler_->stop();
        }

        std::cout << "\n🛑 ESP32 streaming stopped" << std::endl;
    }

    void printStatistics() {
        std::cout << "\n📊 STREAMING STATISTICS:" << std::endl;
        std::cout << "Channel 2: " << channel_2_count_ << " packets sent" << std::endl;
        std::cout << "Channel 3: " << channel_3_count_ << " packets sent" << std::endl;
    }

private:
    void onSensorData(uint8_t sensor_id, double raw_voltage_v, uint64_t timestamp,
                      uint8_t pt_location) {
        // Only process channels 2 and 3
        if (sensor_id != 2 && sensor_id != 3) {
            return;
        }

        // Update statistics
        if (sensor_id == 2) {
            channel_2_count_++;
        } else if (sensor_id == 3) {
            channel_3_count_++;
        }

        // Create PTMessage for Elodin DB
        PTMessage pt_msg;

        // Set PT measurement data (using same pattern as fake_sensor_generator)
        double time_s = static_cast<double>(timestamp) / 1e9;

        // Convert raw voltage to pressure (rough conversion for demo)
        double pressure = raw_voltage_v * 100000.0;  // Rough conversion
        double temperature = 25.0;                   // Room temperature

        // Use correct function signature
        set_pt_measurement(pt_msg, timestamp, sensor_id, raw_voltage_v,
                           static_cast<PTLocation>(pt_location));

        // Send to Elodin DB using proper packet IDs
        std::array<uint8_t, 2> packet_id;
        if (sensor_id == 2) {
            packet_id = {0x02, 0x01};  // PT sensor channel 2
        } else {
            packet_id = {0x02, 0x02};  // PT sensor channel 3
        }

        try {
            write_to_elodindb(packet_id, pt_msg);
            LocalSock->flush_elodin();  // Flush buffer to ensure data is sent

            std::cout << "PT Ch" << static_cast<int>(sensor_id) << ": " << std::fixed
                      << std::setprecision(4) << raw_voltage_v << "V" << " → " << std::fixed
                      << std::setprecision(0) << pressure << "Pa [SENT]" << std::endl;

        } catch (const std::exception& e) {
            std::cerr << "❌ Failed to send PT data for channel " << static_cast<int>(sensor_id)
                      << ": " << e.what() << std::endl;
        }
    }
};

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
        // Initialize socket connection to Elodin database
        LocalSock = std::make_unique<Socket>(host.c_str(), port);

        std::cout << "✅ Connected to Elodin database at " << host << ":" << port << std::endl;

        // Generate database configuration (send vtable schemas)
        cppGenerateDBConfig();

        // Create and start the streaming system
        SimpleESP32Streamer streamer;

        if (!streamer.start()) {
            std::cerr << "Failed to start ESP32 streaming system" << std::endl;
            return 1;
        }

        // Main loop - print statistics every 10 seconds
        while (running) {
            std::this_thread::sleep_for(std::chrono::seconds(10));
            streamer.printStatistics();
        }

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    std::cout << "\n👋 ESP32 streamer shutdown complete." << std::endl;
    return 0;
}
