#ifndef EKF_NAVIGATION_ENHANCED_HPP
#define EKF_NAVIGATION_ENHANCED_HPP

#include "../calibration/IMUCalibration.hpp"
#include "EKFNavigation.hpp"

namespace fsw {
namespace nav {

/**
 * @brief Enhanced EKF Navigation with Magnetometer Support
 *
 * Extends EKFNavigation to properly integrate magnetometer measurements
 * for heading estimation and attitude correction.
 */
class EKFNavigationEnhanced : public EKFNavigation {
public:
    /**
     * @brief Enhanced configuration with magnetometer parameters
     */
    struct EnhancedConfig : public EKFConfig {
        // Magnetometer noise
        double magnetometer_noise = 0.01;   // Magnetometer noise (T²)
        double magnetic_declination = 0.0;  // Magnetic declination [rad]

        // Magnetometer calibration
        bool use_magnetometer = true;              // Enable magnetometer fusion
        bool use_magnetometer_for_heading = true;  // Use mag for heading
        double magnetometer_weight = 0.1;          // Weight relative to gyro

        // Heading estimation
        bool enable_heading_estimation = true;
        double heading_process_noise = 0.01;  // Heading process noise [rad²/s]
    };

    EKFNavigationEnhanced();
    ~EKFNavigationEnhanced();

    /**
     * @brief Initialize with enhanced configuration
     */
    bool initialize(const EnhancedConfig& config, const NavigationState& initial_state);

    /**
     * @brief Process magnetometer measurement with calibration
     * @param measurement Raw magnetometer reading
     * @param calibrated Calibrated magnetometer reading
     * @return true if processed successfully
     */
    bool processMagnetometerMeasurement(
        const IMUMeasurement& measurement,
        const calibration::IMUCalibration::CalibratedReading& calibrated);

    /**
     * @brief Get heading estimate (from magnetometer + gyro fusion)
     */
    double getHeading() const;

    /**
     * @brief Get magnetic field estimate
     */
    Eigen::Vector3d getMagneticField() const;

    /**
     * @brief Set IMU calibration system
     */
    void setIMUCalibration(std::shared_ptr<calibration::IMUCalibrationSystem> calib_system);

private:
    // Enhanced measurement processing
    void updateWithMagnetometer(const Eigen::Vector3d& mag_field);
    Eigen::Vector3d computeMagnetometerMeasurement(const Eigen::VectorXd& state) const;
    Eigen::MatrixXd computeMagnetometerJacobian(const Eigen::VectorXd& state) const;

    // Heading estimation
    double computeHeadingFromQuaternion(const Eigen::Quaterniond& q) const;
    double computeHeadingFromMagnetometer(const Eigen::Vector3d& mag_field,
                                          const Eigen::Quaterniond& q) const;

    EnhancedConfig enhanced_config_;
    std::shared_ptr<calibration::IMUCalibrationSystem> imu_calibration_;

    // Magnetic field state
    Eigen::Vector3d magnetic_field_;  // Estimated magnetic field [T]
    double heading_;                  // Estimated heading [rad]
    mutable std::mutex mag_mutex_;
};

}  // namespace nav
}  // namespace fsw

#endif  // EKF_NAVIGATION_ENHANCED_HPP



