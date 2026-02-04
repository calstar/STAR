#ifndef OBSERVATION_MATRIX_HPP
#define OBSERVATION_MATRIX_HPP

#include <Eigen/Dense>
#include <cstdint>
#include <map>
#include <memory>
#include <vector>

#include "BarometerMessage.hpp"
#include "GPSMessage.hpp"
#include "IMUMessage.hpp"
#include "PTMessage.hpp"

/**
 * @brief Types of sensors that can be used in observation matrices
 */
enum class SensorType {
    PT_PRESSURE,     // Pressure Transducer
    PT_TEMPERATURE,  // Temperature from PT
    IMU_ACCEL,       // IMU Accelerometer
    IMU_GYRO,        // IMU Gyroscope
    BAROMETER,       // Barometric pressure
    GPS_POSITION,    // GPS position
    GPS_VELOCITY,    // GPS velocity
    UNKNOWN
};

/**
 * @brief Sensor measurement with metadata
 */
struct SensorMeasurement {
    SensorType type;
    uint8_t sensor_id;
    double value;
    double uncertainty;
    uint64_t timestamp_ns;
    bool valid;

    SensorMeasurement()
        : type(SensorType::UNKNOWN),
          sensor_id(0),
          value(0.0),
          uncertainty(0.0),
          timestamp_ns(0),
          valid(false) {
    }

    SensorMeasurement(SensorType t, uint8_t id, double val, double unc, uint64_t ts)
        : type(t), sensor_id(id), value(val), uncertainty(unc), timestamp_ns(ts), valid(true) {
    }
};

/**
 * @brief Configuration for observation matrix building
 */
struct ObservationMatrixConfig {
    double max_data_age_ms;          // Maximum age of data to include (ms)
    double time_sync_tolerance_ms;   // Time synchronization tolerance (ms)
    bool enable_outlier_detection;   // Enable outlier detection
    double outlier_threshold_sigma;  // Outlier threshold in standard deviations
    bool enable_interpolation;       // Enable data interpolation for missing sensors
    double interpolation_window_ms;  // Window for interpolation (ms)
    size_t max_sensors_per_type;     // Maximum sensors per type to include
};

/**
 * @brief Result of observation matrix building
 */
struct ObservationMatrixResult {
    Eigen::MatrixXd observation_matrix;           // H matrix (measurements x states)
    Eigen::VectorXd measurement_vector;           // z vector (measurements)
    Eigen::MatrixXd measurement_covariance;       // R matrix (measurement noise)
    std::vector<SensorMeasurement> measurements;  // Raw measurements used
    std::vector<SensorType> measurement_types;    // Types of measurements
    std::vector<uint8_t> sensor_ids;              // Sensor IDs used
    uint64_t timestamp_ns;                        // Timestamp of observation
    bool valid;                                   // Whether the matrix is valid
    std::string error_message;                    // Error message if invalid
};

/**
 * @brief Observation Matrix Builder for Sensor Fusion
 *
 * Builds observation matrices for Kalman filters and other sensor fusion algorithms.
 * Handles dynamic sensor availability, time synchronization, and measurement validation.
 */
class ObservationMatrixBuilder {
public:
    /**
     * @brief Constructor
     * @param config Configuration for observation matrix building
     */
    explicit ObservationMatrixBuilder(const ObservationMatrixConfig& config);

    /**
     * @brief Add PT sensor data to the observation set
     * @param pt_messages Vector of PT messages
     * @param use_pressure Whether to use pressure measurements
     * @param use_temperature Whether to use temperature measurements
     */
    void addPTSensors(const std::vector<std::shared_ptr<PTMessage>>& pt_messages,
                      bool use_pressure = true, bool use_temperature = false);

    /**
     * @brief Add IMU sensor data to the observation set
     * @param imu_messages Vector of IMU messages
     * @param use_accelerometer Whether to use accelerometer data
     * @param use_gyroscope Whether to use gyroscope data
     */
    void addIMUSensors(const std::vector<std::shared_ptr<IMUMessage>>& imu_messages,
                       bool use_accelerometer = true, bool use_gyroscope = true);

    /**
     * @brief Add barometer sensor data to the observation set
     * @param barometer_messages Vector of barometer messages
     */
    void addBarometerSensors(
        const std::vector<std::shared_ptr<BarometerMessage>>& barometer_messages);

    /**
     * @brief Add GPS sensor data to the observation set
     * @param gps_position_messages Vector of GPS position messages
     * @param gps_velocity_messages Vector of GPS velocity messages
     */
    void addGPSSensors(
        const std::vector<std::shared_ptr<GPSPositionMessage>>& gps_position_messages,
        const std::vector<std::shared_ptr<GPSVelocityMessage>>& gps_velocity_messages);

    /**
     * @brief Add custom sensor measurement
     * @param measurement Sensor measurement to add
     */
    void addSensorMeasurement(const SensorMeasurement& measurement);

    /**
     * @brief Build the observation matrix for a specific state vector
     * @param state_vector_size Size of the state vector
     * @param state_mapping Map of state indices to sensor types
     * @return Observation matrix result
     */
    ObservationMatrixResult buildObservationMatrix(
        size_t state_vector_size, const std::map<size_t, SensorType>& state_mapping);

    /**
     * @brief Build observation matrix for rocket engine state estimation
     * @return Observation matrix result for engine states
     */
    ObservationMatrixResult buildEngineStateObservationMatrix();

    /**
     * @brief Build observation matrix for navigation state estimation
     * @return Observation matrix result for navigation states
     */
    ObservationMatrixResult buildNavigationStateObservationMatrix();

    /**
     * @brief Clear all accumulated sensor data
     */
    void clear();

    /**
     * @brief Get current sensor measurements
     * @return Vector of current sensor measurements
     */
    std::vector<SensorMeasurement> getCurrentMeasurements() const;

    /**
     * @brief Get statistics about sensor data
     * @return Map of sensor type to count and age statistics
     */
    std::map<SensorType, std::map<std::string, double>> getSensorStatistics() const;

    /**
     * @brief Check if sensor data is available and recent
     * @param sensor_type Type of sensor to check
     * @return true if recent data is available
     */
    bool hasRecentData(SensorType sensor_type) const;

    /**
     * @brief Get the number of available sensors of a specific type
     * @param sensor_type Type of sensor to count
     * @return Number of available sensors
     */
    size_t getSensorCount(SensorType sensor_type) const;

private:
    ObservationMatrixConfig config_;
    std::vector<SensorMeasurement> measurements_;
    std::map<SensorType, std::vector<SensorMeasurement>> measurements_by_type_;

    /**
     * @brief Filter measurements by age and validity
     */
    void filterMeasurements();

    /**
     * @brief Perform outlier detection on measurements
     */
    void detectOutliers();

    /**
     * @brief Synchronize measurement timestamps
     */
    void synchronizeTimestamps();

    /**
     * @brief Interpolate missing sensor data
     */
    void interpolateMissingData();

    /**
     * @brief Build measurement vector from sensor data
     * @param state_mapping Map of state indices to sensor types
     * @return Measurement vector
     */
    Eigen::VectorXd buildMeasurementVector(const std::map<size_t, SensorType>& state_mapping);

    /**
     * @brief Build observation matrix from sensor data
     * @param state_vector_size Size of state vector
     * @param state_mapping Map of state indices to sensor types
     * @return Observation matrix
     */
    Eigen::MatrixXd buildObservationMatrixOnly(size_t state_vector_size,
                                               const std::map<size_t, SensorType>& state_mapping);

    /**
     * @brief Build measurement covariance matrix
     * @param measurements Vector of measurements
     * @return Covariance matrix
     */
    Eigen::MatrixXd buildMeasurementCovariance(const std::vector<SensorMeasurement>& measurements);

    /**
     * @brief Convert PT message to sensor measurement
     * @param pt_message PT message
     * @param use_pressure Whether to extract pressure
     * @param use_temperature Whether to extract temperature
     * @return Vector of sensor measurements
     */
    std::vector<SensorMeasurement> convertPTMessage(const PTMessage& pt_message, bool use_pressure,
                                                    bool use_temperature);

    /**
     * @brief Convert IMU message to sensor measurement
     * @param imu_message IMU message
     * @param use_accelerometer Whether to extract accelerometer data
     * @param use_gyroscope Whether to extract gyroscope data
     * @return Vector of sensor measurements
     */
    std::vector<SensorMeasurement> convertIMUMessage(const IMUMessage& imu_message,
                                                     bool use_accelerometer, bool use_gyroscope);

    /**
     * @brief Convert barometer message to sensor measurement
     * @param barometer_message Barometer message
     * @return Sensor measurement
     */
    SensorMeasurement convertBarometerMessage(const BarometerMessage& barometer_message);

    /**
     * @brief Convert GPS message to sensor measurement
     * @param gps_message GPS message
     * @param use_position Whether to extract position data
     * @param use_velocity Whether to extract velocity data
     * @return Vector of sensor measurements
     */
    std::vector<SensorMeasurement> convertGPSPositionMessage(const GPSPositionMessage& gps_message,
                                                             bool use_position);
    std::vector<SensorMeasurement> convertGPSVelocityMessage(const GPSVelocityMessage& gps_message,
                                                             bool use_velocity);

    /**
     * @brief Calculate measurement uncertainty
     * @param measurement Sensor measurement
     * @return Calculated uncertainty
     */
    double calculateUncertainty(const SensorMeasurement& measurement);

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
 * @brief Default configuration for observation matrix building
 * @return Default configuration
 */
ObservationMatrixConfig getDefaultObservationMatrixConfig();

/**
 * @brief Create observation matrix builder with default config
 * @return Shared pointer to observation matrix builder
 */
std::shared_ptr<ObservationMatrixBuilder> createObservationMatrixBuilder();

#endif  // OBSERVATION_MATRIX_HPP
