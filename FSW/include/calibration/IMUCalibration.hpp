#ifndef IMU_CALIBRATION_HPP
#define IMU_CALIBRATION_HPP

#include <Eigen/Dense>
#include <array>
#include <chrono>
#include <memory>
#include <mutex>
#include <vector>

namespace fsw {
namespace calibration {

/**
 * @brief IMU Sensor Calibration System
 *
 * Calibrates accelerometers, gyroscopes, and magnetometers using:
 * - Bias estimation
 * - Scale factor estimation
 * - Misalignment correction
 * - Temperature compensation
 */
class IMUCalibration {
public:
    /**
     * @brief Sensor type
     */
    enum class SensorType { ACCELEROMETER, GYROSCOPE, MAGNETOMETER };

    /**
     * @brief Calibration status
     */
    enum class CalibrationStatus {
        NOT_CALIBRATED,
        CALIBRATING,
        CALIBRATED,
        DRIFT_DETECTED,
        RECALIBRATION_REQUIRED,
        FAILED
    };

    /**
     * @brief Calibration parameters
     */
    struct CalibrationParams {
        Eigen::Vector3d bias;                 // Bias vector [sensor units]
        Eigen::Matrix3d scale_matrix;         // Scale factor matrix (includes misalignment)
        Eigen::Matrix3d misalignment;         // Misalignment matrix
        double temperature_coeff = 0.0;       // Temperature coefficient
        double reference_temperature = 25.0;  // Reference temperature [°C]

        // Quality metrics
        double bias_uncertainty;     // Bias uncertainty
        double scale_uncertainty;    // Scale uncertainty
        double calibration_quality;  // Overall quality (0-1)
    };

    /**
     * @brief Raw sensor reading
     */
    struct RawReading {
        Eigen::Vector3d value;  // Raw sensor reading
        double temperature;     // Temperature [°C]
        std::chrono::steady_clock::time_point timestamp;
    };

    /**
     * @brief Calibrated reading
     */
    struct CalibratedReading {
        Eigen::Vector3d value;       // Calibrated reading
        Eigen::Matrix3d covariance;  // Uncertainty covariance
        bool valid;                  // Validity flag
    };

    /**
     * @brief Calibration data point
     */
    struct CalibrationPoint {
        RawReading raw;
        Eigen::Vector3d reference;     // Reference/true value
        double reference_uncertainty;  // Reference uncertainty
    };

    IMUCalibration(SensorType type);
    ~IMUCalibration();

    /**
     * @brief Initialize calibration
     * @param initial_params Initial calibration parameters (optional)
     */
    void initialize(const CalibrationParams& initial_params = CalibrationParams{});

    /**
     * @brief Add calibration data point
     * @param point Calibration data point
     */
    void addCalibrationPoint(const CalibrationPoint& point);

    /**
     * @brief Perform calibration
     * @return true if successful
     */
    bool calibrate();

    /**
     * @brief Calibrate accelerometer using static positions
     *
     * Requires measurements at multiple orientations (typically 6+ positions)
     * where gravity is the only acceleration.
     */
    bool calibrateAccelerometer(const std::vector<RawReading>& readings);

    /**
     * @brief Calibrate gyroscope using rotation rates
     *
     * Requires measurements during known rotations or zero-velocity periods.
     */
    bool calibrateGyroscope(const std::vector<RawReading>& readings,
                            const std::vector<double>& reference_rates = {});

    /**
     * @brief Calibrate magnetometer using known field
     *
     * Requires measurements at multiple orientations in known magnetic field.
     */
    bool calibrateMagnetometer(const std::vector<RawReading>& readings,
                               const Eigen::Vector3d& reference_field);

    /**
     * @brief Apply calibration to raw reading
     * @param raw Raw sensor reading
     * @return Calibrated reading
     */
    CalibratedReading calibrateReading(const RawReading& raw) const;

    /**
     * @brief Get calibration parameters
     */
    CalibrationParams getCalibrationParams() const;

    /**
     * @brief Get calibration status
     */
    CalibrationStatus getStatus() const;

    /**
     * @brief Check if calibration is valid
     */
    bool isValid() const;

    /**
     * @brief Reset calibration
     */
    void reset();

private:
    // Calibration algorithms
    void estimateBias(const std::vector<RawReading>& readings);
    void estimateScaleAndMisalignment(const std::vector<CalibrationPoint>& points);
    void estimateTemperatureCoeff(const std::vector<RawReading>& readings,
                                  const std::vector<double>& temperatures);

    // Accelerometer-specific calibration
    bool calibrateAccelStatic(const std::vector<RawReading>& readings);

    // Gyroscope-specific calibration
    bool calibrateGyroZeroVelocity(const std::vector<RawReading>& readings);
    bool calibrateGyroRotation(const std::vector<RawReading>& readings,
                               const std::vector<double>& reference_rates);

    // Magnetometer-specific calibration
    bool calibrateMagEllipsoidFit(const std::vector<RawReading>& readings);

    // Quality assessment
    double computeCalibrationQuality() const;
    bool detectDrift(const RawReading& reading) const;

    SensorType sensor_type_;
    CalibrationStatus status_;
    CalibrationParams params_;
    std::vector<CalibrationPoint> calibration_data_;
    mutable std::mutex mutex_;

    // Statistics for drift detection
    std::vector<RawReading> recent_readings_;
    static constexpr size_t MAX_RECENT_READINGS = 100;
};

/**
 * @brief Complete IMU Calibration System
 *
 * Manages calibration for all three IMU sensors.
 */
class IMUCalibrationSystem {
public:
    IMUCalibrationSystem();
    ~IMUCalibrationSystem();

    /**
     * @brief Get calibrator for specific sensor
     */
    std::shared_ptr<IMUCalibration> getCalibrator(SensorType type);

    /**
     * @brief Calibrate all sensors
     * @param accel_readings Accelerometer readings
     * @param gyro_readings Gyroscope readings
     * @param mag_readings Magnetometer readings
     * @return true if all calibrations successful
     */
    bool calibrateAll(const std::vector<IMUCalibration::RawReading>& accel_readings,
                      const std::vector<IMUCalibration::RawReading>& gyro_readings,
                      const std::vector<IMUCalibration::RawReading>& mag_readings,
                      const Eigen::Vector3d& reference_magnetic_field);

    /**
     * @brief Apply calibration to IMU reading
     */
    struct CalibratedIMU {
        IMUCalibration::CalibratedReading accelerometer;
        IMUCalibration::CalibratedReading gyroscope;
        IMUCalibration::CalibratedReading magnetometer;
    };
    CalibratedIMU calibrateIMU(const IMUCalibration::RawReading& accel,
                               const IMUCalibration::RawReading& gyro,
                               const IMUCalibration::RawReading& mag) const;

    /**
     * @brief Get calibration status for all sensors
     */
    struct CalibrationStatus {
        IMUCalibration::CalibrationStatus accel;
        IMUCalibration::CalibrationStatus gyro;
        IMUCalibration::CalibrationStatus mag;
    };
    CalibrationStatus getStatus() const;

private:
    std::shared_ptr<IMUCalibration> accel_calibrator_;
    std::shared_ptr<IMUCalibration> gyro_calibrator_;
    std::shared_ptr<IMUCalibration> mag_calibrator_;
    mutable std::mutex mutex_;
};

}  // namespace calibration
}  // namespace fsw

#endif  // IMU_CALIBRATION_HPP



