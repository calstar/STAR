#ifndef PT_OBSERVATION_MATRIX_HPP
#define PT_OBSERVATION_MATRIX_HPP

#include <Eigen/Dense>
#include <cstdint>
#include <map>
#include <memory>
#include <vector>

#include "PTMessage.hpp"

/**
 * @brief PT Sensor measurement with raw voltage data
 */
struct PTMeasurement {
    uint8_t sensor_id;      // Sensor ID (0-8)
    double raw_voltage_v;   // Raw voltage in Volts
    uint8_t pt_location;    // PT location enum value
    uint64_t timestamp_ns;  // Timestamp in nanoseconds
    bool valid;             // Whether measurement is valid

    PTMeasurement()
        : sensor_id(0), raw_voltage_v(0.0), pt_location(9), timestamp_ns(0), valid(false) {
    }

    PTMeasurement(uint8_t id, double voltage, uint8_t location, uint64_t timestamp)
        : sensor_id(id),
          raw_voltage_v(voltage),
          pt_location(location),
          timestamp_ns(timestamp),
          valid(true) {
    }
};

/**
 * @brief Configuration for PT observation matrix building
 */
struct PTObservationMatrixConfig {
    double max_data_age_ms;          // Maximum age of data to include (ms)
    double time_sync_tolerance_ms;   // Time synchronization tolerance (ms)
    bool enable_outlier_detection;   // Enable outlier detection
    double outlier_threshold_sigma;  // Outlier threshold in standard deviations
    size_t max_pt_sensors;           // Maximum number of PT sensors (default 9)
    bool enable_interpolation;       // Enable interpolation for missing data
    double interpolation_window_ms;  // Interpolation window size (ms)
};

/**
 * @brief Result of PT observation matrix building
 */
struct PTObservationMatrixResult {
    Eigen::MatrixXd observation_matrix;       // H matrix (measurements x states)
    Eigen::VectorXd measurement_vector;       // z vector (pressure measurements)
    Eigen::MatrixXd measurement_covariance;   // R matrix (measurement noise)
    std::vector<PTMeasurement> measurements;  // Raw PT measurements used
    std::vector<uint8_t> sensor_ids;          // Sensor IDs used
    uint64_t timestamp_ns;                    // Timestamp of observation
    bool valid;                               // Whether the matrix is valid
    std::string error_message;                // Error message if invalid
};

/**
 * @brief PT Observation Matrix Builder for Engine Control
 *
 * Builds observation matrices specifically for PT sensors in engine control applications.
 * Handles dynamic sensor availability and builds matrices for pressure-based state estimation.
 */
class PTObservationMatrixBuilder {
public:
    /**
     * @brief Constructor
     * @param config Configuration for PT observation matrix building
     */
    explicit PTObservationMatrixBuilder(const PTObservationMatrixConfig& config);

    /**
     * @brief Add PT sensor data to the observation set
     * @param pt_messages Vector of PT messages
     */
    void addPTSensors(const std::vector<std::shared_ptr<PTMessage>>& pt_messages);

    /**
     * @brief Add a single PT measurement
     * @param measurement PT measurement to add
     */
    void addPTMeasurement(const PTMeasurement& measurement);

    /**
     * @brief Build observation matrix for engine state estimation
     * @param state_vector_size Size of the engine state vector
     * @return PT observation matrix result
     */
    PTObservationMatrixResult buildEngineStateObservationMatrix(size_t state_vector_size = 9);

    /**
     * @brief Build observation matrix for specific sensor locations
     * @param sensor_locations Map of state indices to sensor IDs
     * @param state_vector_size Size of the state vector
     * @return PT observation matrix result
     */
    PTObservationMatrixResult buildCustomObservationMatrix(
        const std::map<size_t, uint8_t>& sensor_locations, size_t state_vector_size);

    /**
     * @brief Clear all accumulated PT data
     */
    void clear();

    /**
     * @brief Get current PT measurements
     * @return Vector of current PT measurements
     */
    std::vector<PTMeasurement> getCurrentMeasurements() const;

    /**
     * @brief Get statistics about PT sensor data
     * @return Map of sensor_id to statistics
     */
    std::map<uint8_t, std::map<std::string, double>> getPTStatistics() const;

    /**
     * @brief Check if PT sensor data is available and recent
     * @param sensor_id Sensor ID to check
     * @return true if recent data is available
     */
    bool hasRecentPTData(uint8_t sensor_id) const;

    /**
     * @brief Get the number of available PT sensors
     * @return Number of available PT sensors
     */
    size_t getPTSensorCount() const;

    /**
     * @brief Get list of active PT sensor IDs
     * @return Vector of active sensor IDs
     */
    std::vector<uint8_t> getActivePTSensors() const;

private:
    PTObservationMatrixConfig config_;
    std::vector<PTMeasurement> measurements_;
    std::map<uint8_t, PTMeasurement> latest_measurements_;

    /**
     * @brief Filter measurements by age and validity
     */
    void filterMeasurements();

    /**
     * @brief Perform outlier detection on PT measurements
     */
    void detectOutliers();

    /**
     * @brief Synchronize measurement timestamps
     */
    void synchronizeTimestamps();

    /**
     * @brief Build measurement vector from PT data
     * @param sensor_locations Map of state indices to sensor IDs
     * @return Measurement vector
     */
    Eigen::VectorXd buildMeasurementVector(const std::map<size_t, uint8_t>& sensor_locations);

    /**
     * @brief Build observation matrix from PT data
     * @param state_vector_size Size of state vector
     * @param sensor_locations Map of state indices to sensor IDs
     * @return Observation matrix
     */
    Eigen::MatrixXd buildObservationMatrix(size_t state_vector_size,
                                           const std::map<size_t, uint8_t>& sensor_locations);

    /**
     * @brief Build measurement covariance matrix
     * @param measurements Vector of PT measurements
     * @return Covariance matrix
     */
    Eigen::MatrixXd buildMeasurementCovariance(const std::vector<PTMeasurement>& measurements);

    /**
     * @brief Convert PT message to PT measurement
     * @param pt_message PT message
     * @return PT measurement
     */
    PTMeasurement convertPTMessage(const PTMessage& pt_message);

    /**
     * @brief Check if measurement is within acceptable time window
     * @param timestamp Measurement timestamp
     * @return true if measurement is recent enough
     */
    bool isMeasurementRecent(uint64_t timestamp) const;

    /**
     * @brief Get current timestamp in nanoseconds
     * @return Current timestamp
     */
    uint64_t getCurrentTimestamp() const;
};

/**
 * @brief Default configuration for PT observation matrix building
 * @return Default configuration
 */
PTObservationMatrixConfig getDefaultPTObservationMatrixConfig();

/**
 * @brief Create PT observation matrix builder with default config
 * @return Shared pointer to PT observation matrix builder
 */
std::shared_ptr<PTObservationMatrixBuilder> createPTObservationMatrixBuilder();

#endif  // PT_OBSERVATION_MATRIX_HPP
