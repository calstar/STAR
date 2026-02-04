/**
 * @file esp32_integration_example.cpp
 * @brief Example integration of ESP32 serial communication with sensor fusion
 *
 * This example demonstrates:
 * 1. Connecting to ESP32 via serial port
 * 2. Receiving sensor data in Arduino SampleRecord format
 * 3. Building observation matrices for sensor fusion
 * 4. Handling dynamic sensor availability
 */

#include <signal.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <thread>
#include <vector>

#include "ESP32SerialHandler.hpp"
#include "ObservationMatrix.hpp"
#include "Timer.hpp"

class ESP32IntegrationExample {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::shared_ptr<ObservationMatrixBuilder> observation_builder_;
    std::atomic<bool> running_;
    std::thread processing_thread_;

public:
    ESP32IntegrationExample() : running_(false) {
        // Create ESP32 handler for serial communication
        esp32_handler_ = createESP32Handler("/dev/ttyUSB0", 115200);

        // Create observation matrix builder
        auto config = getDefaultObservationMatrixConfig();
        config.max_data_age_ms = 1000.0;  // 1 second
        config.enable_outlier_detection = true;
        config.outlier_threshold_sigma = 3.0;
        observation_builder_ = std::make_shared<ObservationMatrixBuilder>(config);

        // Register callback for sensor data
        esp32_handler_->registerPTCallback([this](uint8_t sensor_id, double raw_voltage_v,
                                                  uint64_t timestamp, uint8_t pt_location) {
            this->onSensorData(sensor_id, raw_voltage_v, timestamp, pt_location);
        });
    }

    ~ESP32IntegrationExample() {
        stop();
    }

    bool start() {
        if (running_) {
            return true;
        }

        std::cout << "Starting ESP32 integration example..." << std::endl;

        // Start ESP32 handler
        if (!esp32_handler_->start()) {
            std::cerr << "Failed to start ESP32 handler" << std::endl;
            return false;
        }

        // Start processing thread
        running_ = true;
        processing_thread_ = std::thread(&ESP32IntegrationExample::processingLoop, this);

        std::cout << "ESP32 integration example started successfully" << std::endl;
        return true;
    }

    void stop() {
        if (!running_) {
            return;
        }

        std::cout << "Stopping ESP32 integration example..." << std::endl;
        running_ = false;

        // Stop ESP32 handler
        esp32_handler_->stop();

        // Wait for processing thread
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }

        std::cout << "ESP32 integration example stopped" << std::endl;
    }

    bool isRunning() const {
        return running_;
    }

private:
    void onSensorData(uint8_t sensor_id, double raw_voltage_v, uint64_t timestamp,
                      uint8_t pt_location) {
        std::cout << "Received sensor data - ID: " << static_cast<int>(sensor_id)
                  << ", Voltage: " << raw_voltage_v
                  << "V, Location: " << static_cast<int>(pt_location) << std::endl;
    }

    void processingLoop() {
        std::cout << "Processing loop started" << std::endl;

        while (running_) {
            try {
                // Get active sensors
                auto active_sensors = esp32_handler_->getActiveSensors();

                if (!active_sensors.empty()) {
                    std::cout << "Active sensors: ";
                    for (uint8_t sensor_id : active_sensors) {
                        std::cout << static_cast<int>(sensor_id) << " ";
                    }
                    std::cout << std::endl;

                    // Build observation matrix for engine state estimation
                    buildEngineObservationMatrix();

                    // Build observation matrix for navigation
                    buildNavigationObservationMatrix();

                    // Print sensor statistics
                    printSensorStatistics();
                }

                // Sleep for 100ms
                std::this_thread::sleep_for(std::chrono::milliseconds(100));

            } catch (const std::exception& e) {
                std::cerr << "Error in processing loop: " << e.what() << std::endl;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            }
        }

        std::cout << "Processing loop stopped" << std::endl;
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
        observation_builder_->clear();
        observation_builder_->addPTSensors(pt_messages, true,
                                           true);  // Use pressure and temperature

        // Build observation matrix for engine states
        auto result = observation_builder_->buildEngineStateObservationMatrix();

        if (result.valid) {
            std::cout << "Engine observation matrix built successfully:" << std::endl;
            std::cout << "  Measurements: " << result.measurement_vector.size() << std::endl;
            std::cout << "  Sensors used: ";
            for (uint8_t sensor_id : result.sensor_ids) {
                std::cout << static_cast<int>(sensor_id) << " ";
            }
            std::cout << std::endl;
            std::cout << "  Timestamp: " << result.timestamp_ns << " ns" << std::endl;

            // Example: Print measurement vector
            std::cout << "  Measurement vector: [";
            for (int i = 0; i < result.measurement_vector.size(); ++i) {
                std::cout << result.measurement_vector(i);
                if (i < result.measurement_vector.size() - 1)
                    std::cout << ", ";
            }
            std::cout << "]" << std::endl;
        } else {
            std::cout << "Failed to build engine observation matrix: " << result.error_message
                      << std::endl;
        }
    }

    void buildNavigationObservationMatrix() {
        // For navigation, we would typically use IMU, GPS, and barometer data
        // This is a placeholder showing how to build navigation observation matrices

        auto result = observation_builder_->buildNavigationStateObservationMatrix();

        if (result.valid) {
            std::cout << "Navigation observation matrix built with "
                      << result.measurement_vector.size() << " measurements" << std::endl;
        } else {
            std::cout << "Navigation observation matrix not available (no IMU/GPS data)"
                      << std::endl;
        }
    }

    void printSensorStatistics() {
        auto stats = esp32_handler_->getSensorStatistics();

        std::cout << "Sensor Statistics:" << std::endl;
        for (const auto& sensor_pair : stats) {
            uint8_t sensor_id = sensor_pair.first;
            const auto& sensor_stats = sensor_pair.second;

            std::cout << "  Sensor " << static_cast<int>(sensor_id) << ":" << std::endl;

            auto packet_it = sensor_stats.find("packet_count");
            if (packet_it != sensor_stats.end()) {
                std::cout << "    Packets: " << static_cast<int>(packet_it->second) << std::endl;
            }

            auto rate_it = sensor_stats.find("avg_sample_rate");
            if (rate_it != sensor_stats.end()) {
                std::cout << "    Avg Rate: " << rate_it->second << " Hz" << std::endl;
            }

            auto age_it = sensor_stats.find("data_age_ms");
            if (age_it != sensor_stats.end()) {
                std::cout << "    Data Age: " << age_it->second << " ms" << std::endl;
            }
        }
    }
};

// Global instance for signal handling
std::unique_ptr<ESP32IntegrationExample> g_example;

void signalHandler(int signal) {
    std::cout << "\nReceived signal " << signal << ", shutting down..." << std::endl;
    if (g_example) {
        g_example->stop();
    }
}

int main(int argc, char* argv[]) {
    std::cout << "ESP32 Integration Example for Diablo FSW" << std::endl;
    std::cout << "=========================================" << std::endl;

    // Set up signal handling
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Create and start example
    g_example = std::make_unique<ESP32IntegrationExample>();

    // Override device path if provided
    if (argc > 1) {
        std::string device_path = argv[1];
        std::cout << "Using device: " << device_path << std::endl;
        g_example = std::make_unique<ESP32IntegrationExample>();
        // Note: In a real implementation, you'd pass the device path to the constructor
    }

    if (!g_example->start()) {
        std::cerr << "Failed to start ESP32 integration example" << std::endl;
        return 1;
    }

    std::cout << "ESP32 integration example running. Press Ctrl+C to stop." << std::endl;
    std::cout << "Make sure your ESP32 is connected and sending data on the serial port."
              << std::endl;

    // Keep running until stopped
    while (g_example->isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    std::cout << "ESP32 integration example completed." << std::endl;
    return 0;
}
