#ifndef EKF_NAVIGATION_HPP
#define EKF_NAVIGATION_HPP

#include <Eigen/Dense>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <vector>

/**
 * @brief Extended Kalman Filter Navigation System
 *
 * Implements EKF-based navigation and state estimation with dynamic state
 * toggling based on engine state machine. Integrates IMU, GPS, barometer,
 * and engine sensors for comprehensive state estimation.
 */
class EKFNavigation {
public:
    enum class NavigationMode {
        INITIALIZATION,  // Initial state estimation
        INS_ONLY,        // Inertial navigation only
        GPS_AIDED,       // GPS-aided navigation
        ENGINE_AIDED,    // Engine sensor aided navigation
        MULTI_SENSOR,    // Multi-sensor fusion
        DEGRADED         // Degraded mode (limited sensors)
    };

    enum class StateVectorComponent {
        POSITION_X = 0,      // X position (m)
        POSITION_Y = 1,      // Y position (m)
        POSITION_Z = 2,      // Z position (m)
        VELOCITY_X = 3,      // X velocity (m/s)
        VELOCITY_Y = 4,      // Y velocity (m/s)
        VELOCITY_Z = 5,      // Z velocity (m/s)
        ATTITUDE_QW = 6,     // Quaternion W
        ATTITUDE_QX = 7,     // Quaternion X
        ATTITUDE_QY = 8,     // Quaternion Y
        ATTITUDE_QZ = 9,     // Quaternion Z
        BIAS_ACCEL_X = 10,   // Accelerometer bias X
        BIAS_ACCEL_Y = 11,   // Accelerometer bias Y
        BIAS_ACCEL_Z = 12,   // Accelerometer bias Z
        BIAS_GYRO_X = 13,    // Gyroscope bias X
        BIAS_GYRO_Y = 14,    // Gyroscope bias Y
        BIAS_GYRO_Z = 15,    // Gyroscope bias Z
        SCALE_ACCEL = 16,    // Accelerometer scale factor
        SCALE_GYRO = 17,     // Gyroscope scale factor
        ENGINE_THRUST = 18,  // Engine thrust (N)
        ENGINE_MASS = 19     // Vehicle mass (kg)
    };

    static constexpr size_t STATE_DIM = 20;
    static constexpr size_t MEASUREMENT_DIM = 10;

    struct NavigationState {
        Eigen::VectorXd state_vector;       // State vector (20x1)
        Eigen::MatrixXd covariance_matrix;  // Covariance matrix (20x20)
        NavigationMode mode;                // Current navigation mode
        bool valid;                         // State validity
        double quality;                     // State quality (0-1)
        std::chrono::steady_clock::time_point timestamp;
    };

    struct IMUMeasurement {
        Eigen::Vector3d accelerometer;  // Accelerometer (m/s²)
        Eigen::Vector3d gyroscope;      // Gyroscope (rad/s)
        Eigen::Vector3d magnetometer;   // Magnetometer (T)
        double temperature;             // Temperature (°C)
        std::chrono::steady_clock::time_point timestamp;
        bool valid;
        double quality;
    };

    struct GPSMeasurement {
        Eigen::Vector3d position;    // Position (m)
        Eigen::Vector3d velocity;    // Velocity (m/s)
        double horizontal_accuracy;  // Horizontal accuracy (m)
        double vertical_accuracy;    // Vertical accuracy (m)
        double speed_accuracy;       // Speed accuracy (m/s)
        uint8_t satellites_used;     // Number of satellites
        std::chrono::steady_clock::time_point timestamp;
        bool valid;
        double quality;
    };

    struct BarometerMeasurement {
        double pressure;     // Pressure (Pa)
        double altitude;     // Altitude (m)
        double temperature;  // Temperature (°C)
        std::chrono::steady_clock::time_point timestamp;
        bool valid;
        double quality;
    };

    struct EngineMeasurement {
        double thrust;            // Thrust (N)
        double mass_flow_rate;    // Mass flow rate (kg/s)
        double specific_impulse;  // Isp (s)
        double chamber_pressure;  // Chamber pressure (Pa)
        std::chrono::steady_clock::time_point timestamp;
        bool valid;
        double quality;
    };

    struct EKFConfig {
        // Process noise
        double position_process_noise;  // Position process noise (m²/s)
        double velocity_process_noise;  // Velocity process noise (m²/s³)
        double attitude_process_noise;  // Attitude process noise (rad²/s)
        double bias_process_noise;      // Bias process noise (units/s)
        double scale_process_noise;     // Scale factor process noise (1/s)
        double engine_process_noise;    // Engine process noise

        // Measurement noise
        double imu_accel_noise;     // IMU accelerometer noise (m²/s⁴)
        double imu_gyro_noise;      // IMU gyroscope noise (rad²/s²)
        double gps_position_noise;  // GPS position noise (m²)
        double gps_velocity_noise;  // GPS velocity noise (m²/s²)
        double barometer_noise;     // Barometer noise (Pa²)
        double engine_noise;        // Engine measurement noise

        // Initial uncertainties
        double initial_position_uncertainty;  // Initial position uncertainty (m)
        double initial_velocity_uncertainty;  // Initial velocity uncertainty (m/s)
        double initial_attitude_uncertainty;  // Initial attitude uncertainty (rad)
        double initial_bias_uncertainty;      // Initial bias uncertainty

        // Filter tuning
        bool enable_adaptive_filtering;  // Enable adaptive filtering
        bool enable_outlier_rejection;   // Enable outlier rejection
        double outlier_threshold;        // Outlier rejection threshold
        double innovation_threshold;     // Innovation threshold
        bool enable_robust_estimation;   // Enable robust estimation
    };

    EKFNavigation();
    ~EKFNavigation();

    // Main interface
    bool initialize(const EKFConfig& config, const NavigationState& initial_state);
    void run();
    void stop();

    // State estimation
    NavigationState getCurrentState() const;
    NavigationState predictState(double dt) const;

    // Measurement processing
    bool processIMUMeasurement(const IMUMeasurement& measurement);
    bool processGPSMeasurement(const GPSMeasurement& measurement);
    bool processBarometerMeasurement(const BarometerMeasurement& measurement);
    bool processEngineMeasurement(const EngineMeasurement& measurement);

    // State machine integration
    bool setNavigationMode(NavigationMode mode);
    NavigationMode getNavigationMode() const;
    bool updateEngineState(int engine_state);  // From state machine

    // Configuration
    EKFConfig getConfig() const;
    bool updateConfig(const EKFConfig& config);

    // Health monitoring
    bool isHealthy() const;
    double getNavigationAccuracy() const;
    std::vector<std::string> getActiveWarnings() const;

private:
    void navigationLoop();
    void predictStep(double dt);
    void updateStep();
    void handleModeTransition(NavigationMode new_mode);

    // EKF prediction
    Eigen::VectorXd computeStateTransition(const Eigen::VectorXd& state,
                                           const Eigen::VectorXd& input, double dt) const;
    Eigen::MatrixXd computeStateJacobian(const Eigen::VectorXd& state, const Eigen::VectorXd& input,
                                         double dt) const;
    Eigen::MatrixXd computeProcessNoise(double dt) const;

    // EKF update
    Eigen::VectorXd computeMeasurementModel(const Eigen::VectorXd& state) const;
    Eigen::MatrixXd computeMeasurementJacobian(const Eigen::VectorXd& state) const;
    Eigen::MatrixXd computeMeasurementNoise() const;

    // State vector utilities
    Eigen::Vector3d getPosition(const Eigen::VectorXd& state) const;
    Eigen::Vector3d getVelocity(const Eigen::VectorXd& state) const;
    Eigen::Quaterniond getAttitude(const Eigen::VectorXd& state) const;
    Eigen::Vector3d getAccelBias(const Eigen::VectorXd& state) const;
    Eigen::Vector3d getGyroBias(const Eigen::VectorXd& state) const;

    void setPosition(Eigen::VectorXd& state, const Eigen::Vector3d& position) const;
    void setVelocity(Eigen::VectorXd& state, const Eigen::Vector3d& velocity) const;
    void setAttitude(Eigen::VectorXd& state, const Eigen::Quaterniond& attitude) const;

    // Measurement processing
    bool validateMeasurement(const Eigen::VectorXd& innovation,
                             const Eigen::MatrixXd& innovation_covariance) const;
    bool detectOutlier(const Eigen::VectorXd& innovation,
                       const Eigen::MatrixXd& innovation_covariance) const;

    // Mode-specific processing
    void processINSOnlyMode();
    void processGPSAidedMode();
    void processEngineAidedMode();
    void processMultiSensorMode();

    // Engine state integration
    void updateEngineModel(int engine_state);
    double computeThrustAcceleration(const Eigen::VectorXd& state) const;
    double computeMassDerivative(const Eigen::VectorXd& state) const;

    // Configuration
    EKFConfig config_;
    NavigationState current_state_;
    NavigationMode current_mode_;

    // Measurement buffers
    std::vector<IMUMeasurement> imu_measurements_;
    std::vector<GPSMeasurement> gps_measurements_;
    std::vector<BarometerMeasurement> barometer_measurements_;
    std::vector<EngineMeasurement> engine_measurements_;

    // Engine state integration
    std::atomic<int> engine_state_;
    double engine_thrust_;
    double engine_mass_flow_;
    bool engine_active_;

    // Filter state
    std::atomic<bool> initialized_;
    std::atomic<bool> healthy_;
    double navigation_accuracy_;
    std::vector<std::string> active_warnings_;

    // Threading
    std::atomic<bool> running_;
    std::thread navigation_thread_;
    std::mutex state_mutex_;
    std::mutex measurements_mutex_;
    std::mutex config_mutex_;

    // Timing
    std::chrono::milliseconds navigation_period_{20};  // 50 Hz navigation
    std::chrono::steady_clock::time_point last_update_time_;
};

/**
 * @brief Navigation State Machine Integration
 *
 * Integrates navigation system with engine state machine for dynamic mode switching
 */
class NavigationStateIntegration {
public:
    enum class EngineState {
        PRE_IGNITION = 0,
        IGNITION = 1,
        STARTUP = 2,
        STEADY_STATE = 3,
        SHUTDOWN = 4,
        ABORT = 5,
        MAINTENANCE = 6
    };

    struct StateTransition {
        EngineState from_state;
        EngineState to_state;
        EKFNavigation::NavigationMode navigation_mode;
        double transition_time;
        bool requires_reinitialization;
    };

    NavigationStateIntegration();
    ~NavigationStateIntegration();

    bool initialize(std::shared_ptr<EKFNavigation> navigation_system);
    bool updateEngineState(EngineState engine_state);
    EKFNavigation::NavigationMode getNavigationModeForEngineState(EngineState engine_state) const;

    // State transition management
    bool addStateTransition(const StateTransition& transition);
    bool removeStateTransition(EngineState from_state, EngineState to_state);

    // Configuration
    std::vector<StateTransition> getStateTransitions() const;
    bool updateStateTransitions(const std::vector<StateTransition>& transitions);

private:
    void handleStateTransition(EngineState from_state, EngineState to_state);
    EKFNavigation::NavigationMode determineNavigationMode(EngineState engine_state) const;

    std::shared_ptr<EKFNavigation> navigation_system_;
    std::atomic<EngineState> current_engine_state_;
    std::vector<StateTransition> state_transitions_;

    std::mutex transitions_mutex_;
};

#endif  // EKF_NAVIGATION_HPP
