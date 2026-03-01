#ifndef SENSOR_FUSION_HPP
#define SENSOR_FUSION_HPP

#include <Eigen/Dense>
#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

/**
 * @brief Multi-Sensor Data Fusion System
 *
 * Implements Extended Kalman Filter (EKF) and other fusion algorithms
 * for combining data from all sensors: PT, RTD, TC, IMU, GPS, encoders
 */
class SensorFusion {
public:
    enum class FusionAlgorithm {
        EXTENDED_KALMAN_FILTER,
        UNSCENTED_KALMAN_FILTER,
        PARTICLE_FILTER,
        COMPLEMENTARY_FILTER
    };

    enum class SensorID {
        // Pressure sensors
        PT_CHAMBER,
        PT_FUEL_INLET,
        PT_OX_INLET,
        PT_COOLANT_INLET,
        PT_IGNITER,

        // Temperature sensors
        RTD_CHAMBER_WALL,
        RTD_FUEL_TEMP,
        RTD_OX_TEMP,
        RTD_COOLANT_TEMP,
        TC_EXHAUST,

        // Inertial sensors
        IMU_ACCELEROMETER,
        IMU_GYROSCOPE,
        IMU_MAGNETOMETER,

        // Position sensors
        GPS_POSITION,
        GPS_VELOCITY,
        ENCODER_FUEL_VALVE,
        ENCODER_OX_VALVE,
        ENCODER_GIMBAL_X,
        ENCODER_GIMBAL_Y
    };

    struct SensorMeasurement {
        SensorID sensor_id;
        Eigen::VectorXd measurement;  // Raw measurement vector
        Eigen::MatrixXd covariance;   // Measurement covariance
        std::chrono::steady_clock::time_point timestamp;
        bool valid;      // Measurement validity flag
        double quality;  // Measurement quality (0-1)
    };

    struct EngineState {
        // Position and attitude
        Eigen::Vector3d position;          // 3D position (m)
        Eigen::Vector3d velocity;          // 3D velocity (m/s)
        Eigen::Vector3d acceleration;      // 3D acceleration (m/s²)
        Eigen::Quaterniond attitude;       // Attitude quaternion
        Eigen::Vector3d angular_velocity;  // Angular velocity (rad/s)

        // Engine parameters
        double thrust;            // Thrust (N)
        double chamber_pressure;  // Chamber pressure (Pa)
        double fuel_flow_rate;    // Fuel flow rate (kg/s)
        double ox_flow_rate;      // Oxidizer flow rate (kg/s)
        double mixture_ratio;     // O/F ratio
        double specific_impulse;  // Isp (s)

        // Valve positions
        double fuel_valve_position;  // Fuel valve position (0-1)
        double ox_valve_position;    // Ox valve position (0-1)
        double gimbal_x_angle;       // Gimbal X angle (rad)
        double gimbal_y_angle;       // Gimbal Y angle (rad)

        // Environmental conditions
        Eigen::VectorXd environmental_state;  // Temperature, humidity, etc.

        // Uncertainty estimates
        Eigen::MatrixXd state_covariance;  // State estimate covariance
        std::chrono::steady_clock::time_point timestamp;
    };

    struct FusionConfig {
        FusionAlgorithm algorithm;
        double process_noise_variance;
        double measurement_noise_variance;
        double initial_state_uncertainty;
        bool enable_outlier_rejection;
        double outlier_threshold;
        bool enable_adaptive_filtering;
        double adaptation_rate;
        std::vector<SensorID> enabled_sensors;
        std::chrono::milliseconds fusion_period;
    };

    SensorFusion();
    ~SensorFusion();

    // Main fusion interface
    bool initialize(const FusionConfig& config);
    void run();
    void stop();

    // Measurement input
    bool addMeasurement(const SensorMeasurement& measurement);
    bool addMeasurements(const std::vector<SensorMeasurement>& measurements);

    // State estimation output
    EngineState getCurrentState() const;
    EngineState getStateAtTime(const std::chrono::steady_clock::time_point& time) const;
    Eigen::MatrixXd getStateCovariance() const;

    // Configuration
    bool updateConfig(const FusionConfig& config);
    bool enableSensor(SensorID sensor_id, bool enable);
    bool setSensorNoiseModel(SensorID sensor_id, const Eigen::MatrixXd& noise_covariance);

    // Calibration integration
    bool integrateCalibrationData(SensorID sensor_id, const Eigen::VectorXd& calibration_params,
                                  const Eigen::MatrixXd& calibration_covariance);

    // Health monitoring
    bool isSensorHealthy(SensorID sensor_id) const;
    std::vector<SensorID> getUnhealthySensors() const;
    double getSensorHealth(SensorID sensor_id) const;

    // Outlier detection and rejection
    bool detectOutlier(const SensorMeasurement& measurement) const;
    bool rejectOutlier(const SensorMeasurement& measurement);

private:
    void fusionLoop();
    void processMeasurements();
    void updateStateEstimate();
    void predictState();
    void correctState();

    // EKF implementation
    void ekfPredict();
    void ekfCorrect(const SensorMeasurement& measurement);
    Eigen::MatrixXd computeProcessJacobian() const;
    Eigen::MatrixXd computeMeasurementJacobian(SensorID sensor_id) const;

    // UKF implementation
    void ukfPredict();
    void ukfCorrect(const SensorMeasurement& measurement);
    std::vector<Eigen::VectorXd> generateSigmaPoints() const;
    void computeSigmaPointWeights();

    // Particle filter implementation
    void particleFilterPredict();
    void particleFilterCorrect(const SensorMeasurement& measurement);
    void resampleParticles();

    // Complementary filter implementation
    void complementaryFilterUpdate(const SensorMeasurement& measurement);

    // Sensor models
    Eigen::VectorXd pressureTransducerModel(const Eigen::VectorXd& state) const;
    Eigen::VectorXd rtdModel(const Eigen::VectorXd& state) const;
    Eigen::VectorXd thermocoupleModel(const Eigen::VectorXd& state) const;
    Eigen::VectorXd imuModel(const Eigen::VectorXd& state) const;
    Eigen::VectorXd gpsModel(const Eigen::VectorXd& state) const;
    Eigen::VectorXd encoderModel(const Eigen::VectorXd& state) const;

    // Outlier detection
    bool mahalanobisOutlierTest(const Eigen::VectorXd& innovation,
                                const Eigen::MatrixXd& innovation_covariance,
                                double threshold) const;

    bool chiSquareOutlierTest(const Eigen::VectorXd& innovation,
                              const Eigen::MatrixXd& innovation_covariance, double threshold) const;

    // Health monitoring
    void updateSensorHealth(SensorID sensor_id, const SensorMeasurement& measurement);
    void computeSensorHealthMetrics();

    // Configuration
    FusionConfig config_;
    std::map<SensorID, Eigen::MatrixXd> sensor_noise_models_;
    std::map<SensorID, bool> sensor_enabled_;
    std::map<SensorID, double> sensor_health_;

    // State estimation
    EngineState current_state_;
    Eigen::MatrixXd state_covariance_;
    std::vector<EngineState> state_history_;
    std::chrono::steady_clock::time_point last_update_time_;

    // Measurement processing
    std::vector<SensorMeasurement> measurement_buffer_;
    std::map<SensorID, SensorMeasurement> latest_measurements_;
    std::map<SensorID, std::chrono::steady_clock::time_point> last_measurement_time_;

    // Filter-specific state
    // EKF state
    Eigen::MatrixXd process_jacobian_;
    Eigen::MatrixXd measurement_jacobian_;

    // UKF state
    std::vector<Eigen::VectorXd> sigma_points_;
    std::vector<double> sigma_weights_mean_;
    std::vector<double> sigma_weights_covariance_;

    // Particle filter state
    std::vector<Eigen::VectorXd> particles_;
    std::vector<double> particle_weights_;

    // Threading
    std::atomic<bool> running_;
    std::thread fusion_thread_;
    std::mutex state_mutex_;
    std::mutex measurement_mutex_;
    std::mutex config_mutex_;

    // Timing
    std::chrono::milliseconds fusion_period_{20};  // 50 Hz fusion rate
};

/**
 * @brief Sensor Data Validator
 *
 * Validates sensor data before fusion using multiple criteria
 */
class SensorValidator {
public:
    struct ValidationConfig {
        double min_value;
        double max_value;
        double max_rate_of_change;
        double max_acceleration;
        double min_quality_threshold;
        std::chrono::milliseconds max_age;
        bool enable_range_checking;
        bool enable_rate_limiting;
        bool enable_quality_filtering;
    };

    SensorValidator();
    ~SensorValidator();

    bool initialize(const std::map<SensorFusion::SensorID, ValidationConfig>& configs);
    bool validateMeasurement(const SensorFusion::SensorMeasurement& measurement) const;
    SensorFusion::SensorMeasurement correctMeasurement(
        const SensorFusion::SensorMeasurement& measurement) const;

    bool updateValidationConfig(SensorFusion::SensorID sensor_id, const ValidationConfig& config);
    ValidationConfig getValidationConfig(SensorFusion::SensorID sensor_id) const;

private:
    bool rangeCheck(const SensorFusion::SensorMeasurement& measurement) const;
    bool rateLimitCheck(const SensorFusion::SensorMeasurement& measurement) const;
    bool qualityCheck(const SensorFusion::SensorMeasurement& measurement) const;
    bool ageCheck(const SensorFusion::SensorMeasurement& measurement) const;

    std::map<SensorFusion::SensorID, ValidationConfig> validation_configs_;
    std::map<SensorFusion::SensorID, SensorFusion::SensorMeasurement> previous_measurements_;
    mutable std::mutex config_mutex_;
    mutable std::mutex history_mutex_;
};

#endif  // SENSOR_FUSION_HPP
