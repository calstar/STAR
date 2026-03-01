#ifndef ENCODER_CALIBRATION_HPP
#define ENCODER_CALIBRATION_HPP

#include <Eigen/Dense>
#include <atomic>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

/**
 * @brief Encoder Calibration System
 *
 * Handles calibration of rotary encoders for valve position control.
 * Maps encoder counts to actual valve positions with uncertainty quantification.
 */
class EncoderCalibration {
public:
    enum class EncoderType {
        INCREMENTAL,  // Incremental encoder (A/B quadrature)
        ABSOLUTE,     // Absolute encoder (SSI, EnDat, etc.)
        MAGNETIC,     // Magnetic encoder
        OPTICAL,      // Optical encoder
        HALL_EFFECT   // Hall effect encoder
    };

    enum class CalibrationMethod {
        LINEAR_INTERPOLATION,
        POLYNOMIAL_FIT,
        SPLINE_INTERPOLATION,
        BAYESIAN_REGRESSION,
        NEURAL_NETWORK
    };

    struct EncoderConfig {
        EncoderType type;
        uint32_t resolution;           // Counts per revolution
        double gear_ratio;             // Gear reduction ratio
        bool direction_inverted;       // Encoder direction
        double dead_band_min;          // Dead band minimum (counts)
        double dead_band_max;          // Dead band maximum (counts)
        double backlash;               // Backlash compensation (counts)
        std::string calibration_file;  // Calibration file path
    };

    struct CalibrationData {
        std::vector<double> encoder_counts;                     // Raw encoder counts
        std::vector<double> reference_positions;                // Reference positions (0.0 to 1.0)
        std::vector<double> timestamps;                         // Timestamps
        std::vector<double> velocities;                         // Reference velocities
        std::vector<Eigen::VectorXd> environmental_conditions;  // Environmental state
        double reference_uncertainty;                           // Reference measurement uncertainty
        std::string calibration_notes;
        std::chrono::system_clock::time_point calibration_time;
    };

    struct CalibrationParameters {
        // Linear mapping parameters
        double offset;                // Zero position offset (counts)
        double scale_factor;          // Scale factor (counts/revolution)
        double linearity_correction;  // Linearity correction factor

        // Nonlinear correction parameters
        std::vector<double> polynomial_coeffs;  // Polynomial coefficients
        std::vector<double> spline_knots;       // Spline knots
        std::vector<double> spline_coeffs;      // Spline coefficients

        // Uncertainty parameters
        Eigen::VectorXd parameter_covariance;  // Parameter uncertainty
        double measurement_noise_variance;     // Measurement noise
        double process_noise_variance;         // Process noise

        // Calibration quality metrics
        double calibration_quality;   // Overall quality (0-1)
        double repeatability;         // Repeatability (counts)
        double accuracy;              // Accuracy (counts)
        double resolution_effective;  // Effective resolution
    };

    struct PositionEstimate {
        double position;     // Estimated position (0.0 to 1.0)
        double velocity;     // Estimated velocity (1/s)
        double uncertainty;  // Position uncertainty
        double quality;      // Estimate quality (0-1)
        std::chrono::steady_clock::time_point timestamp;
    };

    EncoderCalibration();
    ~EncoderCalibration();

    // Main interface
    bool initialize(const EncoderConfig& config);
    bool calibrate(const CalibrationData& data,
                   CalibrationMethod method = CalibrationMethod::POLYNOMIAL_FIT);

    // Position estimation
    PositionEstimate estimatePosition(double encoder_count, double velocity = 0.0) const;
    PositionEstimate estimatePositionWithUncertainty(
        double encoder_count, const Eigen::VectorXd& environmental_state) const;

    // Velocity estimation
    double estimateVelocity(double encoder_count, double dt) const;
    double estimateVelocityWithFiltering(double encoder_count, double dt);

    // Calibration management
    bool saveCalibration(const std::string& filename) const;
    bool loadCalibration(const std::string& filename);

    // Configuration
    EncoderConfig getConfig() const;
    CalibrationParameters getCalibrationParameters() const;
    bool updateConfig(const EncoderConfig& config);

    // Validation and testing
    bool validateCalibration() const;
    std::vector<double> generateCalibrationTestPoints() const;
    double evaluateCalibrationAccuracy(const std::vector<double>& test_counts,
                                       const std::vector<double>& reference_positions) const;

private:
    // Calibration algorithms
    bool performLinearCalibration(const CalibrationData& data);
    bool performPolynomialCalibration(const CalibrationData& data);
    bool performSplineCalibration(const CalibrationData& data);
    bool performBayesianCalibration(const CalibrationData& data);
    bool performNeuralNetworkCalibration(const CalibrationData& data);

    // Position mapping functions
    double mapCountsToPosition(double counts) const;
    double mapPositionToCounts(double position) const;

    // Nonlinear correction
    double applyNonlinearCorrection(double position) const;
    double applyDeadBandCorrection(double position) const;
    double applyBacklashCorrection(double position, double velocity) const;

    // Uncertainty propagation
    double propagateUncertainty(double encoder_count) const;
    Eigen::VectorXd computePositionJacobian(double encoder_count) const;

    // Quality assessment
    double assessCalibrationQuality(const CalibrationData& data) const;
    double computeRepeatability(const CalibrationData& data) const;
    double computeAccuracy(const CalibrationData& data) const;

    // Configuration
    EncoderConfig config_;
    CalibrationParameters calibration_params_;

    // State variables
    std::atomic<bool> calibrated_;
    double last_encoder_count_;
    double last_position_estimate_;
    std::chrono::steady_clock::time_point last_update_time_;

    // Velocity filtering
    std::vector<double> velocity_history_;
    double velocity_filter_alpha_;

    // Threading
    std::mutex config_mutex_;
    std::mutex calibration_mutex_;
};

/**
 * @brief Multi-Encoder Calibration Manager
 *
 * Manages calibration for multiple encoders (e.g., fuel valve, ox valve, gimbal)
 */
class MultiEncoderCalibrationManager {
public:
    struct EncoderInfo {
        std::string encoder_id;
        EncoderCalibration::EncoderType type;
        std::string description;
        bool calibrated;
        double last_calibration_time;
        double calibration_quality;
    };

    MultiEncoderCalibrationManager();
    ~MultiEncoderCalibrationManager();

    bool initialize();

    // Encoder management
    bool addEncoder(const std::string& encoder_id, const EncoderCalibration::EncoderConfig& config);
    bool removeEncoder(const std::string& encoder_id);
    bool calibrateEncoder(const std::string& encoder_id,
                          const EncoderCalibration::CalibrationData& data);

    // Position estimation for multiple encoders
    std::map<std::string, EncoderCalibration::PositionEstimate> estimateAllPositions(
        const std::map<std::string, double>& encoder_counts) const;

    // Calibration status
    std::vector<EncoderInfo> getEncoderStatus() const;
    bool areAllEncodersCalibrated() const;
    std::vector<std::string> getUncalibratedEncoders() const;

    // Batch operations
    bool calibrateAllEncoders();
    bool saveAllCalibrations(const std::string& directory) const;
    bool loadAllCalibrations(const std::string& directory);

    // Configuration
    bool updateEncoderConfig(const std::string& encoder_id,
                             const EncoderCalibration::EncoderConfig& config);

private:
    std::map<std::string, std::unique_ptr<EncoderCalibration>> encoders_;
    std::mutex encoders_mutex_;
};

/**
 * @brief Encoder Health Monitor
 *
 * Monitors encoder health and detects calibration drift
 */
class EncoderHealthMonitor {
public:
    struct HealthMetrics {
        double signal_quality;  // Signal quality (0-1)
        double noise_level;     // Noise level
        double drift_rate;      // Calibration drift rate
        double jitter;          // Position jitter
        bool fault_detected;    // Fault detection flag
        std::string fault_description;
        std::chrono::steady_clock::time_point last_update;
    };

    EncoderHealthMonitor();
    ~EncoderHealthMonitor();

    bool initialize();
    void updateHealthMetrics(const std::string& encoder_id, double encoder_count,
                             double reference_position);

    HealthMetrics getHealthMetrics(const std::string& encoder_id) const;
    std::map<std::string, HealthMetrics> getAllHealthMetrics() const;

    bool detectCalibrationDrift(const std::string& encoder_id) const;
    std::vector<std::string> getUnhealthyEncoders() const;

private:
    void computeSignalQuality(const std::string& encoder_id);
    void computeNoiseLevel(const std::string& encoder_id);
    void computeDriftRate(const std::string& encoder_id);
    void computeJitter(const std::string& encoder_id);

    std::map<std::string, HealthMetrics> health_metrics_;
    std::map<std::string, std::vector<double>> encoder_history_;
    std::map<std::string, std::vector<double>> position_history_;

    std::mutex metrics_mutex_;
};

#endif  // ENCODER_CALIBRATION_HPP
