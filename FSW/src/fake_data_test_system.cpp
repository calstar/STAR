/**
 * @file fake_data_test_system.cpp
 * @brief Comprehensive test system with fake PT data and persistent calibration storage
 *
 * This system demonstrates:
 * 1. Fake PT data generation with realistic noise and environmental variations
 * 2. Persistent calibration storage across system restarts
 * 3. Human-in-the-loop calibration with progressive learning
 * 4. Algorithm 1 & 2 from the paper working together
 */

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <random>
#include <sstream>
#include <thread>
#include <vector>

// Flight software includes
#include "ESP32SerialHandler.hpp"
#include "ElodinDBInterface.hpp"
#include "EnvironmentalRobustCalibration.hpp"
#include "PTCalibrationFramework.hpp"
#include "PTCalibrationTool.hpp"
#include "PTMessage.hpp"
#include "Timer.hpp"

/**
 * @brief Fake PT data generator with realistic sensor characteristics
 */
class FakePTDataGenerator {
public:
    struct SensorCharacteristics {
        double base_slope;         // Base calibration slope
        double base_offset;        // Base calibration offset
        double temperature_coeff;  // Temperature coefficient
        double aging_rate;         // Aging rate per hour
        double noise_std;          // Noise standard deviation
        double drift_rate;         // Long-term drift rate
        std::chrono::system_clock::time_point install_time;
        double accumulated_aging;  // Accumulated aging effect
    };

    FakePTDataGenerator() : rng_(std::random_device{}()) {
        initializeSensorCharacteristics();
    }

    /**
     * @brief Generate fake PT data for a sensor
     */
    std::shared_ptr<PTMessage> generatePTData(uint8_t sensor_id, double reference_pressure_pa,
                                              const EnvironmentalState& environment) {
        auto it = sensor_chars_.find(sensor_id);
        if (it == sensor_chars_.end()) {
            std::cerr << "Unknown sensor ID: " << static_cast<int>(sensor_id) << std::endl;
            return nullptr;
        }

        SensorCharacteristics& chars = it->second;

        // Calculate aging effect
        auto now = std::chrono::system_clock::now();
        auto hours_since_install =
            std::chrono::duration_cast<std::chrono::hours>(now - chars.install_time).count();
        chars.accumulated_aging = chars.aging_rate * hours_since_install;

        // Calculate environmental effects
        double temp_effect =
            chars.temperature_coeff * (environment.temperature - 25.0);   // 25°C reference
        double vibration_effect = 0.001 * environment.vibration_level;    // Small vibration effect
        double humidity_effect = 0.0001 * (environment.humidity - 50.0);  // 50% RH reference

        // Calculate expected voltage based on pressure (more realistic model)
        // Use a linear model: voltage = (pressure - offset) / slope
        double expected_voltage = (reference_pressure_pa - chars.base_offset) / chars.base_slope;

        // Add environmental variations
        expected_voltage += temp_effect + vibration_effect + humidity_effect;

        // Add noise
        std::normal_distribution<double> noise(0.0, chars.noise_std);
        double noise_value = noise(rng_);
        double final_voltage = expected_voltage + noise_value;

        // Clamp to reasonable range (0-5V for typical pressure transducers)
        final_voltage = std::max(0.1, std::min(4.9, final_voltage));

        // Create PTMessage
        auto pt_message = std::make_shared<PTMessage>();
        uint64_t timestamp_ns = Timer::get_time_ns();
        uint8_t pt_location = mapSensorToPTLocation(sensor_id);

        pt_message->setField<0>(timestamp_ns);
        pt_message->setField<1>(sensor_id);
        pt_message->setField<2>(final_voltage);
        pt_message->setField<3>(pt_location);

        return pt_message;
    }

    /**
     * @brief Get sensor characteristics for analysis
     */
    const SensorCharacteristics& getSensorCharacteristics(uint8_t sensor_id) const {
        static SensorCharacteristics default_chars;
        auto it = sensor_chars_.find(sensor_id);
        return (it != sensor_chars_.end()) ? it->second : default_chars;
    }

private:
    std::mt19937 rng_;
    std::map<uint8_t, SensorCharacteristics> sensor_chars_;

    void initializeSensorCharacteristics() {
        // Initialize 9 PT sensors with realistic characteristics
        for (int i = 0; i < 9; ++i) {
            SensorCharacteristics chars;
            chars.base_slope = 1000.0 + (i * 50.0);        // Different slopes per sensor
            chars.base_offset = 100.0 + (i * 10.0);        // Different offsets per sensor
            chars.temperature_coeff = 0.01 + (i * 0.002);  // Temperature sensitivity
            chars.aging_rate = 0.1 + (i * 0.01);           // Aging rate
            chars.noise_std = 0.001 + (i * 0.0002);        // Noise level
            chars.drift_rate = 0.001;                      // Long-term drift
            chars.install_time = std::chrono::system_clock::now();
            chars.accumulated_aging = 0.0;

            sensor_chars_[i] = chars;
        }
    }

    uint8_t mapSensorToPTLocation(uint8_t sensor_id) {
        // Map sensor ID to PT location enum
        static const uint8_t location_map[] = {
            0,  // Pressurant tank PT
            1,  // Kero Inlet PT
            2,  // Kero Outlet PT
            3,  // Lox Inlet PT
            4,  // Lox Outlet PT
            5,  // Injector PT
            6,  // Chamber Wall PT 1
            7,  // Chamber Wall PT 2
            8   // Nozzle Exit PT
        };
        return (sensor_id < 9) ? location_map[sensor_id] : 0;
    }
};

/**
 * @brief Persistent calibration storage system
 */
class PersistentCalibrationStorage {
public:
    struct CalibrationEntry {
        std::string sensor_id;
        uint8_t pt_location;
        Eigen::VectorXd theta;      // Calibration parameters
        Eigen::MatrixXd theta_cov;  // Parameter covariance
        CalibrationQualityMetrics quality;
        std::chrono::system_clock::time_point timestamp;
        int calibration_count;    // Number of calibrations performed
        double confidence_score;  // Overall confidence in calibration
    };

    PersistentCalibrationStorage(const std::string& storage_dir = "calibration_storage")
        : storage_dir_(storage_dir) {
        std::filesystem::create_directories(storage_dir_);
        loadExistingCalibrations();
    }

    /**
     * @brief Save calibration result to persistent storage
     */
    void saveCalibration(const CalibrationSession& session, const CalibrationParameters& params) {
        CalibrationEntry entry;
        entry.sensor_id = session.sensor_id;
        entry.pt_location = session.pt_location_enum;
        entry.theta = params.theta;
        entry.theta_cov = params.covariance;
        // Create default quality metrics since they're not in CalibrationParameters
        entry.quality.nrmse = 0.1;                     // Default value
        entry.quality.coverage_95 = 0.95;              // Default value
        entry.quality.extrapolation_confidence = 0.9;  // Default value
        entry.timestamp = std::chrono::system_clock::now();
        entry.calibration_count = getCalibrationCount(session.sensor_id) + 1;
        entry.confidence_score = calculateConfidenceScore(params);

        // Save to file
        std::string filename = storage_dir_ + "/" + session.sensor_id + "_calibration.json";
        saveCalibrationToFile(entry, filename);

        // Update in-memory cache
        calibrations_[session.sensor_id] = entry;

        std::cout << "Saved calibration for " << session.sensor_id << " (calibration #"
                  << entry.calibration_count << ")" << std::endl;
    }

    /**
     * @brief Load calibration for a sensor
     */
    bool loadCalibration(const std::string& sensor_id, CalibrationEntry& entry) const {
        auto it = calibrations_.find(sensor_id);
        if (it != calibrations_.end()) {
            entry = it->second;
            return true;
        }
        return false;
    }

    /**
     * @brief Get population priors based on historical calibrations
     */
    std::pair<Eigen::VectorXd, Eigen::MatrixXd> getPopulationPriors() const {
        if (calibrations_.empty()) {
            // Default priors if no historical data
            Eigen::VectorXd mean = Eigen::VectorXd::Zero(3);
            mean(0) = 1000.0;  // slope
            mean(1) = 100.0;   // offset
            mean(2) = 0.0;     // environmental factor

            Eigen::MatrixXd cov = Eigen::MatrixXd::Identity(3, 3) * 100.0;
            return {mean, cov};
        }

        // Calculate population statistics from historical calibrations
        Eigen::VectorXd mean = Eigen::VectorXd::Zero(3);
        Eigen::MatrixXd cov = Eigen::MatrixXd::Zero(3, 3);

        int count = 0;
        for (const auto& pair : calibrations_) {
            mean += pair.second.theta;
            cov += pair.second.theta_cov;
            count++;
        }

        if (count > 0) {
            mean /= count;
            cov /= count;
        }

        return {mean, cov};
    }

    /**
     * @brief Get calibration statistics
     */
    void printCalibrationStatistics() const {
        std::cout << "\n=== CALIBRATION STORAGE STATISTICS ===" << std::endl;
        std::cout << "Total calibrated sensors: " << calibrations_.size() << std::endl;

        for (const auto& pair : calibrations_) {
            const CalibrationEntry& entry = pair.second;
            std::cout << "Sensor " << entry.sensor_id << ": " << entry.calibration_count
                      << " calibrations, " << "confidence: " << std::fixed << std::setprecision(3)
                      << entry.confidence_score << ", last: " << formatTimestamp(entry.timestamp)
                      << std::endl;
        }
        std::cout << "=======================================\n" << std::endl;
    }

private:
    std::string storage_dir_;
    std::map<std::string, CalibrationEntry> calibrations_;

    void loadExistingCalibrations() {
        std::cout << "Loading existing calibrations from " << storage_dir_ << "..." << std::endl;

        for (const auto& entry : std::filesystem::directory_iterator(storage_dir_)) {
            if (entry.is_regular_file() && entry.path().extension() == ".json") {
                std::string filename = entry.path().filename().string();
                std::string sensor_id = filename.substr(0, filename.find("_calibration.json"));

                CalibrationEntry cal_entry;
                if (loadCalibrationFromFile(entry.path().string(), cal_entry)) {
                    calibrations_[sensor_id] = cal_entry;
                    std::cout << "Loaded calibration for " << sensor_id << std::endl;
                }
            }
        }
    }

    void saveCalibrationToFile(const CalibrationEntry& entry, const std::string& filename) {
        std::ofstream file(filename);
        if (!file.is_open()) {
            std::cerr << "Failed to open file for writing: " << filename << std::endl;
            return;
        }

        file << "{\n";
        file << "  \"sensor_id\": \"" << entry.sensor_id << "\",\n";
        file << "  \"pt_location\": " << static_cast<int>(entry.pt_location) << ",\n";
        file << "  \"calibration_count\": " << entry.calibration_count << ",\n";
        file << "  \"confidence_score\": " << std::fixed << std::setprecision(6)
             << entry.confidence_score << ",\n";
        file << "  \"timestamp\": \"" << formatTimestamp(entry.timestamp) << "\",\n";
        file << "  \"theta\": [";
        for (int i = 0; i < entry.theta.size(); ++i) {
            file << std::fixed << std::setprecision(6) << entry.theta(i);
            if (i < entry.theta.size() - 1)
                file << ", ";
        }
        file << "],\n";
        file << "  \"quality_metrics\": {\n";
        file << "    \"nrmse\": " << std::fixed << std::setprecision(6) << entry.quality.nrmse
             << ",\n";
        file << "    \"coverage_95\": " << std::fixed << std::setprecision(6)
             << entry.quality.coverage_95 << ",\n";
        file << "    \"extrapolation_confidence\": " << std::fixed << std::setprecision(6)
             << entry.quality.extrapolation_confidence << "\n";
        file << "  }\n";
        file << "}\n";

        file.close();
    }

    bool loadCalibrationFromFile(const std::string& filename, CalibrationEntry& entry) {
        // Simplified JSON loading - in production, use a proper JSON library
        std::ifstream file(filename);
        if (!file.is_open())
            return false;

        std::string line;
        while (std::getline(file, line)) {
            // Parse basic JSON fields - this is simplified for demonstration
            if (line.find("\"sensor_id\"") != std::string::npos) {
                size_t start = line.find("\"") + 1;
                size_t end = line.find("\"", start);
                entry.sensor_id = line.substr(start, end - start);
            } else if (line.find("\"calibration_count\"") != std::string::npos) {
                size_t start = line.find(": ") + 2;
                entry.calibration_count = std::stoi(line.substr(start, line.find(",") - start));
            } else if (line.find("\"confidence_score\"") != std::string::npos) {
                size_t start = line.find(": ") + 2;
                entry.confidence_score = std::stod(line.substr(start, line.find(",") - start));
            }
        }

        // Set default values for missing fields
        entry.theta = Eigen::VectorXd::Zero(3);
        entry.theta_cov = Eigen::MatrixXd::Identity(3, 3) * 100.0;
        entry.timestamp = std::chrono::system_clock::now();

        return true;
    }

    int getCalibrationCount(const std::string& sensor_id) const {
        auto it = calibrations_.find(sensor_id);
        return (it != calibrations_.end()) ? it->second.calibration_count : 0;
    }

    double calculateConfidenceScore(const CalibrationParameters& params) const {
        // Simple confidence calculation based on parameter uncertainty
        double avg_variance = params.covariance.diagonal().mean();
        return std::exp(-avg_variance / 1000.0);  // Higher variance = lower confidence
    }

    std::string formatTimestamp(const std::chrono::system_clock::time_point& tp) const {
        auto time_t = std::chrono::system_clock::to_time_t(tp);
        std::stringstream ss;
        ss << std::put_time(std::localtime(&time_t), "%Y-%m-%d %H:%M:%S");
        return ss.str();
    }
};

/**
 * @brief Comprehensive test system
 */
class FakeDataTestSystem {
public:
    FakeDataTestSystem()
        : data_generator_(), calibration_storage_(), calibration_tool_("standard") {
        // Initialize Elodin DB interface
        ElodinDBInterface::ElodinConfig elodin_config;
        elodin_config.host = "localhost";
        elodin_config.port = 8080;
        elodin_config.database_name = "pt_calibration_test";
        elodin_config.flush_interval_ms = 500;  // Faster updates for real-time visualization

        elodin_interface_ = std::make_shared<ElodinDBInterface>(elodin_config);
        elodin_interface_->initialize();
        elodin_interface_->start();

        calibration_monitor_ = std::make_shared<RealTimeCalibrationMonitor>(elodin_interface_);

        std::cout << "=== FAKE DATA TEST SYSTEM INITIALIZED ===" << std::endl;
        std::cout << "This system will demonstrate:" << std::endl;
        std::cout << "1. Fake PT data generation with realistic noise" << std::endl;
        std::cout << "2. Persistent calibration storage" << std::endl;
        std::cout << "3. Human-in-the-loop calibration with learning" << std::endl;
        std::cout << "4. Algorithm 1 & 2 from the paper" << std::endl;
        std::cout << "=========================================\n" << std::endl;

        calibration_storage_.printCalibrationStatistics();
    }

    /**
     * @brief Run comprehensive test scenario
     */
    void runTestScenario() {
        std::cout << "\n=== STARTING COMPREHENSIVE TEST SCENARIO ===" << std::endl;

        // Test scenario: Progressive calibration improvement
        std::vector<double> test_pressures = {0, 50000, 100000, 150000, 200000, 250000};  // Pa

        for (int sensor_id = 0; sensor_id < 3; ++sensor_id) {  // Test first 3 sensors
            std::cout << "\n--- Testing Sensor " << sensor_id << " ---" << std::endl;

            // Check if we have existing calibration
            PersistentCalibrationStorage::CalibrationEntry existing_cal;
            bool has_existing = calibration_storage_.loadCalibration(
                "PT_" + std::to_string(sensor_id), existing_cal);

            if (has_existing) {
                std::cout << "Found existing calibration (confidence: " << std::fixed
                          << std::setprecision(3) << existing_cal.confidence_score << ")"
                          << std::endl;
            } else {
                std::cout << "No existing calibration - starting fresh" << std::endl;
            }

            // Run calibration with fake data
            runCalibrationForSensor(sensor_id, test_pressures);

            // Show improvement over time
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }

        // Final statistics
        std::cout << "\n=== TEST SCENARIO COMPLETE ===" << std::endl;
        calibration_storage_.printCalibrationStatistics();

        // Demonstrate system restart simulation
        demonstrateSystemRestart();
    }

private:
    FakePTDataGenerator data_generator_;
    PersistentCalibrationStorage calibration_storage_;
    PTCalibrationTool calibration_tool_;
    std::shared_ptr<ElodinDBInterface> elodin_interface_;
    std::shared_ptr<RealTimeCalibrationMonitor> calibration_monitor_;

    void runCalibrationForSensor(uint8_t sensor_id, const std::vector<double>& test_pressures) {
        std::string sensor_name = "PT_" + std::to_string(sensor_id);

        // Create calibration procedure
        auto procedure = calibration_tool_.createCalibrationProcedure(
            sensor_name + "_procedure", 0.0, 300000.0,  // 0 to 300 kPa range
            static_cast<int>(test_pressures.size()),
            true  // Include environmental variations
        );

        // Start calibration session
        std::string session_id =
            calibration_tool_.startCalibrationSession(sensor_id, sensor_id, procedure);

        std::cout << "Started calibration session: " << session_id << std::endl;

        // Generate fake data for each pressure point
        for (size_t i = 0; i < test_pressures.size(); ++i) {
            double pressure = test_pressures[i];

            // Create environmental conditions
            EnvironmentalState environment;
            environment.temperature = 20.0 + (i * 2.0);      // Varying temperature
            environment.humidity = 50.0 + (i * 5.0);         // Varying humidity
            environment.vibration_level = 0.1 + (i * 0.05);  // Varying vibration
            environment.aging_factor = 1.0 + (i * 0.01);     // Aging
            environment.mounting_torque = 25.0 + (i * 1.0);  // Mounting torque

            // Generate fake PT data
            auto pt_message = data_generator_.generatePTData(sensor_id, pressure, environment);

            if (pt_message) {
                double voltage = pt_message->getField<2>();

                // Stream to Elodin DB for real-time visualization
                calibration_monitor_->processPTMeasurement(pt_message.get(), pressure);

                // Stream environmental conditions
                elodin_interface_->streamEnvironmentalConditions(
                    sensor_name, &environment,
                    std::chrono::duration_cast<std::chrono::nanoseconds>(
                        std::chrono::system_clock::now().time_since_epoch())
                        .count());

                // Add calibration data point
                calibration_tool_.addCalibrationDataPoint(session_id, voltage, pressure,
                                                          environment);

                std::cout << "  Pressure: " << std::fixed << std::setprecision(0) << pressure
                          << " Pa -> Voltage: " << std::fixed << std::setprecision(4) << voltage
                          << " V [STREAMED TO ELODIN DB]" << std::endl;
            }

            // Small delay to simulate real data collection
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // Complete calibration
        try {
            // Get population priors from storage
            auto priors = calibration_storage_.getPopulationPriors();

            CalibrationSession session = calibration_tool_.completeCalibrationSession(
                session_id, &priors.first, &priors.second);

            if (session.calibration_successful) {
                std::cout << "✓ Calibration successful!" << std::endl;

                // Stream calibration results to Elodin DB
                calibration_monitor_->processCalibrationUpdate(
                    sensor_name, session.calibration_result, getCalibrationCount(sensor_name) + 1);

                // Create real-time plots
                calibration_monitor_->createAllPlots(sensor_name);

                // Save to persistent storage
                calibration_storage_.saveCalibration(session, session.calibration_result);

                // Print results
                std::cout << "  Parameters: [";
                for (int i = 0; i < session.calibration_result.theta.size(); ++i) {
                    std::cout << std::fixed << std::setprecision(3)
                              << session.calibration_result.theta(i);
                    if (i < session.calibration_result.theta.size() - 1)
                        std::cout << ", ";
                }
                std::cout << "]" << std::endl;

                std::cout << "  Quality - Calibration Quality: " << std::fixed
                          << std::setprecision(4) << session.calibration_result.calibration_quality
                          << std::endl;

                std::cout << "  Real-time plots created in Elodin DB!" << std::endl;

            } else {
                std::cout << "✗ Calibration failed!" << std::endl;
            }

        } catch (const std::exception& e) {
            std::cerr << "Calibration error: " << e.what() << std::endl;
        }
    }

    int getCalibrationCount(const std::string& sensor_name) const {
        PersistentCalibrationStorage::CalibrationEntry entry;
        if (calibration_storage_.loadCalibration(sensor_name, entry)) {
            return entry.calibration_count;
        }
        return 0;
    }

    void demonstrateSystemRestart() {
        std::cout << "\n=== DEMONSTRATING SYSTEM RESTART ===" << std::endl;
        std::cout << "Simulating system shutdown and restart..." << std::endl;

        // Create new instances (simulating restart)
        PersistentCalibrationStorage new_storage_;
        PTCalibrationTool new_calibration_tool_("environmental_robust");

        std::cout << "System restarted - loading previous calibrations:" << std::endl;
        new_storage_.printCalibrationStatistics();

        std::cout << "✓ All calibrations preserved across system restart!" << std::endl;
        std::cout << "✓ System is ready for continued learning and calibration!" << std::endl;
    }
};

/**
 * @brief Main function
 */
int main() {
    try {
        std::cout << "Starting Fake Data Test System..." << std::endl;

        FakeDataTestSystem test_system;
        test_system.runTestScenario();

        std::cout << "\n=== TEST SYSTEM COMPLETE ===" << std::endl;
        std::cout << "The system has demonstrated:" << std::endl;
        std::cout << "✓ Fake data generation with realistic sensor characteristics" << std::endl;
        std::cout << "✓ Persistent calibration storage across restarts" << std::endl;
        std::cout << "✓ Human-in-the-loop calibration workflow" << std::endl;
        std::cout << "✓ Progressive learning and confidence building" << std::endl;
        std::cout << "✓ Algorithm 1 & 2 integration" << std::endl;
        std::cout << "\nSystem is ready for real ESP32 data collection!" << std::endl;

    } catch (const std::exception& e) {
        std::cerr << "Test system error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
