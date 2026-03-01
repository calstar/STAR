/**
 * @file pt_calibration_example.cpp
 * @brief Comprehensive PT Calibration Example
 *
 * This example demonstrates:
 * 1. Creating calibration procedures
 * 2. Running calibration sessions
 * 3. Validating calibration results
 * 4. Real-time monitoring and adaptation
 * 5. Integration with ESP32 data
 */

#include <chrono>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <random>
#include <thread>
#include <vector>

#include "ESP32SerialHandler.hpp"
#include "PTCalibrationFramework.hpp"
#include "PTCalibrationTool.hpp"
#include "PTMessage.hpp"

class PTCalibrationExample {
private:
    std::shared_ptr<PTCalibrationTool> calibration_tool_;
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::mt19937 rng_;

public:
    PTCalibrationExample() : rng_(std::chrono::steady_clock::now().time_since_epoch().count()) {
        // Initialize calibration tool with environmental-robust calibration map
        calibration_tool_ = std::make_shared<PTCalibrationTool>("environmental_robust");

        // Initialize ESP32 handler (for real-time data)
        ESP32Config esp32_config;
        esp32_config.device_path = "/dev/ttyUSB0";
        esp32_config.baud_rate = 115200;
        esp32_config.timeout_ms = 100;
        esp32_config.max_buffer_size = 1024;
        esp32_config.enable_binary_mode = true;
        esp32_config.max_sensors = 9;

        esp32_handler_ = std::make_shared<ESP32SerialHandler>(esp32_config);
    }

    ~PTCalibrationExample() {
    }

    /**
     * @brief Demonstrate offline calibration with synthetic data
     */
    void demonstrateOfflineCalibration() {
        std::cout << "\n=== Offline Calibration Demonstration ===" << std::endl;

        // Create calibration procedure
        auto procedure =
            calibration_tool_->createCalibrationProcedure("Pressurant Tank Calibration",
                                                          0.0,        // Min pressure (Pa)
                                                          1000000.0,  // Max pressure (Pa) - 1 MPa
                                                          15,         // Number of points
                                                          true  // Include environmental variations
            );

        std::cout << "Created calibration procedure: " << procedure.name << std::endl;
        std::cout << "Pressure range: " << procedure.pressure_points.front() << " - "
                  << procedure.pressure_points.back() << " Pa" << std::endl;

        // Start calibration session for Pressurant Tank PT (sensor 0)
        std::string session_id = calibration_tool_->startCalibrationSession(
            0,  // sensor_id
            static_cast<uint8_t>(PTLocation::PRESSURANT_TANK), procedure);

        std::cout << "Started calibration session: " << session_id << std::endl;

        // Generate synthetic calibration data with realistic characteristics
        generateSyntheticCalibrationData(session_id, procedure);

        // Complete calibration session
        std::cout << "Completing calibration session..." << std::endl;
        auto session = calibration_tool_->completeCalibrationSession(session_id);

        if (session.calibration_successful) {
            std::cout << "✅ Calibration completed successfully!" << std::endl;
            printCalibrationResults(session);

            // Save calibration session
            std::string filename = "calibration_" + session.session_id + ".json";
            if (calibration_tool_->saveCalibrationSession(session, filename)) {
                std::cout << "💾 Calibration saved to: " << filename << std::endl;
            }
        } else {
            std::cout << "❌ Calibration failed: " << session.error_message << std::endl;
        }
    }

    /**
     * @brief Demonstrate real-time calibration monitoring
     */
    void demonstrateRealTimeMonitoring() {
        std::cout << "\n=== Real-Time Calibration Monitoring ===" << std::endl;

        auto& monitor = calibration_tool_->getCalibrationMonitor();

        // Start monitoring multiple sensors
        std::vector<uint8_t> sensors_to_monitor = {0, 1, 2, 3, 4, 5, 6, 7, 8};
        for (uint8_t sensor_id : sensors_to_monitor) {
            monitor.startMonitoring(sensor_id, sensor_id);
            std::cout << "Started monitoring sensor " << static_cast<int>(sensor_id) << std::endl;
        }

        // Simulate real-time data for monitoring
        simulateRealTimeData(monitor, 100);  // 100 data points

        // Check monitoring results
        std::cout << "\n--- Monitoring Results ---" << std::endl;
        for (uint8_t sensor_id : sensors_to_monitor) {
            auto status = monitor.getSensorStatus(sensor_id);
            auto quality = monitor.getSensorQuality(sensor_id);
            bool needs_recal = monitor.needsRecalibration(sensor_id);

            std::cout << "Sensor " << static_cast<int>(sensor_id) << ":" << std::endl;
            std::cout << "  Status: " << status << std::endl;
            std::cout << "  NRMSE: " << std::fixed << std::setprecision(4) << quality.nrmse
                      << std::endl;
            std::cout << "  Coverage: " << std::fixed << std::setprecision(2)
                      << quality.coverage_95 * 100 << "%" << std::endl;
            std::cout << "  Needs Recalibration: " << (needs_recal ? "Yes" : "No") << std::endl;
            std::cout << std::endl;
        }
    }

    /**
     * @brief Demonstrate calibration validation and comparison
     */
    void demonstrateCalibrationValidation() {
        std::cout << "\n=== Calibration Validation Demonstration ===" << std::endl;

        // Create multiple calibration sessions for comparison
        std::vector<std::string> session_ids;
        std::vector<std::string> calibration_types = {"polynomial", "environmental_robust"};

        for (const auto& calib_type : calibration_types) {
            auto tool = std::make_shared<PTCalibrationTool>(calib_type);
            auto procedure = tool->createCalibrationProcedure("Validation_" + calib_type, 0.0,
                                                              1000000.0, 20, true);

            std::string session_id = tool->startCalibrationSession(
                0, static_cast<uint8_t>(PTLocation::PRESSURANT_TANK), procedure);

            generateSyntheticCalibrationData(session_id, procedure, tool);
            auto session = tool->completeCalibrationSession(session_id);

            if (session.calibration_successful) {
                session_ids.push_back(session_id);
                std::cout << "✅ " << calib_type << " calibration completed" << std::endl;
            }
        }

        // Compare calibration results
        std::cout << "\n--- Calibration Comparison ---" << std::endl;
        compareCalibrationResults(session_ids);
    }

private:
    void generateSyntheticCalibrationData(const std::string& session_id,
                                          const CalibrationProcedure& procedure,
                                          std::shared_ptr<PTCalibrationTool> tool = nullptr) {
        if (!tool)
            tool = calibration_tool_;

        std::cout << "Generating synthetic calibration data..." << std::endl;

        // Define realistic calibration characteristics
        double voltage_offset = 0.5;       // 0.5V offset
        double voltage_scale = 0.0008;     // 0.8 mV/Pa scale
        double nonlinearity = 0.0001;      // Small nonlinear term
        double temperature_coeff = 0.001;  // Temperature coefficient
        double noise_std = 0.01;           // 10mV noise

        std::uniform_real_distribution<double> noise_dist(-noise_std, noise_std);
        std::uniform_real_distribution<double> temp_dist(20.0, 30.0);
        std::uniform_real_distribution<double> humidity_dist(40.0, 60.0);

        for (double pressure : procedure.pressure_points) {
            // Generate environmental variations
            EnvironmentalState environment;
            environment.temperature = temp_dist(rng_);
            environment.humidity = humidity_dist(rng_);
            environment.vibration_level = 0.1 * (rng_() % 10) / 10.0;
            environment.aging_factor = 0.0;
            environment.mounting_torque = 1.0;

            // Generate multiple samples per pressure point
            int num_samples = 10 + (rng_() % 10);  // 10-20 samples per point

            for (int i = 0; i < num_samples; ++i) {
                // Compute theoretical voltage with realistic characteristics
                double voltage =
                    voltage_offset + voltage_scale * pressure + nonlinearity * pressure * pressure;

                // Add environmental effects
                voltage += temperature_coeff * (environment.temperature - 25.0);

                // Add noise
                voltage += noise_dist(rng_);

                // Ensure voltage is positive
                voltage = std::max(0.1, voltage);

                // Add to calibration session
                tool->addCalibrationDataPoint(session_id, voltage, pressure, environment);
            }

            std::cout << "  Added " << num_samples << " samples at " << pressure / 1000.0 << " kPa"
                      << std::endl;

            // Small delay to simulate real calibration process
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }

    void printCalibrationResults(const CalibrationSession& session) {
        std::cout << "\n--- Calibration Results ---" << std::endl;
        std::cout << "Session ID: " << session.session_id << std::endl;
        std::cout << "Sensor ID: " << session.sensor_id << std::endl;
        std::cout << "PT Location: " << session.pt_location_name << std::endl;
        std::cout << "Data Points: " << session.data_points.size() << std::endl;

        std::cout << "\nCalibration Parameters:" << std::endl;
        for (int i = 0; i < session.calibration_result.theta.size(); ++i) {
            std::cout << "  " << session.calibration_result.basis_functions[i] << ": " << std::fixed
                      << std::setprecision(6) << session.calibration_result.theta(i) << std::endl;
        }

        std::cout << "\nQuality Metrics:" << std::endl;
        std::cout << "  NRMSE: " << std::fixed << std::setprecision(4)
                  << session.quality_metrics.nrmse << std::endl;
        std::cout << "  95% Coverage: " << std::fixed << std::setprecision(2)
                  << session.quality_metrics.coverage_95 * 100 << "%" << std::endl;
        std::cout << "  Extrapolation Confidence: " << std::fixed << std::setprecision(2)
                  << session.quality_metrics.extrapolation_confidence * 100 << "%" << std::endl;
        std::cout << "  AIC: " << std::fixed << std::setprecision(2) << session.quality_metrics.aic
                  << std::endl;
        std::cout << "  BIC: " << std::fixed << std::setprecision(2) << session.quality_metrics.bic
                  << std::endl;
        std::cout << "  Condition Number: " << std::fixed << std::setprecision(2)
                  << session.quality_metrics.condition_number << std::endl;
    }

    void simulateRealTimeData(PTCalibrationMonitor& monitor, int num_points) {
        std::cout << "Simulating " << num_points << " real-time data points..." << std::endl;

        std::uniform_real_distribution<double> pressure_dist(0.0, 1000000.0);
        std::uniform_real_distribution<double> voltage_dist(0.5, 1.3);
        std::uniform_int_distribution<int> sensor_dist(0, 8);
        std::uniform_real_distribution<double> temp_dist(20.0, 30.0);

        for (int i = 0; i < num_points; ++i) {
            // Generate synthetic PT message
            PTMessage pt_message;
            uint8_t sensor_id = sensor_dist(rng_);
            double voltage = voltage_dist(rng_);
            double pressure = pressure_dist(rng_);
            uint64_t timestamp = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                     std::chrono::system_clock::now().time_since_epoch())
                                     .count();

            set_pt_measurement(pt_message, timestamp, sensor_id, voltage,
                               static_cast<PTLocation>(sensor_id));

            // Generate environmental state
            EnvironmentalState environment;
            environment.temperature = temp_dist(rng_);
            environment.humidity = 50.0;
            environment.vibration_level = 0.1;
            environment.aging_factor = 0.0;
            environment.mounting_torque = 1.0;

            // Add to monitor
            monitor.addPTMeasurement(pt_message, pressure, environment);

            if (i % 20 == 0) {
                std::cout << "  Processed " << i << " data points..." << std::endl;
            }

            // Small delay to simulate real-time data
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    }

    void compareCalibrationResults(const std::vector<std::string>& session_ids) {
        std::cout << "Comparing calibration results..." << std::endl;

        for (const auto& session_id : session_ids) {
            auto session = calibration_tool_->getCalibrationSession(session_id);
            if (session) {
                std::cout << "\nSession: " << session_id << std::endl;
                std::cout << "  NRMSE: " << std::fixed << std::setprecision(4)
                          << session->quality_metrics.nrmse << std::endl;
                std::cout << "  Coverage: " << std::fixed << std::setprecision(2)
                          << session->quality_metrics.coverage_95 * 100 << "%" << std::endl;
                std::cout << "  AIC: " << std::fixed << std::setprecision(2)
                          << session->quality_metrics.aic << std::endl;
                std::cout << "  Condition Number: " << std::fixed << std::setprecision(2)
                          << session->quality_metrics.condition_number << std::endl;
            }
        }
    }
};

void printUsage(const char* program_name) {
    std::cout << "Usage: " << program_name << " [options]" << std::endl;
    std::cout << "Options:" << std::endl;
    std::cout << "  --offline           Run offline calibration demonstration" << std::endl;
    std::cout << "  --monitoring        Run real-time monitoring demonstration" << std::endl;
    std::cout << "  --validation        Run calibration validation demonstration" << std::endl;
    std::cout << "  --all               Run all demonstrations" << std::endl;
    std::cout << "  -h, --help          Show this help message" << std::endl;
    std::cout << std::endl;
    std::cout << "Examples:" << std::endl;
    std::cout << "  " << program_name << " --offline" << std::endl;
    std::cout << "  " << program_name << " --all" << std::endl;
}

int main(int argc, char* argv[]) {
    std::cout << "PT Calibration Framework Demonstration" << std::endl;
    std::cout << "=====================================" << std::endl;

    // Parse command line arguments
    bool run_offline = false;
    bool run_monitoring = false;
    bool run_validation = false;
    bool run_all = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == "--offline") {
            run_offline = true;
        } else if (arg == "--monitoring") {
            run_monitoring = true;
        } else if (arg == "--validation") {
            run_validation = true;
        } else if (arg == "--all") {
            run_all = true;
        } else if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        } else {
            std::cerr << "Error: Unknown argument " << arg << std::endl;
            printUsage(argv[0]);
            return 1;
        }
    }

    // Default to running all demonstrations if no specific option given
    if (!run_offline && !run_monitoring && !run_validation) {
        run_all = true;
    }

    try {
        PTCalibrationExample example;

        if (run_all || run_offline) {
            example.demonstrateOfflineCalibration();
        }

        if (run_all || run_monitoring) {
            example.demonstrateRealTimeMonitoring();
        }

        if (run_all || run_validation) {
            example.demonstrateCalibrationValidation();
        }

        std::cout << "\n🎉 All demonstrations completed successfully!" << std::endl;

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
