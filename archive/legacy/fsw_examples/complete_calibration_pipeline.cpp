/**
 * @file complete_calibration_pipeline.cpp
 * @brief Complete PT Calibration Pipeline
 *
 * This executable demonstrates the complete calibration pipeline:
 * 1. ESP32 data acquisition
 * 2. Smart calibration with human-in-the-loop
 * 3. Progressive autonomy
 * 4. Real-time monitoring
 */

#include <signal.h>

#include <atomic>
#include <chrono>
#include <iomanip>
#include <iostream>
#include <memory>
#include <thread>

#include "ESP32ConfigParser.hpp"
#include "ESP32SerialHandler.hpp"
#include "PTCalibrationFramework.hpp"
#include "PTMessage.hpp"
#include "SmartCalibrationSystem.hpp"

class CompleteCalibrationPipeline {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::shared_ptr<SmartCalibrationSystem> smart_calibration_;
    std::atomic<bool> running_;
    std::thread processing_thread_;

public:
    CompleteCalibrationPipeline() : running_(false) {
    }

    ~CompleteCalibrationPipeline() {
        stop();
    }

    bool start(const std::string& config_path = "") {
        if (running_) {
            return true;
        }

        std::cout << "Starting Complete PT Calibration Pipeline..." << std::endl;

        // Load ESP32 configuration
        auto [handler, pt_builder, config] = createESP32SystemFromConfig(config_path);

        if (!handler || !config) {
            std::cerr << "Failed to create ESP32 system from configuration" << std::endl;
            return false;
        }

        esp32_handler_ = handler;

        // Create smart calibration system
        smart_calibration_ = createSmartCalibrationSystem("environmental_robust");

        // Register callbacks
        smart_calibration_->registerHumanInputCallback([this](const HumanInputRequest& request) {
            this->onHumanInputRequest(request);
        });

        smart_calibration_->registerConfidenceChangeCallback(
            [this](uint8_t sensor_id, CalibrationConfidence new_confidence) {
                this->onConfidenceChange(sensor_id, new_confidence);
            });

        // Register ESP32 PT callback
        esp32_handler_->registerPTCallback(
            [this](uint8_t sensor_id, double voltage, uint64_t timestamp, uint8_t pt_location) {
                this->onPTMeasurement(sensor_id, voltage, timestamp, pt_location);
            });

        // Start ESP32 handler
        if (!esp32_handler_->start()) {
            std::cerr << "Failed to start ESP32 handler on device: " << config->device_path
                      << std::endl;
            return false;
        }

        // Start processing thread
        running_ = true;
        processing_thread_ = std::thread(&CompleteCalibrationPipeline::processingLoop, this);

        std::cout << "Complete PT Calibration Pipeline started successfully" << std::endl;
        return true;
    }

    void stop() {
        if (!running_) {
            return;
        }

        std::cout << "Stopping Complete PT Calibration Pipeline..." << std::endl;
        running_ = false;

        // Stop ESP32 handler
        if (esp32_handler_) {
            esp32_handler_->stop();
        }

        // Wait for processing thread
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }

        std::cout << "Complete PT Calibration Pipeline stopped" << std::endl;
    }

    bool isRunning() const {
        return running_;
    }

    void printStatus() const {
        std::cout << "\n=== Calibration Pipeline Status ===" << std::endl;

        // Print sensor statistics
        auto stats = smart_calibration_->getCalibrationStatistics();

        for (const auto& sensor_pair : stats) {
            uint8_t sensor_id = sensor_pair.first;
            const auto& sensor_stats = sensor_pair.second;

            std::string location_name = getPTLocationName(static_cast<PTLocation>(sensor_id));
            CalibrationConfidence confidence =
                smart_calibration_->getCalibrationConfidence(sensor_id);
            double reliability = smart_calibration_->getReliabilityScore(sensor_id);

            std::cout << "PT " << static_cast<int>(sensor_id) << " (" << location_name
                      << "):" << std::endl;
            std::cout << "  Confidence Level: " << static_cast<int>(confidence) << std::endl;
            std::cout << "  Reliability Score: " << std::fixed << std::setprecision(2)
                      << reliability * 100 << "%" << std::endl;
            std::cout << "  Human Inputs: "
                      << static_cast<int>(sensor_stats.at("human_input_count")) << std::endl;
            std::cout << "  Success Rate: " << std::fixed << std::setprecision(1)
                      << sensor_stats.at("autonomous_success_rate") * 100 << "%" << std::endl;
            std::cout << "  Data Points: "
                      << static_cast<int>(sensor_stats.at("calibration_data_points")) << std::endl;
            std::cout << "  Needs Human Input: "
                      << (smart_calibration_->needsHumanInput(sensor_id) ? "Yes" : "No")
                      << std::endl;
        }

        // Print pending requests
        auto pending_requests = smart_calibration_->getPendingRequests();
        if (!pending_requests.empty()) {
            std::cout << "\nPending Human Input Requests:" << std::endl;
            for (const auto& request : pending_requests) {
                std::cout << "  PT " << static_cast<int>(request.sensor_id) << ": "
                          << request.current_voltage << "V -> " << request.predicted_pressure
                          << "Pa (" << request.reason << ")" << std::endl;
            }
        }

        std::cout << "================================" << std::endl;
    }

private:
    void onPTMeasurement(uint8_t sensor_id, double voltage, uint64_t timestamp,
                         uint8_t pt_location) {
        // Create environmental state (could be enhanced with actual sensors)
        EnvironmentalState environment;
        environment.temperature = 25.0;     // Could read from temperature sensor
        environment.humidity = 50.0;        // Could read from humidity sensor
        environment.vibration_level = 0.1;  // Could read from accelerometer
        environment.aging_factor = 0.0;
        environment.mounting_torque = 1.0;

        // Process measurement through smart calibration system
        auto [predicted_pressure, needs_human_input] =
            smart_calibration_->processMeasurement(sensor_id, voltage, timestamp, environment);

        if (needs_human_input) {
            std::cout << "HUMAN INPUT NEEDED: PT " << static_cast<int>(sensor_id)
                      << " - Voltage: " << voltage << "V, Predicted: " << predicted_pressure << "Pa"
                      << std::endl;
        } else {
            std::cout << "Autonomous: PT " << static_cast<int>(sensor_id)
                      << " - Voltage: " << voltage << "V, Pressure: " << predicted_pressure << "Pa"
                      << std::endl;
        }
    }

    void onHumanInputRequest(const HumanInputRequest& request) {
        std::cout << "\n=== HUMAN INPUT REQUEST ===" << std::endl;
        std::cout << "Sensor ID: " << static_cast<int>(request.sensor_id) << std::endl;
        std::cout << "Current Voltage: " << request.current_voltage << " V" << std::endl;
        std::cout << "Predicted Pressure: " << request.predicted_pressure << " Pa" << std::endl;
        std::cout << "Confidence Interval: [" << request.confidence_interval_lower << ", "
                  << request.confidence_interval_upper << "] Pa" << std::endl;
        std::cout << "Reason: " << request.reason << std::endl;
        std::cout << "=========================" << std::endl;

        // In a real implementation, this would trigger the GUI or wait for user input
        // For demonstration, we'll simulate human input after a delay
        std::thread([this, request]() {
            std::this_thread::sleep_for(std::chrono::seconds(2));
            simulateHumanInput(request);
        }).detach();
    }

    void simulateHumanInput(const HumanInputRequest& request) {
        // Simulate human input with some noise
        double human_pressure = request.predicted_pressure + (rand() % 100 - 50);  // ±50 Pa noise

        // Create environmental state
        EnvironmentalState environment;
        environment.temperature = 25.0;
        environment.humidity = 50.0;
        environment.vibration_level = 0.1;
        environment.aging_factor = 0.0;
        environment.mounting_torque = 1.0;

        // Provide human input to smart calibration system
        smart_calibration_->provideHumanInput(
            request.sensor_id, request.current_voltage, human_pressure,
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::system_clock::now().time_since_epoch())
                .count(),
            environment);

        std::cout << "HUMAN INPUT PROVIDED: PT " << static_cast<int>(request.sensor_id)
                  << " - Reference Pressure: " << human_pressure << " Pa" << std::endl;
    }

    void onConfidenceChange(uint8_t sensor_id, CalibrationConfidence new_confidence) {
        std::string confidence_name;
        switch (new_confidence) {
            case CalibrationConfidence::LOW:
                confidence_name = "LOW";
                break;
            case CalibrationConfidence::MEDIUM:
                confidence_name = "MEDIUM";
                break;
            case CalibrationConfidence::HIGH:
                confidence_name = "HIGH";
                break;
            case CalibrationConfidence::MAXIMUM:
                confidence_name = "MAXIMUM";
                break;
        }

        std::cout << "CONFIDENCE CHANGE: PT " << static_cast<int>(sensor_id) << " -> "
                  << confidence_name << " confidence" << std::endl;
    }

    void processingLoop() {
        std::cout << "Calibration processing loop started" << std::endl;

        while (running_) {
            try {
                // Get active sensors
                auto active_sensors = esp32_handler_->getActiveSensors();

                if (!active_sensors.empty()) {
                    // Print status every 10 seconds
                    static auto last_status_time = std::chrono::steady_clock::now();
                    auto now = std::chrono::steady_clock::now();
                    if (std::chrono::duration_cast<std::chrono::seconds>(now - last_status_time)
                            .count() >= 10) {
                        printStatus();
                        last_status_time = now;
                    }
                }

                // Sleep for 100ms
                std::this_thread::sleep_for(std::chrono::milliseconds(100));

            } catch (const std::exception& e) {
                std::cerr << "Error in calibration processing loop: " << e.what() << std::endl;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            }
        }

        std::cout << "Calibration processing loop stopped" << std::endl;
    }
};

// Global instance for signal handling
std::unique_ptr<CompleteCalibrationPipeline> g_pipeline;

void signalHandler(int signal) {
    std::cout << "\nReceived signal " << signal << ", shutting down..." << std::endl;
    if (g_pipeline) {
        g_pipeline->stop();
    }
}

void printUsage(const char* program_name) {
    std::cout << "Usage: " << program_name << " [options]" << std::endl;
    std::cout << "Options:" << std::endl;
    std::cout
        << "  -c, --config <path>    Configuration file path (default: config/esp32_config.toml)"
        << std::endl;
    std::cout << "  --status               Show current status and exit" << std::endl;
    std::cout << "  -h, --help             Show this help message" << std::endl;
    std::cout << std::endl;
    std::cout << "Examples:" << std::endl;
    std::cout << "  " << program_name << "                                    # Use default config"
              << std::endl;
    std::cout << "  " << program_name << " -c /path/to/config.toml           # Use custom config"
              << std::endl;
    std::cout << "  " << program_name << " --status                           # Show status"
              << std::endl;
    std::cout << std::endl;
    std::cout << "This program demonstrates the complete PT calibration pipeline:" << std::endl;
    std::cout << "1. Connects to ESP32 sensors via serial" << std::endl;
    std::cout << "2. Processes real-time voltage measurements" << std::endl;
    std::cout << "3. Requests human input when needed for calibration" << std::endl;
    std::cout << "4. Gradually becomes autonomous as confidence increases" << std::endl;
    std::cout << "5. Provides real-time monitoring and statistics" << std::endl;
}

int main(int argc, char* argv[]) {
    std::cout << "Complete PT Calibration Pipeline for Diablo FSW" << std::endl;
    std::cout << "===============================================" << std::endl;

    // Parse command line arguments
    std::string config_path;
    bool show_status_only = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == "-c" || arg == "--config") {
            if (i + 1 < argc) {
                config_path = argv[++i];
            } else {
                std::cerr << "Error: --config requires a path argument" << std::endl;
                return 1;
            }
        } else if (arg == "--status") {
            show_status_only = true;
        } else if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        } else {
            std::cerr << "Error: Unknown argument " << arg << std::endl;
            printUsage(argv[0]);
            return 1;
        }
    }

    try {
        // Set up signal handling
        signal(SIGINT, signalHandler);
        signal(SIGTERM, signalHandler);

        // Create and start pipeline
        g_pipeline = std::make_unique<CompleteCalibrationPipeline>();

        if (!g_pipeline->start(config_path)) {
            std::cerr << "Failed to start calibration pipeline" << std::endl;
            return 1;
        }

        if (show_status_only) {
            // Show status and exit
            std::this_thread::sleep_for(std::chrono::seconds(2));
            g_pipeline->printStatus();
            return 0;
        }

        std::cout << "\nCalibration pipeline running. Press Ctrl+C to stop." << std::endl;
        std::cout << "Configuration loaded from: "
                  << (config_path.empty() ? "default" : config_path) << std::endl;
        std::cout << "\nThe system will:" << std::endl;
        std::cout << "1. Connect to ESP32 sensors and receive voltage data" << std::endl;
        std::cout << "2. Request human input when calibration data is insufficient" << std::endl;
        std::cout << "3. Gradually become autonomous as confidence increases" << std::endl;
        std::cout << "4. Provide real-time pressure predictions with uncertainty" << std::endl;
        std::cout << "\nMake sure your ESP32 is connected and sending data!" << std::endl;

        // Keep running until stopped
        while (g_pipeline->isRunning()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        std::cout << "Calibration pipeline completed." << std::endl;

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
