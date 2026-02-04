#ifndef PT_CALIBRATION_TOOL_HPP
#define PT_CALIBRATION_TOOL_HPP

#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "PTCalibrationChangeDetection.hpp"
#include "PTCalibrationFramework.hpp"
#include "PTMessage.hpp"

/**
 * @brief Calibration procedure configuration
 */
struct CalibrationProcedure {
    std::string name;
    std::string description;
    std::vector<double> pressure_points;     // Reference pressure points (Pa)
    std::vector<double> dwell_times;         // Dwell time at each point (seconds)
    std::vector<double> temperature_points;  // Temperature points (°C)
    bool include_environmental_variations;
    double reference_uncertainty;        // Reference pressure uncertainty (Pa)
    double voltage_stability_threshold;  // Voltage stability threshold (V)
    int min_samples_per_point;           // Minimum samples per pressure point
    int max_samples_per_point;           // Maximum samples per pressure point

    CalibrationProcedure()
        : reference_uncertainty(100.0),
          voltage_stability_threshold(0.01),
          min_samples_per_point(10),
          max_samples_per_point(100),
          include_environmental_variations(false) {
    }
};

/**
 * @brief Calibration session data
 */
struct CalibrationSession {
    std::string session_id;
    std::string sensor_id;
    std::string pt_location_name;
    uint8_t pt_location_enum;
    std::chrono::system_clock::time_point start_time;
    std::chrono::system_clock::time_point end_time;
    std::vector<CalibrationDataPoint> data_points;
    CalibrationParameters calibration_result;
    CalibrationQualityMetrics quality_metrics;
    EnvironmentalVarianceModel variance_model;
    bool calibration_successful;
    std::string error_message;

    CalibrationSession() : pt_location_enum(9), calibration_successful(false) {
    }
};

/**
 * @brief Real-time calibration monitor
 */
class PTCalibrationMonitor {
public:
    /**
     * @brief Constructor
     */
    PTCalibrationMonitor();

    /**
     * @brief Destructor
     */
    ~PTCalibrationMonitor();

    /**
     * @brief Start monitoring a sensor
     * @param sensor_id Sensor ID to monitor
     * @param pt_location PT location
     */
    void startMonitoring(uint8_t sensor_id, uint8_t pt_location);

    /**
     * @brief Stop monitoring a sensor
     * @param sensor_id Sensor ID to stop monitoring
     */
    void stopMonitoring(uint8_t sensor_id);

    /**
     * @brief Add PT measurement
     * @param pt_message PT message
     * @param reference_pressure Reference pressure (if available)
     * @param environment Environmental state
     */
    void addPTMeasurement(const PTMessage& pt_message, double reference_pressure = -1.0,
                          const EnvironmentalState& environment = EnvironmentalState());

    /**
     * @brief Get sensor calibration status
     * @param sensor_id Sensor ID
     * @return Calibration status
     */
    std::string getSensorStatus(uint8_t sensor_id) const;

    /**
     * @brief Get sensor calibration quality
     * @param sensor_id Sensor ID
     * @return Calibration quality metrics
     */
    CalibrationQualityMetrics getSensorQuality(uint8_t sensor_id) const;

    /**
     * @brief Check if sensor needs recalibration
     * @param sensor_id Sensor ID
     * @return true if recalibration needed
     */
    bool needsRecalibration(uint8_t sensor_id) const;

    /**
     * @brief Get all monitored sensors
     * @return Vector of sensor IDs
     */
    std::vector<uint8_t> getMonitoredSensors() const;

private:
    struct SensorData {
        uint8_t sensor_id;
        uint8_t pt_location;
        std::shared_ptr<PTAdaptiveCalibrationSystem> adaptive_system;
        std::vector<PTMessage> recent_measurements;
        std::string status;
        CalibrationQualityMetrics quality_metrics;
        bool needs_recalibration;
        std::chrono::system_clock::time_point last_update;
    };

    std::map<uint8_t, SensorData> sensors_;
    std::shared_ptr<CalibrationMapFunction> calibration_map_;

    /**
     * @brief Update sensor status
     * @param sensor_id Sensor ID
     */
    void updateSensorStatus(uint8_t sensor_id);
};

/**
 * @brief Comprehensive PT Calibration Tool
 */
class PTCalibrationTool {
public:
    /**
     * @brief Constructor
     * @param calibration_map_type Type of calibration map to use
     */
    PTCalibrationTool(const std::string& calibration_map_type = "environmental_robust");

    /**
     * @brief Destructor
     */
    ~PTCalibrationTool();

    /**
     * @brief Create calibration procedure
     * @param name Procedure name
     * @param pressure_range_min Minimum pressure (Pa)
     * @param pressure_range_max Maximum pressure (Pa)
     * @param num_points Number of pressure points
     * @param include_env_variations Include environmental variations
     * @return Calibration procedure
     */
    CalibrationProcedure createCalibrationProcedure(const std::string& name,
                                                    double pressure_range_min,
                                                    double pressure_range_max, int num_points = 10,
                                                    bool include_env_variations = false);

    /**
     * @brief Start calibration session
     * @param sensor_id Sensor ID
     * @param pt_location PT location
     * @param procedure Calibration procedure
     * @return Session ID
     */
    std::string startCalibrationSession(uint8_t sensor_id, uint8_t pt_location,
                                        const CalibrationProcedure& procedure);

    /**
     * @brief Add calibration data point
     * @param session_id Session ID
     * @param voltage Voltage reading
     * @param reference_pressure Reference pressure
     * @param environment Environmental state
     * @return true if successful
     */
    bool addCalibrationDataPoint(const std::string& session_id, double voltage,
                                 double reference_pressure,
                                 const EnvironmentalState& environment = EnvironmentalState());

    /**
     * @brief Complete calibration session
     * @param session_id Session ID
     * @param population_prior_mean Population prior mean (optional)
     * @param population_prior_covariance Population prior covariance (optional)
     * @return Calibration session with results
     */
    CalibrationSession completeCalibrationSession(
        const std::string& session_id, const Eigen::VectorXd* population_prior_mean = nullptr,
        const Eigen::MatrixXd* population_prior_covariance = nullptr);

    /**
     * @brief Load calibration session from file
     * @param filename Session file
     * @return Calibration session
     */
    CalibrationSession loadCalibrationSession(const std::string& filename);

    /**
     * @brief Save calibration session to file
     * @param session Calibration session
     * @param filename Output filename
     * @return true if successful
     */
    bool saveCalibrationSession(const CalibrationSession& session, const std::string& filename);

    /**
     * @brief Validate calibration session
     * @param session Calibration session
     * @return Validation result with error messages
     */
    std::pair<bool, std::string> validateCalibrationSession(const CalibrationSession& session);

    /**
     * @brief Generate calibration report
     * @param session Calibration session
     * @return Calibration report as string
     */
    std::string generateCalibrationReport(const CalibrationSession& session);

    /**
     * @brief Get active calibration sessions
     * @return Vector of active session IDs
     */
    std::vector<std::string> getActiveSessions() const;

    /**
     * @brief Get calibration session by ID
     * @param session_id Session ID
     * @return Calibration session (if found)
     */
    std::shared_ptr<CalibrationSession> getCalibrationSession(const std::string& session_id) const;

    /**
     * @brief Cancel calibration session
     * @param session_id Session ID
     * @return true if successful
     */
    bool cancelCalibrationSession(const std::string& session_id);

    /**
     * @brief Get calibration monitor
     * @return Reference to calibration monitor
     */
    PTCalibrationMonitor& getCalibrationMonitor() {
        return monitor_;
    }

private:
    std::shared_ptr<CalibrationMapFunction> calibration_map_;
    std::map<std::string, std::shared_ptr<CalibrationSession>> active_sessions_;
    PTCalibrationMonitor monitor_;

    /**
     * @brief Generate unique session ID
     * @return Unique session ID
     */
    std::string generateSessionID();

    /**
     * @brief Validate calibration data
     * @param session Calibration session
     * @return Validation result
     */
    std::pair<bool, std::string> validateCalibrationData(const CalibrationSession& session);

    /**
     * @brief Compute population priors from historical data
     * @return Pair of (prior_mean, prior_covariance)
     */
    std::pair<Eigen::VectorXd, Eigen::MatrixXd> computePopulationPriors();
};

/**
 * @brief Calibration data collector for real-time data gathering
 */
class PTCalibrationDataCollector {
public:
    /**
     * @brief Constructor
     * @param calibration_tool Reference to calibration tool
     */
    PTCalibrationDataCollector(PTCalibrationTool& calibration_tool);

    /**
     * @brief Destructor
     */
    ~PTCalibrationDataCollector();

    /**
     * @brief Start collecting data for calibration
     * @param session_id Calibration session ID
     * @param target_pressure Target pressure for current point
     * @param dwell_time Dwell time at this pressure
     */
    void startDataCollection(const std::string& session_id, double target_pressure,
                             double dwell_time);

    /**
     * @brief Stop data collection
     * @param session_id Session ID
     */
    void stopDataCollection(const std::string& session_id);

    /**
     * @brief Add PT measurement
     * @param pt_message PT message
     * @param reference_pressure Reference pressure
     * @param environment Environmental state
     */
    void addPTMeasurement(const PTMessage& pt_message, double reference_pressure,
                          const EnvironmentalState& environment = EnvironmentalState());

    /**
     * @brief Get collection status
     * @param session_id Session ID
     * @return Collection status
     */
    std::string getCollectionStatus(const std::string& session_id) const;

    /**
     * @brief Check if collection is complete
     * @param session_id Session ID
     * @return true if collection complete
     */
    bool isCollectionComplete(const std::string& session_id) const;

private:
    struct CollectionData {
        std::string session_id;
        double target_pressure;
        double dwell_time;
        std::chrono::system_clock::time_point start_time;
        std::chrono::system_clock::time_point end_time;
        std::vector<PTMessage> measurements;
        bool is_active;
    };

    PTCalibrationTool& calibration_tool_;
    std::map<std::string, CollectionData> collections_;

    /**
     * @brief Process collected measurements
     * @param session_id Session ID
     */
    void processCollectedMeasurements(const std::string& session_id);
};

#endif  // PT_CALIBRATION_TOOL_HPP
