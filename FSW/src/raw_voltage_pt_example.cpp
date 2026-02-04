/**
 * @file raw_voltage_pt_example.cpp
 * @brief Raw voltage PT sensor integration example
 *
 * This example demonstrates:
 * 1. Connecting to ESP32 via serial port for PT sensors only
 * 2. Receiving raw voltage data from 9 specific PT locations
 * 3. Building observation matrices for engine control with raw voltage data
 * 4. Handling dynamic sensor availability
 */

#include <signal.h>

#include <chrono>
#include <iostream>
#include <map>
#include <memory>
#include <thread>
#include <vector>

#include "ESP32SerialHandler.hpp"
#include "PTMessage.hpp"
#include "PTObservationMatrix.hpp"
#include "Timer.hpp"

class RawVoltagePTExample {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::shared_ptr<PTObservationMatrixBuilder> pt_observation_builder_;
    std::atomic<bool> running_;
    std::thread processing_thread_;

public:
    RawVoltagePTExample() : running_(false) {
        // Create ESP32 handler for serial communication
        esp32_handler_ = createESP32Handler("/dev/ttyUSB0", 115200);

        // Create PT observation matrix builder
        auto config = getDefaultPTObservationMatrixConfig();
        config.max_data_age_ms = 1000.0;  // 1 second timeout
        config.enable_outlier_detection = true;
        config.outlier_threshold_sigma = 3.0;
        config.max_pt_sensors = 9;  // 9 PT sensors (0-8)
        pt_observation_builder_ = std::make_shared<PTObservationMatrixBuilder>(config);

        // Register callback for PT sensor data
        esp32_handler_->registerPTCallback([this](uint8_t sensor_id, double raw_voltage_v,
                                                  uint64_t timestamp, uint8_t pt_location) {
            this->onPTData(sensor_id, raw_voltage_v, timestamp, pt_location);
        });
    }

    ~RawVoltagePTExample() {
        stop();
    }

    bool start() {
        if (running_) {
            return true;
        }

        std::cout << "Starting Raw Voltage PT integration example..." << std::endl;
        printPTLocationMapping();

        // Start ESP32 handler
        if (!esp32_handler_->start()) {
            std::cerr << "Failed to start ESP32 handler" << std::endl;
            return false;
        }

        // Start processing thread
        running_ = true;
        processing_thread_ = std::thread(&RawVoltagePTExample::processingLoop, this);

        std::cout << "Raw Voltage PT integration example started successfully" << std::endl;
        return true;
    }

    void stop() {
        if (!running_) {
            return;
        }

        std::cout << "Stopping Raw Voltage PT integration example..." << std::endl;
        running_ = false;

        // Stop ESP32 handler
        esp32_handler_->stop();

        // Wait for processing thread
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }

        std::cout << "Raw Voltage PT integration example stopped" << std::endl;
    }

    bool isRunning() const {
        return running_;
    }

private:
    void printPTLocationMapping() {
        std::cout << "\n=== PT Sensor Location Mapping ===" << std::endl;
        std::cout << "Channel 0: Pressurant Tank PT" << std::endl;
        std::cout << "Channel 1: Kero Inlet PT" << std::endl;
        std::cout << "Channel 2: Kero Outlet PT" << std::endl;
        std::cout << "Channel 3: Lox Inlet PT" << std::endl;
        std::cout << "Channel 4: Lox Outlet PT" << std::endl;
        std::cout << "Channel 5: Injector PT" << std::endl;
        std::cout << "Channel 6: Chamber Wall PT #1" << std::endl;
        std::cout << "Channel 7: Chamber Wall PT #2" << std::endl;
        std::cout << "Channel 8: Nozzle Exit PT" << std::endl;
        std::cout << "===================================" << std::endl;
    }

    void onPTData(uint8_t sensor_id, double raw_voltage_v, uint64_t timestamp,
                  uint8_t pt_location) {
        PTLocation location = static_cast<PTLocation>(pt_location);
        std::string location_name = getPTLocationName(location);

        std::cout << "Received PT data - Sensor " << static_cast<int>(sensor_id) << " ("
                  << location_name << "): " << raw_voltage_v << "V" << std::endl;
    }

    void processingLoop() {
        std::cout << "Raw Voltage PT processing loop started" << std::endl;

        while (running_) {
            try {
                // Get active PT sensors
                auto active_sensors = esp32_handler_->getActiveSensors();

                if (!active_sensors.empty()) {
                    std::cout << "\n=== Raw Voltage PT Sensor Status ===" << std::endl;
                    std::cout << "Active PT sensors: ";
                    for (uint8_t sensor_id : active_sensors) {
                        std::cout << static_cast<int>(sensor_id) << " ";
                    }
                    std::cout << std::endl;

                    // Build observation matrix for engine control
                    buildEngineObservationMatrix();

                    // Build observation matrix for specific engine locations
                    buildEngineLocationObservationMatrix();

                    // Print PT sensor statistics
                    printPTSensorStatistics();
                }

                // Sleep for 100ms
                std::this_thread::sleep_for(std::chrono::milliseconds(100));

            } catch (const std::exception& e) {
                std::cerr << "Error in Raw Voltage PT processing loop: " << e.what() << std::endl;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            }
        }

        std::cout << "Raw Voltage PT processing loop stopped" << std::endl;
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

        // Build observation matrix for engine states (9-state model for 9 PT sensors)
        auto result = pt_observation_builder_->buildEngineStateObservationMatrix(9);

        if (result.valid) {
            std::cout << "\n=== Engine Observation Matrix (Raw Voltage) ===" << std::endl;
            std::cout << "Matrix dimensions: " << result.observation_matrix.rows() << " x "
                      << result.observation_matrix.cols() << std::endl;
            std::cout << "Raw voltage measurements: " << result.measurement_vector.size()
                      << std::endl;
            std::cout << "PT sensors used: ";
            for (uint8_t sensor_id : result.sensor_ids) {
                std::cout << static_cast<int>(sensor_id) << " ";
            }
            std::cout << std::endl;

            // Print raw voltage readings
            std::cout << "Raw voltage readings (V): [";
            for (int i = 0; i < result.measurement_vector.size(); ++i) {
                std::cout << result.measurement_vector(i);
                if (i < result.measurement_vector.size() - 1)
                    std::cout << ", ";
            }
            std::cout << "]" << std::endl;

            // Example: Use in Kalman filter (with raw voltage data)
            // Note: You would apply calibration here to convert voltage to pressure
            // kalman_filter.update(result.measurement_vector, result.observation_matrix,
            // result.measurement_covariance);

        } else {
            std::cout << "Failed to build engine observation matrix: " << result.error_message
                      << std::endl;
        }
    }

    void buildEngineLocationObservationMatrix() {
        // Example: Map specific engine locations to state indices
        std::map<size_t, uint8_t> sensor_locations;
        sensor_locations[0] = 0;  // Pressurant Tank -> state[0]
        sensor_locations[1] = 1;  // Kero Inlet -> state[1]
        sensor_locations[2] = 2;  // Kero Outlet -> state[2]
        sensor_locations[3] = 3;  // Lox Inlet -> state[3]
        sensor_locations[4] = 4;  // Lox Outlet -> state[4]
        sensor_locations[5] = 5;  // Injector -> state[5]
        sensor_locations[6] = 6;  // Chamber Wall #1 -> state[6]
        sensor_locations[7] = 7;  // Chamber Wall #2 -> state[7]
        sensor_locations[8] = 8;  // Nozzle Exit -> state[8]

        auto result = pt_observation_builder_->buildCustomObservationMatrix(sensor_locations, 9);

        if (result.valid) {
            std::cout << "\n=== Engine Location Observation Matrix ===" << std::endl;
            std::cout << "Location matrix dimensions: " << result.observation_matrix.rows() << " x "
                      << result.observation_matrix.cols() << std::endl;
            std::cout << "Mapped locations: ";
            for (const auto& pair : sensor_locations) {
                uint8_t sensor_id = pair.second;
                PTLocation location = static_cast<PTLocation>(sensor_id);
                std::cout << "state[" << pair.first << "]<-" << getPTLocationName(location) << " ";
            }
            std::cout << std::endl;
        } else {
            std::cout << "Engine location observation matrix not available: "
                      << result.error_message << std::endl;
        }
    }

    void printPTSensorStatistics() {
        auto stats = esp32_handler_->getSensorStatistics();

        std::cout << "\n=== Raw Voltage PT Sensor Statistics ===" << std::endl;
        for (const auto& sensor_pair : stats) {
            uint8_t sensor_id = sensor_pair.first;
            const auto& sensor_stats = sensor_pair.second;

            PTLocation location = static_cast<PTLocation>(sensor_id);
            std::string location_name = getPTLocationName(location);

            std::cout << "PT Sensor " << static_cast<int>(sensor_id) << " (" << location_name
                      << "):" << std::endl;

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
    }
};

// Global instance for signal handling
std::unique_ptr<RawVoltagePTExample> g_example;

void signalHandler(int signal) {
    std::cout << "\nReceived signal " << signal << ", shutting down..." << std::endl;
    if (g_example) {
        g_example->stop();
    }
}

int main(int argc, char* argv[]) {
    std::cout << "Raw Voltage PT Integration Example for Diablo FSW" << std::endl;
    std::cout << "================================================" << std::endl;

    // Set up signal handling
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Create and start example
    g_example = std::make_unique<RawVoltagePTExample>();

    // Override device path if provided
    if (argc > 1) {
        std::string device_path = argv[1];
        std::cout << "Using device: " << device_path << std::endl;
        // Note: In a real implementation, you'd pass the device path to the constructor
    }

    if (!g_example->start()) {
        std::cerr << "Failed to start Raw Voltage PT integration example" << std::endl;
        return 1;
    }

    std::cout << "\nRaw Voltage PT integration example running. Press Ctrl+C to stop." << std::endl;
    std::cout << "Expected ESP32 Arduino code format:" << std::endl;
    std::cout << "- Binary mode: SampleRecord struct (timestamp, channel, voltage, etc.)"
              << std::endl;
    std::cout << "- Text mode: Space-separated voltage values per line" << std::endl;
    std::cout << "- Supports 9 PT sensors (channels 0-8) mapped to specific engine locations"
              << std::endl;
    std::cout << "- Raw voltage readings (calibration applied later in your algorithms)"
              << std::endl;
    std::cout << "\nMake sure your ESP32 is connected and sending data!" << std::endl;

    // Keep running until stopped
    while (g_example->isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    std::cout << "Raw Voltage PT integration example completed." << std::endl;
    return 0;
}
