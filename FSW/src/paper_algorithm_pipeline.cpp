/**
 * @file paper_algorithm_pipeline.cpp
 * @brief Implementation of the Paper's Algorithm Pipeline
 *
 * This executable implements the exact methodology from the LaTeX paper:
 * 1. Algorithm 1: Environmental-Robust Bayesian Calibration (human-in-the-loop training)
 * 2. Algorithm 2: Online Environmental-Adaptive EKF (deployment with confidence)
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
#include "EnvironmentalRobustCalibration.hpp"
#include "PTCalibrationFramework.hpp"
#include "PTMessage.hpp"

class PaperAlgorithmPipeline {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::shared_ptr<HumanInTheLoopCalibrationSystem> calibration_system_;
    std::atomic<bool> running_;
    std::thread processing_thread_;
    std::map<uint8_t, std::shared_ptr<HumanInTheLoopCalibrationSystem>> sensor_calibration_systems_;

public:
    PaperAlgorithmPipeline() : running_(false) {
    }

    ~PaperAlgorithmPipeline() {
        stop();
    }

    bool start(const std::string& config_path = "") {
        if (running_) {
            return true;
        }

        std::cout << "Starting Paper Algorithm Pipeline..." << std::endl;
        std::cout << "Implementing Algorithm 1 & 2 from LaTeX paper" << std::endl;

        // Load ESP32 configuration
        auto [handler, pt_builder, config] = createESP32SystemFromConfig(config_path);

        if (!handler || !config) {
            std::cerr << "Failed to create ESP32 system from configuration" << std::endl;
            return false;
        }

        esp32_handler_ = handler;

        // Create calibration systems for each sensor
        for (uint8_t sensor_id = 0; sensor_id < 9; ++sensor_id) {
            auto calibration_map = createCalibrationMap("environmental_robust");
            sensor_calibration_systems_[sensor_id] =
                std::make_shared<HumanInTheLoopCalibrationSystem>(calibration_map);
        }

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
        processing_thread_ = std::thread(&PaperAlgorithmPipeline::processingLoop, this);

        std::cout << "Paper Algorithm Pipeline started successfully" << std::endl;
        std::cout << "Phase 1: Algorithm 1 (Environmental-Robust Bayesian Calibration)"
                  << std::endl;
        std::cout << "Phase 2: Algorithm 2 (Online Environmental-Adaptive EKF)" << std::endl;

        return true;
    }

    void stop() {
        if (!running_) {
            return;
        }

        std::cout << "Stopping Paper Algorithm Pipeline..." << std::endl;
        running_ = false;

        // Stop ESP32 handler
        if (esp32_handler_) {
            esp32_handler_->stop();
        }

        // Wait for processing thread
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }

        std::cout << "Paper Algorithm Pipeline stopped" << std::endl;
    }

    bool isRunning() const {
        return running_;
    }

    void printAlgorithmStatus() const {
        std::cout << "\n=== Paper Algorithm Status ===" << std::endl;

        for (const auto& sensor_pair : sensor_calibration_systems_) {
            uint8_t sensor_id = sensor_pair.first;
            const auto& calibration_system = sensor_pair.second;

            std::string location_name = getPTLocationName(static_cast<PTLocation>(sensor_id));

            std::cout << "PT " << static_cast<int>(sensor_id) << " (" << location_name
                      << "):" << std::endl;

            if (calibration_system->isInDeploymentPhase()) {
                std::cout << "  Phase: Algorithm 2 (Online Environmental-Adaptive EKF)"
                          << std::endl;
                std::cout << "  Training Confidence: " << std::fixed << std::setprecision(3)
                          << calibration_system->getTrainingConfidence() << std::endl;
                std::cout << "  Change Detected: "
                          << (calibration_system->isChangeDetected() ? "Yes" : "No") << std::endl;
            } else {
                std::cout << "  Phase: Algorithm 1 (Environmental-Robust Bayesian Calibration)"
                          << std::endl;
                std::cout << "  Training Confidence: " << std::fixed << std::setprecision(3)
                          << calibration_system->getTrainingConfidence() << std::endl;
            }

            auto stats = calibration_system->getSystemStatistics();
            std::cout << "  Training Data Points: "
                      << static_cast<int>(stats.at("training_data_points")) << std::endl;
        }

        std::cout << "==============================" << std::endl;
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

        auto calibration_system = sensor_calibration_systems_[sensor_id];

        if (calibration_system->isInDeploymentPhase()) {
            // Phase 2: Algorithm 2 - Online Environmental-Adaptive EKF
            auto [predicted_pressure, uncertainty] =
                calibration_system->processDeploymentMeasurement(voltage, environment);

            std::cout << "Algorithm 2 - PT " << static_cast<int>(sensor_id) << ": " << voltage
                      << "V -> " << predicted_pressure << "Pa (σ=" << std::sqrt(uncertainty) << ")"
                      << std::endl;

            if (calibration_system->isChangeDetected()) {
                std::cout << "  ⚠️  CHANGE DETECTED! GLR test triggered recalibration." << std::endl;
            }

        } else {
            // Phase 1: Algorithm 1 - Environmental-Robust Bayesian Calibration (human-in-the-loop)
            auto [needs_human_input, predicted_pressure] =
                calibration_system->processTrainingMeasurement(voltage, environment);

            if (needs_human_input) {
                std::cout << "\n=== ALGORITHM 1: HUMAN INPUT REQUIRED ===" << std::endl;
                std::cout << "Sensor ID: " << static_cast<int>(sensor_id) << std::endl;
                std::cout << "Location: " << getPTLocationName(static_cast<PTLocation>(sensor_id))
                          << std::endl;
                std::cout << "Current Voltage: " << voltage << " V" << std::endl;
                std::cout << "Please provide reference pressure (Pa): ";

                // Simulate human input for demonstration
                double human_pressure = simulateHumanInput(voltage, sensor_id);

                std::cout << human_pressure << " Pa (simulated)" << std::endl;

                // Provide human input to Algorithm 1
                calibration_system->provideHumanInput(voltage, human_pressure, environment);

                std::cout << "Human input recorded for Algorithm 1 training" << std::endl;
                std::cout << "Training confidence: " << std::fixed << std::setprecision(3)
                          << calibration_system->getTrainingConfidence() << std::endl;
                std::cout << "=======================================" << std::endl;

            } else {
                std::cout << "Algorithm 1 - PT " << static_cast<int>(sensor_id) << ": " << voltage
                          << "V -> " << predicted_pressure << "Pa (training)" << std::endl;
            }
        }
    }

    double simulateHumanInput(double voltage, uint8_t sensor_id) {
        // Simulate human input with realistic pressure values and some noise
        // This would be replaced with actual human input in real implementation

        // Simulate different pressure ranges for different sensor locations
        double base_pressure = 100000.0;  // 100 kPa base pressure

        // Add voltage-dependent component (simulate realistic PT response)
        double voltage_component = voltage * 50000.0;  // 50 kPa per volt

        // Add sensor-specific offset
        double sensor_offset = sensor_id * 10000.0;  // 10 kPa per sensor

        // Add some noise to simulate human measurement uncertainty
        double noise = (rand() % 100 - 50) * 10.0;  // ±500 Pa noise

        return base_pressure + voltage_component + sensor_offset + noise;
    }

    void processingLoop() {
        std::cout << "Paper algorithm processing loop started" << std::endl;

        while (running_) {
            try {
                // Get active sensors
                auto active_sensors = esp32_handler_->getActiveSensors();

                if (!active_sensors.empty()) {
                    // Print algorithm status every 15 seconds
                    static auto last_status_time = std::chrono::steady_clock::now();
                    auto now = std::chrono::steady_clock::now();
                    if (std::chrono::duration_cast<std::chrono::seconds>(now - last_status_time)
                            .count() >= 15) {
                        printAlgorithmStatus();
                        last_status_time = now;
                    }
                }

                // Sleep for 100ms
                std::this_thread::sleep_for(std::chrono::milliseconds(100));

            } catch (const std::exception& e) {
                std::cerr << "Error in paper algorithm processing loop: " << e.what() << std::endl;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            }
        }

        std::cout << "Paper algorithm processing loop stopped" << std::endl;
    }
};

// Global instance for signal handling
std::unique_ptr<PaperAlgorithmPipeline> g_pipeline;

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
    std::cout << "This program implements the exact algorithms from the LaTeX paper:" << std::endl;
    std::cout << "Algorithm 1: Environmental-Robust Bayesian Calibration with Adaptive TLS"
              << std::endl;
    std::cout << "Algorithm 2: Online Environmental-Adaptive EKF with Change Detection"
              << std::endl;
    std::cout << std::endl;
    std::cout << "Workflow:" << std::endl;
    std::cout << "1. Phase 1: Human-in-the-loop training using Algorithm 1" << std::endl;
    std::cout << "2. Phase 2: Autonomous deployment using Algorithm 2" << std::endl;
    std::cout << "3. Real-time change detection and environmental adaptation" << std::endl;
}

int main(int argc, char* argv[]) {
    std::cout << "Paper Algorithm Pipeline for PT Calibration" << std::endl;
    std::cout << "===========================================" << std::endl;
    std::cout << "Implementing Algorithm 1 & 2 from LaTeX paper" << std::endl;
    std::cout << std::endl;

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
        g_pipeline = std::make_unique<PaperAlgorithmPipeline>();

        if (!g_pipeline->start(config_path)) {
            std::cerr << "Failed to start paper algorithm pipeline" << std::endl;
            return 1;
        }

        if (show_status_only) {
            // Show status and exit
            std::this_thread::sleep_for(std::chrono::seconds(2));
            g_pipeline->printAlgorithmStatus();
            return 0;
        }

        std::cout << "\nPaper algorithm pipeline running. Press Ctrl+C to stop." << std::endl;
        std::cout << "Configuration loaded from: "
                  << (config_path.empty() ? "default" : config_path) << std::endl;
        std::cout << std::endl;
        std::cout << "The system implements the paper's methodology:" << std::endl;
        std::cout << "1. Algorithm 1: Environmental-Robust Bayesian Calibration" << std::endl;
        std::cout << "   - Human-in-the-loop training phase" << std::endl;
        std::cout << "   - Progressive confidence building" << std::endl;
        std::cout << "   - Environmental variance modeling" << std::endl;
        std::cout << "2. Algorithm 2: Online Environmental-Adaptive EKF" << std::endl;
        std::cout << "   - Autonomous deployment phase" << std::endl;
        std::cout << "   - Real-time change detection (GLR test)" << std::endl;
        std::cout << "   - Environmental adaptation" << std::endl;
        std::cout << std::endl;
        std::cout << "Make sure your ESP32 is connected and sending data!" << std::endl;

        // Keep running until stopped
        while (g_pipeline->isRunning()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        std::cout << "Paper algorithm pipeline completed." << std::endl;

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
