#ifndef SENSOR_CALIBRATION_HPP
#define SENSOR_CALIBRATION_HPP

#include <Eigen/Dense>
#include <array>
#include <chrono>
#include <map>
#include <memory>
#include <string>
#include <vector>

/**
 * @brief Comprehensive Sensor Calibration System
 *
 * Implements the Bayesian calibration framework from the mathematical model
 * for all sensors: PT, RTD, TC, IMU, GPS, encoders
 */
class SensorCalibration {
public:
    enum class SensorType {
        PRESSURE_TRANSDUCER,
        RTD_TEMPERATURE,
        THERMOCOUPLE,
        IMU_ACCELEROMETER,
        IMU_GYROSCOPE,
        GPS_POSITION,
        GPS_VELOCITY,
        ENCODER_POSITION,
        ENCODER_VELOCITY
    };

    enum class CalibrationStatus {
        NOT_CALIBRATED,
        CALIBRATING,
        CALIBRATED,
        DRIFT_DETECTED,
        RECALIBRATION_REQUIRED,
        FAILED
    };

    struct CalibrationData {
        std::vector<double> input_values;                       // Raw sensor readings
        std::vector<double> reference_values;                   // Reference/true values
        std::vector<double> timestamps;                         // Timestamps
        std::vector<Eigen::VectorXd> environmental_conditions;  // Environmental state
        double reference_uncertainty;                           // Reference measurement uncertainty
        std::string calibration_notes;
        std::chrono::system_clock::time_point calibration_time;
    };

    struct CalibrationParameters {
        Eigen::VectorXd theta;             // Calibration parameters
        Eigen::MatrixXd sigma_theta;       // Parameter covariance
        Eigen::MatrixXd Q_env;             // Environmental variance matrix
        Eigen::MatrixXd Q_interaction;     // Interaction variance matrix
        std::vector<double> alpha_params;  // Nonlinear variance parameters
        double base_variance;              // Base measurement variance
        double extrapolation_confidence;   // Extrapolation confidence factor
        bool gain_scheduling_enabled;
    };

    struct CalibrationMetrics {
        double nrmse;                     // Normalized RMSE
        double coverage_95;               // 95% confidence interval coverage
        double extrapolation_confidence;  // Extrapolation confidence
        double condition_number;          // Matrix condition number
        int num_calibration_points;
        std::vector<double> residual_analysis;  // Residual analysis
        std::string quality_assessment;
    };

    SensorCalibration();
    ~SensorCalibration();

    // Main calibration interface
    bool calibrateSensor(SensorType sensor_type, const std::string& sensor_id,
                         const CalibrationData& data);

    bool updateCalibration(SensorType sensor_type, const std::string& sensor_id,
                           const std::vector<std::pair<double, double>>& new_data);

    // Calibration status and retrieval
    CalibrationStatus getCalibrationStatus(SensorType sensor_type,
                                           const std::string& sensor_id) const;

    CalibrationParameters getCalibrationParameters(SensorType sensor_type,
                                                   const std::string& sensor_id) const;

    CalibrationMetrics getCalibrationMetrics(SensorType sensor_type,
                                             const std::string& sensor_id) const;

    // Real-time calibration validation
    bool validateCalibration(SensorType sensor_type, const std::string& sensor_id, double raw_value,
                             const Eigen::VectorXd& environmental_state, double& calibrated_value,
                             double& uncertainty) const;

    // Change detection (GLR test)
    bool detectCalibrationDrift(SensorType sensor_type, const std::string& sensor_id,
                                const std::vector<double>& recent_data,
                                double threshold = 0.95) const;

    // Calibration workflow management
    bool startCalibrationSequence(SensorType sensor_type, const std::string& sensor_id);
    bool completeCalibrationSequence(SensorType sensor_type, const std::string& sensor_id);
    bool abortCalibrationSequence(SensorType sensor_type, const std::string& sensor_id);

    // Configuration management
    bool saveCalibrationToFile(const std::string& filename) const;
    bool loadCalibrationFromFile(const std::string& filename);

    // Sensor-specific calibration procedures
    bool calibratePressureTransducer(const std::string& sensor_id,
                                     const std::vector<double>& voltages,
                                     const std::vector<double>& reference_pressures,
                                     const std::vector<Eigen::VectorXd>& environmental_conditions);

    bool calibrateRTD(const std::string& sensor_id, const std::vector<double>& resistances,
                      const std::vector<double>& reference_temperatures,
                      const std::vector<Eigen::VectorXd>& environmental_conditions);

    bool calibrateThermocouple(const std::string& sensor_id, const std::vector<double>& voltages,
                               const std::vector<double>& reference_temperatures,
                               const std::vector<Eigen::VectorXd>& environmental_conditions);

    bool calibrateIMU(const std::string& sensor_id,
                      const std::vector<Eigen::Vector3d>& accel_readings,
                      const std::vector<Eigen::Vector3d>& gyro_readings,
                      const std::vector<Eigen::Vector3d>& reference_orientations,
                      const std::vector<Eigen::Vector3d>& reference_angular_velocities);

    bool calibrateGPS(const std::string& sensor_id,
                      const std::vector<Eigen::Vector3d>& gps_positions,
                      const std::vector<Eigen::Vector3d>& reference_positions,
                      const std::vector<double>& reference_accuracies);

    bool calibrateEncoder(const std::string& sensor_id, const std::vector<double>& encoder_counts,
                          const std::vector<double>& reference_positions,
                          const std::vector<double>& reference_velocities);

private:
    // Bayesian calibration algorithms
    bool performBayesianCalibration(SensorType sensor_type, const std::string& sensor_id,
                                    const CalibrationData& data, CalibrationParameters& params);

    // Total Least Squares implementation
    bool solveTotalLeastSquares(const Eigen::MatrixXd& A, const Eigen::VectorXd& b,
                                const Eigen::VectorXd& weights, Eigen::VectorXd& solution,
                                Eigen::MatrixXd& covariance);

    // Environmental variance modeling
    double computeEnvironmentalVariance(const Eigen::VectorXd& env_state,
                                        const CalibrationParameters& params) const;

    // GLR test implementation
    double computeGLRTest(const std::vector<double>& data,
                          const CalibrationParameters& params) const;

    // Extrapolation confidence
    double computeExtrapolationConfidence(double input_value,
                                          const CalibrationParameters& params) const;

    // Sensor-specific calibration functions
    Eigen::VectorXd pressureTransducerModel(const Eigen::VectorXd& input,
                                            const Eigen::VectorXd& params,
                                            const Eigen::VectorXd& env_state) const;

    Eigen::VectorXd rtdModel(const Eigen::VectorXd& input, const Eigen::VectorXd& params,
                             const Eigen::VectorXd& env_state) const;

    Eigen::VectorXd thermocoupleModel(const Eigen::VectorXd& input, const Eigen::VectorXd& params,
                                      const Eigen::VectorXd& env_state) const;

    Eigen::VectorXd imuModel(const Eigen::VectorXd& input, const Eigen::VectorXd& params,
                             const Eigen::VectorXd& env_state) const;

    // Calibration storage
    std::map<std::pair<SensorType, std::string>, CalibrationParameters> calibrations_;
    std::map<std::pair<SensorType, std::string>, CalibrationStatus> calibration_status_;
    std::map<std::pair<SensorType, std::string>, CalibrationMetrics> calibration_metrics_;

    // Configuration
    std::string calibration_file_path_;
    bool auto_save_enabled_;
    double glr_threshold_;

    // Population-level calibration parameters (for transfer learning)
    std::map<SensorType, CalibrationParameters> population_priors_;
};

/**
 * @brief Automated Calibration Sequence Manager
 */
class CalibrationSequenceManager {
public:
    struct CalibrationStep {
        std::string name;
        SensorCalibration::SensorType sensor_type;
        std::string sensor_id;
        std::function<bool()> calibration_function;
        std::vector<std::string> dependencies;
        double timeout_seconds;
        bool critical;
    };

    CalibrationSequenceManager();
    ~CalibrationSequenceManager();

    bool addCalibrationStep(const CalibrationStep& step);
    bool runCalibrationSequence(const std::vector<std::string>& step_names);
    bool runFullCalibrationSequence();

    std::vector<std::string> getCompletedSteps() const;
    std::vector<std::string> getFailedSteps() const;
    std::vector<std::string> getRemainingSteps() const;

    bool isSequenceRunning() const;
    bool abortSequence();

private:
    std::vector<CalibrationStep> calibration_steps_;
    std::vector<std::string> completed_steps_;
    std::vector<std::string> failed_steps_;
    std::atomic<bool> sequence_running_;
    std::thread sequence_thread_;
    std::mutex sequence_mutex_;
};

#endif  // SENSOR_CALIBRATION_HPP
