/**
 * @file configurable_pt_example.cpp
 * @brief Configurable PT sensor integration example
 *
 * This example demonstrates:
 * 1. Loading ESP32 configuration from TOML file
 * 2. Creating ESP32 handler and observation matrix builder from config
 * 3. Handling configurable COM port and other settings
 * 4. Using configuration for PT sensor system
 */

#include <signal.h>

#include <chrono>
#include <iostream>
#include <map>
#include <memory>
#include <thread>
#include <vector>

#include "ESP32ConfigParser.hpp"
#include "PTMessage.hpp"
#include "Timer.hpp"

class ConfigurablePTExample {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::shared_ptr<PTObservationMatrixBuilder> pt_observation_builder_;
    std::shared_ptr<ESP32SystemConfig> config_;
    std::atomic<bool> running_;
    std::thread processing_thread_;

public:
    ConfigurablePTExample() : running_(false) {
    }

    ~ConfigurablePTExample() {
        stop();
    }

    bool start(const std::string& config_path = "") {
        if (running_) {
            return true;
        }

        std::cout << "Starting Configurable PT integration example..." << std::endl;

        // Load configuration
        auto [handler, builder, cfg] = createESP32SystemFromConfig(config_path);

        if (!handler || !builder || !cfg) {
            std::cerr << "Failed to create ESP32 system from configuration" << std::endl;
            return false;
        }

        esp32_handler_ = handler;
        pt_observation_builder_ = builder;
        config_ = cfg;

        // Print configuration summary
        printConfigurationSummary();

        // Register callback for PT sensor data
        esp32_handler_->registerPTCallback([this](uint8_t sensor_id, double raw_voltage_v,
                                                  uint64_t timestamp, uint8_t pt_location) {
            this->onPTData(sensor_id, raw_voltage_v, timestamp, pt_location);
        });

        // Start ESP32 handler
        if (!esp32_handler_->start()) {
            std::cerr << "Failed to start ESP32 handler on device: " << config_->device_path
                      << std::endl;
            return false;
        }

        // Start processing thread
        running_ = true;
        processing_thread_ = std::thread(&ConfigurablePTExample::processingLoop, this);

        std::cout << "Configurable PT integration example started successfully" << std::endl;
        return true;
    }

    void stop() {
        if (!running_) {
            return;
        }

        std::cout << "Stopping Configurable PT integration example..." << std::endl;
        running_ = false;

        // Stop ESP32 handler
        if (esp32_handler_) {
            esp32_handler_->stop();
        }

        // Wait for processing thread
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }

        std::cout << "Configurable PT integration example stopped" << std::endl;
    }

    bool isRunning() const {
        return running_;
    }

    void printConfiguration() const {
        if (!config_) {
            std::cout << "No configuration loaded" << std::endl;
            return;
        }

        std::cout << "\n=== Current Configuration ===" << std::endl;
        std::cout << "Device Path: " << config_->device_path << std::endl;
        std::cout << "Baud Rate: " << config_->baud_rate << std::endl;
        std::cout << "Timeout: " << config_->timeout_ms << " ms" << std::endl;
        std::cout << "Binary Mode: " << (config_->enable_binary_mode ? "Enabled" : "Disabled")
                  << std::endl;
        std::cout << "Max PT Sensors: " << config_->max_pt_sensors << std::endl;
        std::cout << "Max Data Age: " << config_->max_data_age_ms << " ms" << std::endl;
        std::cout << "Outlier Detection: "
                  << (config_->enable_outlier_detection ? "Enabled" : "Disabled") << std::endl;
        std::cout << "Debug Output: " << (config_->enable_debug_output ? "Enabled" : "Disabled")
                  << std::endl;
        std::cout << "=============================" << std::endl;
    }

private:
    void printConfigurationSummary() {
        std::cout << "\n=== Configuration Summary ===" << std::endl;
        std::cout << "Using device: " << config_->device_path << std::endl;
        std::cout << "Baud rate: " << config_->baud_rate << std::endl;
        std::cout << "Mode: " << (config_->enable_binary_mode ? "Binary" : "Text") << std::endl;
        std::cout << "Max PT sensors: " << config_->max_pt_sensors << std::endl;

        if (config_->enable_debug_output) {
            std::cout << "\n=== PT Location Mapping ===" << std::endl;
            for (const auto& pair : config_->pt_location_mapping) {
                std::cout << "Channel " << static_cast<int>(pair.first) << ": " << pair.second
                          << std::endl;
            }
        }
        std::cout << "=============================" << std::endl;
    }

    void onPTData(uint8_t sensor_id, double raw_voltage_v, uint64_t timestamp,
                  uint8_t pt_location) {
        PTLocation location = static_cast<PTLocation>(pt_location);
        std::string location_name = getPTLocationName(location);

        if (config_->print_raw_data) {
            std::cout << "PT Data - Sensor " << static_cast<int>(sensor_id) << " (" << location_name
                      << "): " << raw_voltage_v << "V" << std::endl;
        }
    }

    void processingLoop() {
        std::cout << "Configurable PT processing loop started" << std::endl;

        while (running_) {
            try {
                // Get active PT sensors
                auto active_sensors = esp32_handler_->getActiveSensors();

                if (!active_sensors.empty()) {
                    if (config_->enable_debug_output) {
                        std::cout << "\n=== Active PT Sensors ===" << std::endl;
                        std::cout << "Active sensors: ";
                        for (uint8_t sensor_id : active_sensors) {
                            std::cout << static_cast<int>(sensor_id) << " ";
                        }
                        std::cout << std::endl;
                    }

                    // Build observation matrix for engine control
                    buildEngineObservationMatrix();

                    // Print PT sensor statistics if debug enabled
                    if (config_->enable_debug_output) {
                        printPTSensorStatistics();
                    }
                }

                // Sleep for 100ms
                std::this_thread::sleep_for(std::chrono::milliseconds(100));

            } catch (const std::exception& e) {
                std::cerr << "Error in Configurable PT processing loop: " << e.what() << std::endl;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            }
        }

        std::cout << "Configurable PT processing loop stopped" << std::endl;
    }

    void buildEngineObservationMatrix() {
        // Get all recent PT sensor data
        auto recent_data =
            esp32_handler_->getAllRecentSensorData(static_cast<uint32_t>(config_->max_data_age_ms));

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

        // Build observation matrix for engine states
        auto result =
            pt_observation_builder_->buildEngineStateObservationMatrix(config_->max_pt_sensors);

        if (result.valid) {
            if (config_->print_observation_matrices) {
                std::cout << "\n=== Engine Observation Matrix ===" << std::endl;
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
            }

            // Example: Use in Kalman filter (with raw voltage data)
            // Note: You would apply calibration here to convert voltage to pressure
            // kalman_filter.update(result.measurement_vector, result.observation_matrix,
            // result.measurement_covariance);

        } else {
            if (config_->enable_debug_output) {
                std::cout << "Failed to build engine observation matrix: " << result.error_message
                          << std::endl;
            }
        }
    }

    void printPTSensorStatistics() {
        auto stats = esp32_handler_->getSensorStatistics();

        std::cout << "\n=== PT Sensor Statistics ===" << std::endl;
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
std::unique_ptr<ConfigurablePTExample> g_example;

void signalHandler(int signal) {
    std::cout << "\nReceived signal " << signal << ", shutting down..." << std::endl;
    if (g_example) {
        g_example->stop();
    }
}

void printUsage(const char* program_name) {
    std::cout << "Usage: " << program_name << " [options]" << std::endl;
    std::cout << "Options:" << std::endl;
    std::cout
        << "  -c, --config <path>    Configuration file path (default: config/esp32_config.toml)"
        << std::endl;
    std::cout << "  --create-config        Create default configuration file and exit" << std::endl;
    std::cout << "  --show-config          Show current configuration and exit" << std::endl;
    std::cout << "  -h, --help             Show this help message" << std::endl;
    std::cout << std::endl;
    std::cout << "Examples:" << std::endl;
    std::cout << "  " << program_name << "                                    # Use default config"
              << std::endl;
    std::cout << "  " << program_name << " -c /path/to/config.toml           # Use custom config"
              << std::endl;
    std::cout << "  " << program_name
              << " --create-config                   # Create default config file" << std::endl;
}

int main(int argc, char* argv[]) {
    std::cout << "Configurable PT Integration Example for Diablo FSW" << std::endl;
    std::cout << "=================================================" << std::endl;

    // Parse command line arguments
    std::string config_path;
    bool create_config = false;
    bool show_config = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == "-c" || arg == "--config") {
            if (i + 1 < argc) {
                config_path = argv[++i];
            } else {
                std::cerr << "Error: --config requires a path argument" << std::endl;
                return 1;
            }
        } else if (arg == "--create-config") {
            create_config = true;
        } else if (arg == "--show-config") {
            show_config = true;
        } else if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        } else {
            std::cerr << "Error: Unknown argument " << arg << std::endl;
            printUsage(argv[0]);
            return 1;
        }
    }

    // Handle special commands
    if (create_config) {
        std::string path = config_path.empty() ? "config/esp32_config.toml" : config_path;
        if (createDefaultConfigFile(path)) {
            std::cout << "Default configuration file created: " << path << std::endl;
            std::cout << "Edit the file to configure your ESP32 settings." << std::endl;
        } else {
            std::cerr << "Failed to create configuration file: " << path << std::endl;
            return 1;
        }
        return 0;
    }

    if (show_config) {
        ConfigurablePTExample example;
        if (example.start(config_path)) {
            example.printConfiguration();
            example.stop();
        } else {
            std::cerr << "Failed to load configuration" << std::endl;
            return 1;
        }
        return 0;
    }

    // Set up signal handling
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Create and start example
    g_example = std::make_unique<ConfigurablePTExample>();

    if (!g_example->start(config_path)) {
        std::cerr << "Failed to start Configurable PT integration example" << std::endl;
        return 1;
    }

    std::cout << "\nConfigurable PT integration example running. Press Ctrl+C to stop."
              << std::endl;
    std::cout << "Configuration loaded from: " << (config_path.empty() ? "default" : config_path)
              << std::endl;
    std::cout << "\nMake sure your ESP32 is connected and sending data!" << std::endl;

    // Keep running until stopped
    while (g_example->isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    std::cout << "Configurable PT integration example completed." << std::endl;
    return 0;
}
