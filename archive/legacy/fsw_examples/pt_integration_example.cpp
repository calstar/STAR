/**
 * @file pt_integration_example.cpp
 * @brief Simplified PT-only integration example
 *
 * This example demonstrates:
 * 1. Connecting to ESP32 via serial port for PT sensors only
 * 2. Receiving PT data (time + pressure) from up to 10 sensors
 * 3. Building observation matrices for engine control
 * 4. Handling dynamic sensor availability (e.g., only sensors 1, 2, 6, 8, 10 active)
 */

#include <signal.h>

#include <chrono>
#include <iostream>
#include <map>
#include <memory>
#include <thread>
#include <vector>

#include "ESP32SerialHandler.hpp"
#include "PTObservationMatrix.hpp"
#include "Timer.hpp"

class PTIntegrationExample {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::shared_ptr<PTObservationMatrixBuilder> pt_observation_builder_;
    std::atomic<bool> running_;
    std::thread processing_thread_;

public:
    PTIntegrationExample() : running_(false) {
        // Create ESP32 handler for serial communication
        esp32_handler_ = createESP32Handler("/dev/ttyUSB0", 115200);

        // Create PT observation matrix builder
        auto config = getDefaultPTObservationMatrixConfig();
        config.max_data_age_ms = 1000.0;  // 1 second timeout
        config.enable_outlier_detection = true;
        config.outlier_threshold_sigma = 3.0;
        config.max_pt_sensors = 10;
        pt_observation_builder_ = std::make_shared<PTObservationMatrixBuilder>(config);

        // Register callback for PT sensor data
        esp32_handler_->registerPTCallback([this](uint8_t sensor_id, double raw_voltage_v,
                                                  uint64_t timestamp, uint8_t pt_location) {
            this->onPTData(sensor_id, raw_voltage_v, timestamp, pt_location);
        });
    }

    ~PTIntegrationExample() {
        stop();
    }

    bool start() {
        if (running_) {
            return true;
        }

        std::cout << "Starting PT-only integration example..." << std::endl;

        // Start ESP32 handler
        if (!esp32_handler_->start()) {
            std::cerr << "Failed to start ESP32 handler" << std::endl;
            return false;
        }

        // Start processing thread
        running_ = true;
        processing_thread_ = std::thread(&PTIntegrationExample::processingLoop, this);

        std::cout << "PT integration example started successfully" << std::endl;
        return true;
    }

    void stop() {
        if (!running_) {
            return;
        }

        std::cout << "Stopping PT integration example..." << std::endl;
        running_ = false;

        // Stop ESP32 handler
        esp32_handler_->stop();

        // Wait for processing thread
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }

        std::cout << "PT integration example stopped" << std::endl;
    }

    bool isRunning() const {
        return running_;
    }

private:
    void onPTData(uint8_t sensor_id, double raw_voltage_v, uint64_t timestamp,
                  uint8_t pt_location) {
        std::cout << "Received PT data - Sensor " << static_cast<int>(sensor_id) << ": "
                  << raw_voltage_v << " V (Location: " << static_cast<int>(pt_location) << ")"
                  << std::endl;
    }

    void processingLoop() {
        std::cout << "PT processing loop started" << std::endl;

        while (running_) {
            try {
                // Get active PT sensors
                auto active_sensors = esp32_handler_->getActiveSensors();

                if (!active_sensors.empty()) {
                    std::cout << "\n=== PT Sensor Status ===" << std::endl;
                    std::cout << "Active PT sensors: ";
                    for (uint8_t sensor_id : active_sensors) {
                        std::cout << static_cast<int>(sensor_id) << " ";
                    }
                    std::cout << std::endl;

                    // Build observation matrix for engine control
                    buildEngineObservationMatrix();

                    // Build observation matrix for specific sensor locations
                    buildCustomObservationMatrix();

                    // Print PT sensor statistics
                    printPTSensorStatistics();
                }

                // Sleep for 100ms
                std::this_thread::sleep_for(std::chrono::milliseconds(100));

            } catch (const std::exception& e) {
                std::cerr << "Error in PT processing loop: " << e.what() << std::endl;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            }
        }

        std::cout << "PT processing loop stopped" << std::endl;
    }

    void buildEngineObservationMatrix() {
        // Get all recent PT sensor data
        auto recent_data = esp32_handler_->getAllRecentSensorData(1000);  // 1 second

        if (recent_data.empty()) {
            return;
        }

        // Convert to vector of PT messages
        std::vector<std::shared_ptr<PTMessage>> pt_messages;
        for (const auto& pair : recent_data) {
            pt_messages.push_back(pair.second);
        }

        // Clear previous measurements and add new ones
        pt_observation_builder_->clear();
        pt_observation_builder_->addPTSensors(pt_messages);

        // Build observation matrix for engine states (10-state model)
        auto result = pt_observation_builder_->buildEngineStateObservationMatrix(10);

        if (result.valid) {
            std::cout << "\n=== Engine Observation Matrix ===" << std::endl;
            std::cout << "Matrix dimensions: " << result.observation_matrix.rows() << " x "
                      << result.observation_matrix.cols() << std::endl;
            std::cout << "Measurements: " << result.measurement_vector.size() << std::endl;
            std::cout << "PT sensors used: ";
            for (uint8_t sensor_id : result.sensor_ids) {
                std::cout << static_cast<int>(sensor_id) << " ";
            }
            std::cout << std::endl;

            // Print pressure measurements
            std::cout << "Pressure readings (Pa): [";
            for (int i = 0; i < result.measurement_vector.size(); ++i) {
                std::cout << result.measurement_vector(i);
                if (i < result.measurement_vector.size() - 1)
                    std::cout << ", ";
            }
            std::cout << "]" << std::endl;

            // Example: Use in Kalman filter
            // kalman_filter.update(result.measurement_vector, result.observation_matrix,
            // result.measurement_covariance);

        } else {
            std::cout << "Failed to build engine observation matrix: " << result.error_message
                      << std::endl;
        }
    }

    void buildCustomObservationMatrix() {
        // Example: Map specific sensors to specific engine states
        std::map<size_t, uint8_t> sensor_locations;
        sensor_locations[0] = 0;  // Chamber pressure (sensor 0)
        sensor_locations[1] = 1;  // Fuel inlet pressure (sensor 1)
        sensor_locations[2] = 2;  // Oxidizer inlet pressure (sensor 2)
        sensor_locations[3] = 6;  // Coolant pressure (sensor 6)
        sensor_locations[4] = 8;  // Igniter pressure (sensor 8)

        auto result = pt_observation_builder_->buildCustomObservationMatrix(sensor_locations, 5);

        if (result.valid) {
            std::cout << "\n=== Custom Observation Matrix ===" << std::endl;
            std::cout << "Custom matrix dimensions: " << result.observation_matrix.rows() << " x "
                      << result.observation_matrix.cols() << std::endl;
            std::cout << "Mapped sensors: ";
            for (const auto& pair : sensor_locations) {
                std::cout << "state[" << pair.first << "]<-sensor[" << static_cast<int>(pair.second)
                          << "] ";
            }
            std::cout << std::endl;
        } else {
            std::cout << "Custom observation matrix not available: " << result.error_message
                      << std::endl;
        }
    }

    void printPTSensorStatistics() {
        auto stats = esp32_handler_->getSensorStatistics();

        std::cout << "\n=== PT Sensor Statistics ===" << std::endl;
        for (const auto& sensor_pair : stats) {
            uint8_t sensor_id = sensor_pair.first;
            const auto& sensor_stats = sensor_pair.second;

            std::cout << "PT Sensor " << static_cast<int>(sensor_id) << ":" << std::endl;

            auto packet_it = sensor_stats.find("packet_count");
            if (packet_it != sensor_stats.end()) {
                std::cout << "  Packets: " << static_cast<int>(packet_it->second) << std::endl;
            }

            auto rate_it = sensor_stats.find("avg_sample_rate");
            if (rate_it != sensor_stats.end()) {
                std::cout << "  Avg Rate: " << rate_it->second << " Hz" << std::endl;
            }

            auto age_it = sensor_stats.find("data_age_ms");
            if (age_it != sensor_stats.end()) {
                std::cout << "  Data Age: " << age_it->second << " ms" << std::endl;
            }
        }

        // Print PT-specific statistics
        auto pt_stats = pt_observation_builder_->getPTStatistics();
        std::cout << "\nPT-specific statistics:" << std::endl;
        for (const auto& pt_pair : pt_stats) {
            uint8_t sensor_id = pt_pair.first;
            const auto& stats = pt_pair.second;

            std::cout << "PT Sensor " << static_cast<int>(sensor_id) << ":" << std::endl;
            for (const auto& stat_pair : stats) {
                std::cout << "  " << stat_pair.first << ": " << stat_pair.second << std::endl;
            }
        }
    }
};

// Global instance for signal handling
std::unique_ptr<PTIntegrationExample> g_example;

void signalHandler(int signal) {
    std::cout << "\nReceived signal " << signal << ", shutting down..." << std::endl;
    if (g_example) {
        g_example->stop();
    }
}

int main(int argc, char* argv[]) {
    std::cout << "PT-Only Integration Example for Diablo FSW" << std::endl;
    std::cout << "===========================================" << std::endl;

    // Set up signal handling
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Create and start example
    g_example = std::make_unique<PTIntegrationExample>();

    // Override device path if provided
    if (argc > 1) {
        std::string device_path = argv[1];
        std::cout << "Using device: " << device_path << std::endl;
        // Note: In a real implementation, you'd pass the device path to the constructor
    }

    if (!g_example->start()) {
        std::cerr << "Failed to start PT integration example" << std::endl;
        return 1;
    }

    std::cout << "\nPT integration example running. Press Ctrl+C to stop." << std::endl;
    std::cout << "Expected ESP32 Arduino code format:" << std::endl;
    std::cout << "- Binary mode: SampleRecord struct (timestamp, channel, voltage, etc.)"
              << std::endl;
    std::cout << "- Text mode: Space-separated voltage values per line" << std::endl;
    std::cout << "- Supports up to 10 PT sensors (channels 0-9)" << std::endl;
    std::cout << "- Only pressure readings are used (no temperature)" << std::endl;
    std::cout << "\nMake sure your ESP32 is connected and sending data!" << std::endl;

    // Keep running until stopped
    while (g_example->isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    std::cout << "PT integration example completed." << std::endl;
    return 0;
}
