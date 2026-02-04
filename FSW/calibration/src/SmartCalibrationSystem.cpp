#include "SmartCalibrationSystem.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>

SmartCalibrationSystem::SmartCalibrationSystem(
    std::shared_ptr<CalibrationMapFunction> calibration_map)
    : calibration_map_(calibration_map),
      low_confidence_threshold_(0.05),
      medium_confidence_threshold_(0.02),
      high_confidence_threshold_(0.01),
      request_id_counter_(0) {
    if (!calibration_map_) {
        throw std::invalid_argument("Calibration map function cannot be null");
    }
}

SmartCalibrationSystem::~SmartCalibrationSystem() {
}

std::pair<double, bool> SmartCalibrationSystem::processMeasurement(
    uint8_t sensor_id, double voltage, uint64_t timestamp, const EnvironmentalState& environment) {
    // Initialize sensor state if needed
    if (sensor_states_.find(sensor_id) == sensor_states_.end()) {
        initializeSensorState(sensor_id);
    }

    SensorState& state = sensor_states_[sensor_id];

    // Update last measurement time
    state.last_measurement = std::chrono::system_clock::now();
    state.last_voltage = voltage;

    // Check if we have calibration data
    if (state.calibration_data.empty()) {
        // No calibration data - request human input
        HumanInputRequest request = createHumanInputRequest(sensor_id, voltage, 0.0, 1.0);
        request.reason = "No calibration data available";
        pending_requests_.push(request);

        if (human_input_callback_) {
            human_input_callback_(request);
        }

        return std::make_pair(0.0, true);
    }

    // Get prediction from calibration framework
    auto [predicted_pressure, uncertainty] =
        state.calibration_framework->predictPressure(voltage, environment);
    state.last_predicted_pressure = predicted_pressure;

    // Store recent prediction for learning
    state.recent_predictions.push_back(std::make_pair(voltage, predicted_pressure));
    if (state.recent_predictions.size() > 100) {
        state.recent_predictions.pop_front();
    }

    // Determine if human input is needed
    bool needs_human_input =
        shouldRequestHumanInput(sensor_id, voltage, predicted_pressure, uncertainty);

    if (needs_human_input) {
        HumanInputRequest request =
            createHumanInputRequest(sensor_id, voltage, predicted_pressure, uncertainty);
        pending_requests_.push(request);

        if (human_input_callback_) {
            human_input_callback_(request);
        }
    }

    return std::make_pair(predicted_pressure, needs_human_input);
}

void SmartCalibrationSystem::provideHumanInput(uint8_t sensor_id, double voltage,
                                               double reference_pressure, uint64_t timestamp,
                                               const EnvironmentalState& environment) {
    if (sensor_states_.find(sensor_id) == sensor_states_.end()) {
        initializeSensorState(sensor_id);
    }

    SensorState& state = sensor_states_[sensor_id];

    // Create calibration data point
    CalibrationDataPoint data_point;
    data_point.voltage = voltage;
    data_point.reference_pressure = reference_pressure;
    data_point.reference_pressure_uncertainty = 50.0;  // 50 Pa uncertainty for human input
    data_point.environment = environment;
    data_point.timestamp_ns = timestamp;
    data_point.sensor_id = sensor_id;
    data_point.pt_location = static_cast<uint8_t>(sensor_id);

    // Add to calibration data
    state.calibration_data.push_back(data_point);

    // Update calibration framework
    state.calibration_framework->addCalibrationData(data_point);

    // Perform calibration update
    if (state.calibration_data.size() >= 3) {
        // Use Bayesian calibration with population priors
        Eigen::VectorXd prior_mean = Eigen::VectorXd::Zero(calibration_map_->getNumParameters());
        if (calibration_map_->getNumParameters() >= 2) {
            prior_mean(0) = 1000.0;  // offset
            prior_mean(1) = 1000.0;  // linear coefficient
        }

        Eigen::MatrixXd prior_cov =
            1000.0 * Eigen::MatrixXd::Identity(calibration_map_->getNumParameters(),
                                               calibration_map_->getNumParameters());

        auto calibration_result =
            state.calibration_framework->performBayesianCalibration(prior_mean, prior_cov, 1.0);
    }

    // Update learning state
    state.learning_state.human_input_count++;
    state.learning_state.last_human_input = std::chrono::system_clock::now();

    // Update learning state and confidence level
    updateLearningState(sensor_id);

    // Remove any pending requests for this sensor
    std::queue<HumanInputRequest> new_requests;
    while (!pending_requests_.empty()) {
        HumanInputRequest request = pending_requests_.front();
        pending_requests_.pop();

        if (request.sensor_id != sensor_id) {
            new_requests.push(request);
        }
    }
    pending_requests_ = new_requests;
}

void SmartCalibrationSystem::validatePrediction(uint8_t sensor_id, double predicted_pressure,
                                                double actual_pressure, uint64_t timestamp) {
    if (sensor_states_.find(sensor_id) == sensor_states_.end()) {
        return;
    }

    SensorState& state = sensor_states_[sensor_id];

    // Calculate prediction error
    double error = std::abs(predicted_pressure - actual_pressure);
    double relative_error = error / std::max(actual_pressure, 1.0);

    // Store validation error
    state.validation_errors.push_back(std::make_pair(predicted_pressure, actual_pressure));
    if (state.validation_errors.size() > 50) {
        state.validation_errors.pop_front();
    }

    // Update success/failure counts
    if (relative_error < 0.05) {  // 5% error threshold
        state.learning_state.autonomous_success_count++;
    } else {
        state.learning_state.autonomous_failure_count++;
    }

    // Update learning state
    updateLearningState(sensor_id);
}

CalibrationConfidence SmartCalibrationSystem::getCalibrationConfidence(uint8_t sensor_id) const {
    auto it = sensor_states_.find(sensor_id);
    if (it == sensor_states_.end()) {
        return CalibrationConfidence::LOW;
    }

    return it->second.learning_state.confidence_level;
}

CalibrationLearningState SmartCalibrationSystem::getLearningState(uint8_t sensor_id) const {
    auto it = sensor_states_.find(sensor_id);
    if (it == sensor_states_.end()) {
        return CalibrationLearningState();
    }

    return it->second.learning_state;
}

bool SmartCalibrationSystem::needsHumanInput(uint8_t sensor_id) const {
    auto it = sensor_states_.find(sensor_id);
    if (it == sensor_states_.end()) {
        return true;
    }

    const auto& learning_state = it->second.learning_state;

    // Check confidence level
    if (learning_state.confidence_level == CalibrationConfidence::LOW) {
        return true;
    }

    // Check if we haven't had human input recently and confidence is medium
    if (learning_state.confidence_level == CalibrationConfidence::MEDIUM) {
        auto time_since_input = std::chrono::system_clock::now() - learning_state.last_human_input;
        if (std::chrono::duration_cast<std::chrono::minutes>(time_since_input).count() > 30) {
            return true;
        }
    }

    return false;
}

std::vector<HumanInputRequest> SmartCalibrationSystem::getPendingRequests() const {
    std::vector<HumanInputRequest> requests;
    std::queue<HumanInputRequest> temp_queue = pending_requests_;

    while (!temp_queue.empty()) {
        requests.push_back(temp_queue.front());
        temp_queue.pop();
    }

    return requests;
}

double SmartCalibrationSystem::getReliabilityScore(uint8_t sensor_id) const {
    auto it = sensor_states_.find(sensor_id);
    if (it == sensor_states_.end()) {
        return 0.0;
    }

    return it->second.learning_state.reliability_score;
}

void SmartCalibrationSystem::forceRecalibration(uint8_t sensor_id) {
    if (sensor_states_.find(sensor_id) != sensor_states_.end()) {
        SensorState& state = sensor_states_[sensor_id];

        // Reset learning state
        state.learning_state = CalibrationLearningState();

        // Clear calibration data
        state.calibration_data.clear();
        state.calibration_framework->clearCalibrationData();

        // Clear recent predictions and validation errors
        state.recent_predictions.clear();
        state.validation_errors.clear();

        std::cout << "Forced recalibration for sensor " << static_cast<int>(sensor_id) << std::endl;
    }
}

void SmartCalibrationSystem::setConfidenceThresholds(double low_threshold, double medium_threshold,
                                                     double high_threshold) {
    low_confidence_threshold_ = low_threshold;
    medium_confidence_threshold_ = medium_threshold;
    high_confidence_threshold_ = high_threshold;
}

std::map<uint8_t, std::map<std::string, double>> SmartCalibrationSystem::getCalibrationStatistics()
    const {
    std::map<uint8_t, std::map<std::string, double>> statistics;

    for (const auto& pair : sensor_states_) {
        uint8_t sensor_id = pair.first;
        const SensorState& state = pair.second;
        const CalibrationLearningState& learning = state.learning_state;

        std::map<std::string, double> sensor_stats;
        sensor_stats["human_input_count"] = learning.human_input_count;
        sensor_stats["autonomous_success_count"] = learning.autonomous_success_count;
        sensor_stats["autonomous_failure_count"] = learning.autonomous_failure_count;
        sensor_stats["reliability_score"] = learning.reliability_score;
        sensor_stats["calibration_data_points"] = state.calibration_data.size();
        sensor_stats["confidence_level"] = static_cast<double>(learning.confidence_level);

        // Calculate success rate
        int total_autonomous =
            learning.autonomous_success_count + learning.autonomous_failure_count;
        sensor_stats["autonomous_success_rate"] =
            total_autonomous > 0
                ? static_cast<double>(learning.autonomous_success_count) / total_autonomous
                : 0.0;

        statistics[sensor_id] = sensor_stats;
    }

    return statistics;
}

bool SmartCalibrationSystem::saveLearningState(const std::string& filename) const {
    try {
        std::ofstream file(filename);
        if (!file.is_open()) {
            return false;
        }

        // Save sensor states
        file << "sensor_states:" << std::endl;
        for (const auto& pair : sensor_states_) {
            uint8_t sensor_id = pair.first;
            const SensorState& state = pair.second;
            const CalibrationLearningState& learning = state.learning_state;

            file << "  sensor_" << static_cast<int>(sensor_id) << ":" << std::endl;
            file << "    confidence_level: " << static_cast<int>(learning.confidence_level)
                 << std::endl;
            file << "    human_input_count: " << learning.human_input_count << std::endl;
            file << "    autonomous_success_count: " << learning.autonomous_success_count
                 << std::endl;
            file << "    autonomous_failure_count: " << learning.autonomous_failure_count
                 << std::endl;
            file << "    reliability_score: " << learning.reliability_score << std::endl;
            file << "    calibration_data_points: " << state.calibration_data.size() << std::endl;
        }

        file.close();
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Error saving learning state: " << e.what() << std::endl;
        return false;
    }
}

bool SmartCalibrationSystem::loadLearningState(const std::string& filename) {
    try {
        std::ifstream file(filename);
        if (!file.is_open()) {
            return false;
        }

        std::string line;
        while (std::getline(file, line)) {
            // Simple YAML-like parsing
            if (line.find("sensor_") != std::string::npos) {
                // Parse sensor data
                // Implementation would parse the saved state
            }
        }

        file.close();
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Error loading learning state: " << e.what() << std::endl;
        return false;
    }
}

void SmartCalibrationSystem::registerHumanInputCallback(
    std::function<void(const HumanInputRequest&)> callback) {
    human_input_callback_ = callback;
}

void SmartCalibrationSystem::registerConfidenceChangeCallback(
    std::function<void(uint8_t, CalibrationConfidence)> callback) {
    confidence_change_callback_ = callback;
}

// Private methods

void SmartCalibrationSystem::initializeSensorState(uint8_t sensor_id) {
    SensorState state;

    // Create calibration framework
    state.calibration_framework = std::make_shared<PTCalibrationFramework>(calibration_map_);

    // Initialize learning state
    state.learning_state = CalibrationLearningState();

    sensor_states_[sensor_id] = state;
}

void SmartCalibrationSystem::updateLearningState(uint8_t sensor_id) {
    SensorState& state = sensor_states_[sensor_id];
    CalibrationLearningState& learning = state.learning_state;

    // Compute reliability score
    learning.reliability_score = computeReliabilityScore(sensor_id);

    // Determine new confidence level
    CalibrationConfidence old_confidence = learning.confidence_level;
    CalibrationConfidence new_confidence = CalibrationConfidence::LOW;

    if (learning.human_input_count >= 20 && learning.reliability_score > 0.9) {
        new_confidence = CalibrationConfidence::MAXIMUM;
    } else if (learning.human_input_count >= 10 && learning.reliability_score > 0.8) {
        new_confidence = CalibrationConfidence::HIGH;
    } else if (learning.human_input_count >= 5 && learning.reliability_score > 0.7) {
        new_confidence = CalibrationConfidence::MEDIUM;
    }

    // Update confidence level if changed
    if (new_confidence != old_confidence) {
        learning.confidence_level = new_confidence;

        if (confidence_change_callback_) {
            confidence_change_callback_(sensor_id, new_confidence);
        }
    }

    // Update adaptive learning rate
    learning.learning_rate = getAdaptiveLearningRate(sensor_id);
}

bool SmartCalibrationSystem::shouldRequestHumanInput(uint8_t sensor_id, double voltage,
                                                     double predicted_pressure,
                                                     double uncertainty) {
    const SensorState& state = sensor_states_[sensor_id];
    const CalibrationLearningState& learning = state.learning_state;

    // Always request human input if confidence is low
    if (learning.confidence_level == CalibrationConfidence::LOW) {
        return true;
    }

    // Check uncertainty threshold
    if (uncertainty > learning.uncertainty_threshold) {
        return true;
    }

    // Check for extrapolation
    if (isExtrapolation(sensor_id, voltage)) {
        return true;
    }

    // Check if we haven't had human input recently for medium confidence
    if (learning.confidence_level == CalibrationConfidence::MEDIUM) {
        auto time_since_input = std::chrono::system_clock::now() - learning.last_human_input;
        if (std::chrono::duration_cast<std::chrono::minutes>(time_since_input).count() > 30) {
            return true;
        }
    }

    return false;
}

HumanInputRequest SmartCalibrationSystem::createHumanInputRequest(uint8_t sensor_id, double voltage,
                                                                  double predicted_pressure,
                                                                  double uncertainty) {
    HumanInputRequest request;
    request.sensor_id = sensor_id;
    request.current_voltage = voltage;
    request.predicted_pressure = predicted_pressure;
    request.confidence_interval_lower = predicted_pressure - 2.0 * std::sqrt(uncertainty);
    request.confidence_interval_upper = predicted_pressure + 2.0 * std::sqrt(uncertainty);
    request.timestamp = std::chrono::system_clock::now();
    request.request_id = ++request_id_counter_;

    return request;
}

void SmartCalibrationSystem::updateConfidenceLevel(uint8_t sensor_id,
                                                   CalibrationConfidence new_confidence) {
    auto it = sensor_states_.find(sensor_id);
    if (it != sensor_states_.end()) {
        CalibrationConfidence old_confidence = it->second.learning_state.confidence_level;
        it->second.learning_state.confidence_level = new_confidence;

        if (new_confidence != old_confidence && confidence_change_callback_) {
            confidence_change_callback_(sensor_id, new_confidence);
        }
    }
}

double SmartCalibrationSystem::computePredictionUncertainty(uint8_t sensor_id, double voltage,
                                                            const EnvironmentalState& environment) {
    auto it = sensor_states_.find(sensor_id);
    if (it == sensor_states_.end()) {
        return 1.0;  // High uncertainty if no data
    }

    // Get prediction uncertainty from calibration framework
    auto [predicted_pressure, uncertainty] =
        it->second.calibration_framework->predictPressure(voltage, environment);

    return uncertainty;
}

bool SmartCalibrationSystem::isExtrapolation(uint8_t sensor_id, double voltage) {
    const SensorState& state = sensor_states_[sensor_id];

    if (state.calibration_data.empty()) {
        return true;
    }

    // Find voltage range in calibration data
    double min_voltage = state.calibration_data[0].voltage;
    double max_voltage = state.calibration_data[0].voltage;

    for (const auto& data_point : state.calibration_data) {
        min_voltage = std::min(min_voltage, data_point.voltage);
        max_voltage = std::max(max_voltage, data_point.voltage);
    }

    double voltage_range = max_voltage - min_voltage;
    double margin = 0.1 * voltage_range;  // 10% margin

    return voltage < (min_voltage - margin) || voltage > (max_voltage + margin);
}

double SmartCalibrationSystem::computeReliabilityScore(uint8_t sensor_id) {
    const SensorState& state = sensor_states_[sensor_id];
    const CalibrationLearningState& learning = state.learning_state;

    if (learning.human_input_count == 0) {
        return 0.0;
    }

    // Calculate success rate from validation errors
    double success_rate = 0.0;
    if (learning.autonomous_success_count + learning.autonomous_failure_count > 0) {
        success_rate = static_cast<double>(learning.autonomous_success_count) /
                       (learning.autonomous_success_count + learning.autonomous_failure_count);
    }

    // Calculate data sufficiency score
    double data_sufficiency = std::min(1.0, learning.human_input_count / 20.0);

    // Calculate consistency score from recent predictions
    double consistency_score = 0.0;
    if (state.validation_errors.size() > 5) {
        double total_error = 0.0;
        for (const auto& error_pair : state.validation_errors) {
            double error = std::abs(error_pair.first - error_pair.second);
            total_error += error;
        }
        double avg_error = total_error / state.validation_errors.size();
        consistency_score = std::max(0.0, 1.0 - avg_error / 1000.0);  // Normalize to 1000 Pa
    }

    // Weighted combination
    double reliability = 0.4 * success_rate + 0.3 * data_sufficiency + 0.3 * consistency_score;

    return std::max(0.0, std::min(1.0, reliability));
}

double SmartCalibrationSystem::getAdaptiveLearningRate(uint8_t sensor_id) {
    const SensorState& state = sensor_states_[sensor_id];
    const CalibrationLearningState& learning = state.learning_state;

    // Start with high learning rate for new sensors
    double base_rate = 0.1;

    // Reduce learning rate as confidence increases
    double confidence_factor = 1.0 - static_cast<double>(learning.confidence_level) / 3.0;

    // Reduce learning rate based on reliability
    double reliability_factor = 1.0 - learning.reliability_score;

    return base_rate * confidence_factor * reliability_factor;
}

// Factory function
std::shared_ptr<SmartCalibrationSystem> createSmartCalibrationSystem(
    const std::string& calibration_map_type) {
    auto calibration_map = createCalibrationMap(calibration_map_type);
    return std::make_shared<SmartCalibrationSystem>(calibration_map);
}
