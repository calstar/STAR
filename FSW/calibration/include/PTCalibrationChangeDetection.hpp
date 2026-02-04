#ifndef PT_CALIBRATION_CHANGE_DETECTION_HPP
#define PT_CALIBRATION_CHANGE_DETECTION_HPP

#include <Eigen/Dense>
#include <chrono>
#include <deque>
#include <memory>
#include <vector>

#include "PTCalibrationFramework.hpp"

/**
 * @brief Generalized Likelihood Ratio Test for calibration change detection
 */
class GLRChangeDetector {
public:
    /**
     * @brief Constructor
     * @param window_size Size of sliding window for GLR test
     * @param false_alarm_rate Desired false alarm rate
     */
    GLRChangeDetector(size_t window_size = 50, double false_alarm_rate = 0.05);

    /**
     * @brief Destructor
     */
    ~GLRChangeDetector();

    /**
     * @brief Add new measurement
     * @param voltage Voltage measurement
     * @param pressure Pressure measurement
     * @param environment Environmental state
     * @param calibration_map Calibration map function
     * @param theta Current calibration parameters
     * @param covariance Current parameter covariance
     * @return GLR test statistic
     */
    double addMeasurement(double voltage, double pressure, const EnvironmentalState& environment,
                          std::shared_ptr<CalibrationMapFunction> calibration_map,
                          const Eigen::VectorXd& theta, const Eigen::MatrixXd& covariance);

    /**
     * @brief Check if change is detected
     * @return true if change detected, false otherwise
     */
    bool isChangeDetected() const {
        return change_detected_;
    }

    /**
     * @brief Get threshold value
     * @return GLR threshold
     */
    double getThreshold() const {
        return threshold_;
    }

    /**
     * @brief Reset detector
     */
    void reset();

    /**
     * @brief Set window size
     * @param window_size New window size
     */
    void setWindowSize(size_t window_size);

    /**
     * @brief Set false alarm rate
     * @param false_alarm_rate New false alarm rate
     */
    void setFalseAlarmRate(double false_alarm_rate);

private:
    struct Measurement {
        double voltage;
        double pressure;
        EnvironmentalState environment;
        uint64_t timestamp_ns;
    };

    size_t window_size_;
    double false_alarm_rate_;
    double threshold_;
    bool change_detected_;

    std::deque<Measurement> measurements_;

    /**
     * @brief Compute GLR test statistic
     * @return GLR statistic
     */
    double computeGLRStatistic();

    /**
     * @brief Update threshold based on false alarm rate
     */
    void updateThreshold();
};

/**
 * @brief Cumulative Sum (CUSUM) test for gradual drift detection
 */
class CUSUMChangeDetector {
public:
    /**
     * @brief Constructor
     * @param threshold CUSUM threshold
     * @param minimum_run_length Minimum run length before reset
     */
    CUSUMChangeDetector(double threshold = 5.0, size_t minimum_run_length = 10);

    /**
     * @brief Destructor
     */
    ~CUSUMChangeDetector();

    /**
     * @brief Add new measurement
     * @param voltage Voltage measurement
     * @param pressure Pressure measurement
     * @param environment Environmental state
     * @param calibration_map Calibration map function
     * @param old_theta Old calibration parameters
     * @param new_theta New calibration parameters
     * @return CUSUM statistic
     */
    double addMeasurement(double voltage, double pressure, const EnvironmentalState& environment,
                          std::shared_ptr<CalibrationMapFunction> calibration_map,
                          const Eigen::VectorXd& old_theta, const Eigen::VectorXd& new_theta);

    /**
     * @brief Check if drift is detected
     * @return true if drift detected, false otherwise
     */
    bool isDriftDetected() const {
        return drift_detected_;
    }

    /**
     * @brief Get current CUSUM value
     * @return Current CUSUM statistic
     */
    double getCurrentCUSUM() const {
        return current_cusum_;
    }

    /**
     * @brief Reset detector
     */
    void reset();

    /**
     * @brief Set threshold
     * @param threshold New threshold
     */
    void setThreshold(double threshold);

private:
    double threshold_;
    size_t minimum_run_length_;
    double current_cusum_;
    bool drift_detected_;
    size_t run_length_;

    /**
     * @brief Compute log-likelihood ratio
     * @param voltage Voltage measurement
     * @param pressure Pressure measurement
     * @param environment Environmental state
     * @param calibration_map Calibration map function
     * @param old_theta Old parameters
     * @param new_theta New parameters
     * @return Log-likelihood ratio
     */
    double computeLogLikelihoodRatio(double voltage, double pressure,
                                     const EnvironmentalState& environment,
                                     std::shared_ptr<CalibrationMapFunction> calibration_map,
                                     const Eigen::VectorXd& old_theta,
                                     const Eigen::VectorXd& new_theta);
};

/**
 * @brief Adaptive EKF for online calibration parameter tracking
 */
class PTCalibrationEKF {
public:
    /**
     * @brief Constructor
     * @param calibration_map Calibration map function
     * @param num_physical_states Number of physical states to track
     */
    PTCalibrationEKF(std::shared_ptr<CalibrationMapFunction> calibration_map,
                     int num_physical_states = 3);

    /**
     * @brief Destructor
     */
    ~PTCalibrationEKF();

    /**
     * @brief Initialize EKF state
     * @param initial_calibration Initial calibration parameters
     * @param initial_environment Initial environmental state
     * @param initial_physical_states Initial physical states
     */
    void initialize(const CalibrationParameters& initial_calibration,
                    const EnvironmentalState& initial_environment,
                    const Eigen::VectorXd& initial_physical_states);

    /**
     * @brief Predict step
     * @param dt Time step
     * @param environmental_input Environmental input (if available)
     */
    void predict(double dt, const EnvironmentalState* environmental_input = nullptr);

    /**
     * @brief Update step
     * @param voltage Voltage measurement
     * @param pressure Pressure measurement
     * @param environment Environmental state
     * @return Innovation and innovation covariance
     */
    std::pair<double, double> update(double voltage, double pressure,
                                     const EnvironmentalState& environment);

    /**
     * @brief Get current state estimate
     * @return State vector [physical_states, calibration_params, environment, residual_bias]
     */
    const Eigen::VectorXd& getStateEstimate() const {
        return state_;
    }

    /**
     * @brief Get current state covariance
     * @return State covariance matrix
     */
    const Eigen::MatrixXd& getStateCovariance() const {
        return covariance_;
    }

    /**
     * @brief Get current calibration parameters
     * @return Calibration parameters
     */
    CalibrationParameters getCalibrationParameters() const;

    /**
     * @brief Get current environmental state
     * @return Environmental state
     */
    EnvironmentalState getEnvironmentalState() const;

    /**
     * @brief Set process noise covariance
     * @param Q Process noise covariance matrix
     */
    void setProcessNoiseCovariance(const Eigen::MatrixXd& Q);

    /**
     * @brief Set measurement noise covariance
     * @param R Measurement noise variance
     */
    void setMeasurementNoiseCovariance(double R);

    /**
     * @brief Check if EKF is initialized
     * @return true if initialized, false otherwise
     */
    bool isInitialized() const {
        return initialized_;
    }

private:
    std::shared_ptr<CalibrationMapFunction> calibration_map_;
    int num_physical_states_;
    int num_calibration_params_;
    bool initialized_;

    // State vector: [physical_states, calibration_params, environment, residual_bias]
    Eigen::VectorXd state_;
    Eigen::MatrixXd covariance_;

    // Process and measurement noise
    Eigen::MatrixXd process_noise_covariance_;
    double measurement_noise_variance_;

    // State indices
    int physical_start_idx_;
    int calibration_start_idx_;
    int environment_start_idx_;
    int bias_idx_;

    /**
     * @brief Compute process model Jacobian
     * @param dt Time step
     * @return Process model Jacobian
     */
    Eigen::MatrixXd computeProcessJacobian(double dt);

    /**
     * @brief Compute measurement model Jacobian
     * @param voltage Voltage measurement
     * @param environment Environmental state
     * @return Measurement model Jacobian
     */
    Eigen::VectorXd computeMeasurementJacobian(double voltage,
                                               const EnvironmentalState& environment);

    /**
     * @brief Compute process noise covariance (environment-dependent)
     * @param environment Environmental state
     * @return Process noise covariance
     */
    Eigen::MatrixXd computeProcessNoiseCovariance(const EnvironmentalState& environment);

    /**
     * @brief Update environmental state from sensor inputs
     * @param environmental_input Environmental input
     */
    void updateEnvironmentalState(const EnvironmentalState& environmental_input);
};

/**
 * @brief Integrated change detection and adaptive calibration system
 */
class PTAdaptiveCalibrationSystem {
public:
    /**
     * @brief Constructor
     * @param calibration_map Calibration map function
     * @param glr_window_size GLR window size
     * @param glr_false_alarm_rate GLR false alarm rate
     * @param cusum_threshold CUSUM threshold
     */
    PTAdaptiveCalibrationSystem(std::shared_ptr<CalibrationMapFunction> calibration_map,
                                size_t glr_window_size = 50, double glr_false_alarm_rate = 0.05,
                                double cusum_threshold = 5.0);

    /**
     * @brief Destructor
     */
    ~PTAdaptiveCalibrationSystem();

    /**
     * @brief Initialize system
     * @param initial_calibration Initial calibration parameters
     * @param initial_environment Initial environmental state
     * @param initial_physical_states Initial physical states
     */
    void initialize(const CalibrationParameters& initial_calibration,
                    const EnvironmentalState& initial_environment,
                    const Eigen::VectorXd& initial_physical_states);

    /**
     * @brief Process new measurement
     * @param voltage Voltage measurement
     * @param pressure Pressure measurement
     * @param environment Environmental state
     * @return Prediction result with uncertainty
     */
    std::pair<double, double> processMeasurement(double voltage, double pressure,
                                                 const EnvironmentalState& environment);

    /**
     * @brief Check if recalibration is needed
     * @return true if recalibration needed, false otherwise
     */
    bool isRecalibrationNeeded() const;

    /**
     * @brief Get change detection status
     * @return Pair of (GLR_change_detected, CUSUM_drift_detected)
     */
    std::pair<bool, bool> getChangeDetectionStatus() const;

    /**
     * @brief Get current calibration quality
     * @return Calibration quality metrics
     */
    CalibrationQualityMetrics getCalibrationQuality() const;

    /**
     * @brief Reset change detectors
     */
    void resetChangeDetectors();

    /**
     * @brief Get current EKF state
     * @return EKF state and covariance
     */
    std::pair<Eigen::VectorXd, Eigen::MatrixXd> getEKFState() const;

private:
    std::shared_ptr<PTCalibrationEKF> ekf_;
    std::shared_ptr<GLRChangeDetector> glr_detector_;
    std::shared_ptr<CUSUMChangeDetector> cusum_detector_;

    CalibrationParameters last_stable_calibration_;
    bool recalibration_needed_;

    /**
     * @brief Update change detection
     * @param voltage Voltage measurement
     * @param pressure Pressure measurement
     * @param environment Environmental state
     */
    void updateChangeDetection(double voltage, double pressure,
                               const EnvironmentalState& environment);
};

#endif  // PT_CALIBRATION_CHANGE_DETECTION_HPP
