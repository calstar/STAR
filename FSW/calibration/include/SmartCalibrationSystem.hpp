#ifndef SMART_CALIBRATION_SYSTEM_HPP
#define SMART_CALIBRATION_SYSTEM_HPP

#include <Eigen/Core>
#include <Eigen/Dense>
#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <queue>
#include <vector>

#include "PTCalibrationChangeDetection.hpp"
#include "PTCalibrationFramework.hpp"

/**
 * @brief Calibration confidence levels
 */
enum class CalibrationConfidence {
    LOW = 0,     // Human input required
    MEDIUM = 1,  // Human confirmation recommended
    HIGH = 2,    // System can operate autonomously
    MAXIMUM = 3  // Fully autonomous operation
};

/**
 * @brief Human input request
 */
struct HumanInputRequest {
    uint8_t sensor_id;
    double current_voltage;
    double predicted_pressure;
    double confidence_interval_lower;
    double confidence_interval_upper;
    std::string reason;  // Why human input is needed
    std::chrono::system_clock::time_point timestamp;
    uint64_t request_id;

    HumanInputRequest()
        : sensor_id(0),
          current_voltage(0.0),
          predicted_pressure(0.0),
          confidence_interval_lower(0.0),
          confidence_interval_upper(0.0),
          request_id(0) {
    }
};

/**
 * @brief Calibration learning state
 */
struct CalibrationLearningState {
    CalibrationConfidence confidence_level;
    double uncertainty_threshold;
    double learning_rate;
    int human_input_count;
    int autonomous_success_count;
    int autonomous_failure_count;
    double reliability_score;  // 0.0 to 1.0
    std::chrono::system_clock::time_point last_human_input;
    std::chrono::system_clock::time_point last_validation;

    CalibrationLearningState()
        : confidence_level(CalibrationConfidence::LOW),
          uncertainty_threshold(0.1),
          learning_rate(0.1),
          human_input_count(0),
          autonomous_success_count(0),
          autonomous_failure_count(0),
          reliability_score(0.0) {
    }
};

/**
 * @brief Smart Calibration System with Progressive Autonomy
 *
 * This system starts with human-in-the-loop calibration and gradually
 * becomes autonomous as it learns and builds confidence.
 */
class SmartCalibrationSystem {
public:
    /**
     * @brief Constructor
     * @param calibration_map Calibration map function
     */
    SmartCalibrationSystem(std::shared_ptr<CalibrationMapFunction> calibration_map);

    /**
     * @brief Destructor
     */
    ~SmartCalibrationSystem();

    /**
     * @brief Process new PT measurement
     * @param sensor_id Sensor ID
     * @param voltage Raw voltage
     * @param timestamp Measurement timestamp
     * @param environment Environmental conditions
     * @return Pair of (predicted_pressure, needs_human_input)
     */
    std::pair<double, bool> processMeasurement(uint8_t sensor_id, double voltage,
                                               uint64_t timestamp,
                                               const EnvironmentalState& environment);

    /**
     * @brief Provide human input for calibration
     * @param sensor_id Sensor ID
     * @param voltage Voltage reading
     * @param reference_pressure Human-provided reference pressure
     * @param timestamp Timestamp
     * @param environment Environmental conditions
     */
    void provideHumanInput(uint8_t sensor_id, double voltage, double reference_pressure,
                           uint64_t timestamp, const EnvironmentalState& environment);

    /**
     * @brief Validate autonomous prediction
     * @param sensor_id Sensor ID
     * @param predicted_pressure System prediction
     * @param actual_pressure Actual pressure (from external source)
     * @param timestamp Timestamp
     */
    void validatePrediction(uint8_t sensor_id, double predicted_pressure, double actual_pressure,
                            uint64_t timestamp);

    /**
     * @brief Get current calibration confidence for sensor
     * @param sensor_id Sensor ID
     * @return Calibration confidence level
     */
    CalibrationConfidence getCalibrationConfidence(uint8_t sensor_id) const;

    /**
     * @brief Get learning state for sensor
     * @param sensor_id Sensor ID
     * @return Learning state
     */
    CalibrationLearningState getLearningState(uint8_t sensor_id) const;

    /**
     * @brief Check if human input is needed
     * @param sensor_id Sensor ID
     * @return true if human input needed
     */
    bool needsHumanInput(uint8_t sensor_id) const;

    /**
     * @brief Get pending human input requests
     * @return Vector of pending requests
     */
    std::vector<HumanInputRequest> getPendingRequests() const;

    /**
     * @brief Get reliability score for sensor
     * @param sensor_id Sensor ID
     * @return Reliability score (0.0 to 1.0)
     */
    double getReliabilityScore(uint8_t sensor_id) const;

    /**
     * @brief Force recalibration for sensor
     * @param sensor_id Sensor ID
     */
    void forceRecalibration(uint8_t sensor_id);

    /**
     * @brief Set confidence thresholds
     * @param low_threshold Low confidence threshold
     * @param medium_threshold Medium confidence threshold
     * @param high_threshold High confidence threshold
     */
    void setConfidenceThresholds(double low_threshold = 0.05, double medium_threshold = 0.02,
                                 double high_threshold = 0.01);

    /**
     * @brief Get calibration statistics
     * @return Map of sensor_id to statistics
     */
    std::map<uint8_t, std::map<std::string, double>> getCalibrationStatistics() const;

    /**
     * @brief Save learning state to file
     * @param filename Output filename
     * @return true if successful
     */
    bool saveLearningState(const std::string& filename) const;

    /**
     * @brief Load learning state from file
     * @param filename Input filename
     * @return true if successful
     */
    bool loadLearningState(const std::string& filename);

    /**
     * @brief Register callback for human input requests
     * @param callback Function to call when human input is needed
     */
    void registerHumanInputCallback(std::function<void(const HumanInputRequest&)> callback);

    /**
     * @brief Register callback for confidence level changes
     * @param callback Function to call when confidence level changes
     */
    void registerConfidenceChangeCallback(
        std::function<void(uint8_t, CalibrationConfidence)> callback);

private:
    struct SensorState {
        std::shared_ptr<PTCalibrationFramework> calibration_framework;
        std::shared_ptr<PTAdaptiveCalibrationSystem> adaptive_system;
        CalibrationLearningState learning_state;
        std::vector<CalibrationDataPoint> calibration_data;
        std::deque<std::pair<double, double>> recent_predictions;  // voltage, pressure pairs
        std::deque<std::pair<double, double>> validation_errors;   // prediction, actual pairs
        double last_voltage;
        double last_predicted_pressure;
        std::chrono::system_clock::time_point last_measurement;

        SensorState() : last_voltage(0.0), last_predicted_pressure(0.0) {
        }
    };

    std::shared_ptr<CalibrationMapFunction> calibration_map_;
    std::map<uint8_t, SensorState> sensor_states_;
    std::queue<HumanInputRequest> pending_requests_;

    // Configuration
    double low_confidence_threshold_;
    double medium_confidence_threshold_;
    double high_confidence_threshold_;

    // Callbacks
    std::function<void(const HumanInputRequest&)> human_input_callback_;
    std::function<void(uint8_t, CalibrationConfidence)> confidence_change_callback_;

    // Request ID counter
    uint64_t request_id_counter_;

    /**
     * @brief Initialize sensor state
     * @param sensor_id Sensor ID
     */
    void initializeSensorState(uint8_t sensor_id);

    /**
     * @brief Update learning state based on recent performance
     * @param sensor_id Sensor ID
     */
    void updateLearningState(uint8_t sensor_id);

    /**
     * @brief Determine if human input is needed
     * @param sensor_id Sensor ID
     * @param voltage Current voltage
     * @param predicted_pressure Predicted pressure
     * @param uncertainty Prediction uncertainty
     * @return true if human input needed
     */
    bool shouldRequestHumanInput(uint8_t sensor_id, double voltage, double predicted_pressure,
                                 double uncertainty);

    /**
     * @brief Create human input request
     * @param sensor_id Sensor ID
     * @param voltage Current voltage
     * @param predicted_pressure Predicted pressure
     * @param uncertainty Prediction uncertainty
     * @return Human input request
     */
    HumanInputRequest createHumanInputRequest(uint8_t sensor_id, double voltage,
                                              double predicted_pressure, double uncertainty);

    /**
     * @brief Update confidence level
     * @param sensor_id Sensor ID
     * @param new_confidence New confidence level
     */
    void updateConfidenceLevel(uint8_t sensor_id, CalibrationConfidence new_confidence);

    /**
     * @brief Compute prediction uncertainty
     * @param sensor_id Sensor ID
     * @param voltage Current voltage
     * @param environment Environmental conditions
     * @return Prediction uncertainty (standard deviation)
     */
    double computePredictionUncertainty(uint8_t sensor_id, double voltage,
                                        const EnvironmentalState& environment);

    /**
     * @brief Check for extrapolation
     * @param sensor_id Sensor ID
     * @param voltage Current voltage
     * @return true if voltage is outside calibration range
     */
    bool isExtrapolation(uint8_t sensor_id, double voltage);

    /**
     * @brief Update calibration with new data point
     * @param sensor_id Sensor ID
     * @param data_point New calibration data point
     */
    void updateCalibration(uint8_t sensor_id, const CalibrationDataPoint& data_point);

    /**
     * @brief Compute reliability score
     * @param sensor_id Sensor ID
     * @return Reliability score (0.0 to 1.0)
     */
    double computeReliabilityScore(uint8_t sensor_id);

    /**
     * @brief Adaptive learning rate based on performance
     * @param sensor_id Sensor ID
     * @return Learning rate
     */
    double getAdaptiveLearningRate(uint8_t sensor_id);
};

/**
 * @brief Factory function to create smart calibration system
 * @param calibration_map_type Type of calibration map
 * @return Smart calibration system
 */
std::shared_ptr<SmartCalibrationSystem> createSmartCalibrationSystem(
    const std::string& calibration_map_type);

#endif  // SMART_CALIBRATION_SYSTEM_HPP
