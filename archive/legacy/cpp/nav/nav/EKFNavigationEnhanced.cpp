#include "../include/nav/EKFNavigationEnhanced.hpp"

#include <cmath>
#include <iostream>

namespace fsw {
namespace nav {

EKFNavigationEnhanced::EKFNavigationEnhanced() : heading_(0.0) {
    magnetic_field_ = Eigen::Vector3d::Zero();
}

EKFNavigationEnhanced::~EKFNavigationEnhanced() = default;

bool EKFNavigationEnhanced::initialize(const EnhancedConfig& config,
                                       const NavigationState& initial_state) {
    enhanced_config_ = config;

    // Convert to base config
    EKFConfig base_config = config;
    return EKFNavigation::initialize(base_config, initial_state);
}

bool EKFNavigationEnhanced::processMagnetometerMeasurement(
    const IMUMeasurement& measurement,
    const calibration::IMUCalibration::CalibratedReading& calibrated) {
    if (!enhanced_config_.use_magnetometer || !calibrated.valid) {
        return false;
    }

    std::lock_guard<std::mutex> lock(mag_mutex_);

    // Update magnetic field estimate
    magnetic_field_ = calibrated.value;

    // Update EKF with magnetometer measurement
    updateWithMagnetometer(calibrated.value);

    // Update heading estimate
    auto nav_state = getCurrentState();
    Eigen::Quaterniond q(nav_state.state_vector(6),  // qw
                         nav_state.state_vector(7),  // qx
                         nav_state.state_vector(8),  // qy
                         nav_state.state_vector(9)   // qz
    );

    if (enhanced_config_.use_magnetometer_for_heading) {
        heading_ = computeHeadingFromMagnetometer(calibrated.value, q);
    } else {
        heading_ = computeHeadingFromQuaternion(q);
    }

    return true;
}

double EKFNavigationEnhanced::getHeading() const {
    std::lock_guard<std::mutex> lock(mag_mutex_);
    return heading_;
}

Eigen::Vector3d EKFNavigationEnhanced::getMagneticField() const {
    std::lock_guard<std::mutex> lock(mag_mutex_);
    return magnetic_field_;
}

void EKFNavigationEnhanced::setIMUCalibration(
    std::shared_ptr<calibration::IMUCalibrationSystem> calib_system) {
    imu_calibration_ = calib_system;
}

void EKFNavigationEnhanced::updateWithMagnetometer(const Eigen::Vector3d& mag_field) {
    // Get current state
    auto nav_state = getCurrentState();
    Eigen::VectorXd x = nav_state.state_vector;
    Eigen::MatrixXd P = nav_state.covariance_matrix;

    // Compute measurement model
    Eigen::Vector3d h = computeMagnetometerMeasurement(x);

    // Compute measurement Jacobian
    Eigen::MatrixXd H = computeMagnetometerJacobian(x);

    // Measurement noise
    double R = enhanced_config_.magnetometer_noise;
    Eigen::MatrixXd R_matrix = Eigen::Matrix3d::Identity() * R;

    // Innovation
    Eigen::Vector3d y = mag_field - h;

    // Innovation covariance
    Eigen::MatrixXd S = H * P * H.transpose() + R_matrix;

    // Kalman gain
    Eigen::MatrixXd K = P * H.transpose() * S.inverse();

    // Update state
    x = x + K * y;

    // Update covariance
    P = (Eigen::MatrixXd::Identity(x.size(), x.size()) - K * H) * P;

    // Normalize quaternion
    Eigen::Quaterniond q(x(6), x(7), x(8), x(9));
    q.normalize();
    x(6) = q.w();
    x(7) = q.x();
    x(8) = q.y();
    x(9) = q.z();

    // Update state (would need access to internal state update method)
    // For now, this is a placeholder
}

Eigen::Vector3d EKFNavigationEnhanced::computeMagnetometerMeasurement(
    const Eigen::VectorXd& state) const {
    // Get attitude quaternion
    Eigen::Quaterniond q(state(6), state(7), state(8), state(9));

    // Magnetic field in body frame = R^T * magnetic_field_earth
    // For now, assume magnetic field points north
    Eigen::Vector3d mag_earth(1.0, 0.0, 0.0);  // North direction
    Eigen::Vector3d mag_body = q.inverse() * mag_earth;

    return mag_body;
}

Eigen::MatrixXd EKFNavigationEnhanced::computeMagnetometerJacobian(
    const Eigen::VectorXd& state) const {
    // Jacobian of magnetometer measurement with respect to state
    // Only depends on attitude quaternion

    Eigen::MatrixXd H = Eigen::MatrixXd::Zero(3, state.size());

    // Get quaternion
    Eigen::Quaterniond q(state(6), state(7), state(8), state(9));

    // Magnetic field in earth frame (north)
    Eigen::Vector3d mag_earth(1.0, 0.0, 0.0);

    // Jacobian with respect to quaternion components
    // d(R^T * mag_earth) / dq
    // This is complex - simplified version
    Eigen::Matrix3d dR_dqw, dR_dqx, dR_dqy, dR_dqz;

    // Simplified: linear approximation
    // Full implementation would compute proper quaternion derivatives
    H.block<3, 1>(0, 6) = Eigen::Vector3d::Zero();  // d/dqw
    H.block<3, 1>(0, 7) = Eigen::Vector3d::Zero();  // d/dqx
    H.block<3, 1>(0, 8) = Eigen::Vector3d::Zero();  // d/dqy
    H.block<3, 1>(0, 9) = Eigen::Vector3d::Zero();  // d/dqz

    return H;
}

double EKFNavigationEnhanced::computeHeadingFromQuaternion(const Eigen::Quaterniond& q) const {
    // Convert quaternion to Euler angles
    // Heading (yaw) = atan2(2*(qw*qz + qx*qy), 1 - 2*(qy^2 + qz^2))
    double yaw = std::atan2(2.0 * (q.w() * q.z() + q.x() * q.y()),
                            1.0 - 2.0 * (q.y() * q.y() + q.z() * q.z()));
    return yaw;
}

double EKFNavigationEnhanced::computeHeadingFromMagnetometer(const Eigen::Vector3d& mag_field,
                                                             const Eigen::Quaterniond& q) const {
    // Transform magnetometer reading to horizontal plane
    // Assuming magnetometer is in body frame
    Eigen::Vector3d mag_horizontal = mag_field;
    mag_horizontal(2) = 0.0;  // Remove vertical component
    mag_horizontal.normalize();

    // Compute heading from magnetometer
    // Heading = atan2(mag_y, mag_x) - declination
    double heading = std::atan2(mag_horizontal(1), mag_horizontal(0));
    heading -= enhanced_config_.magnetic_declination;

    return heading;
}

}  // namespace nav
}  // namespace fsw
