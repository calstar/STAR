#include "../include/calibration/IMUCalibration.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>

namespace fsw {
namespace calibration {

IMUCalibration::IMUCalibration(SensorType type)
    : sensor_type_(type), status_(CalibrationStatus::NOT_CALIBRATED) {
    params_ = CalibrationParams{};
    params_.scale_matrix = Eigen::Matrix3d::Identity();
    params_.misalignment = Eigen::Matrix3d::Identity();
}

IMUCalibration::~IMUCalibration() = default;

void IMUCalibration::initialize(const CalibrationParams& initial_params) {
    std::lock_guard<std::mutex> lock(mutex_);
    params_ = initial_params;
    status_ = CalibrationStatus::NOT_CALIBRATED;
    calibration_data_.clear();
    recent_readings_.clear();
}

void IMUCalibration::addCalibrationPoint(const CalibrationPoint& point) {
    std::lock_guard<std::mutex> lock(mutex_);
    calibration_data_.push_back(point);
}

bool IMUCalibration::calibrate() {
    std::lock_guard<std::mutex> lock(mutex_);

    if (calibration_data_.empty()) {
        status_ = CalibrationStatus::FAILED;
        return false;
    }

    status_ = CalibrationStatus::CALIBRATING;

    // Extract raw readings
    std::vector<RawReading> readings;
    for (const auto& point : calibration_data_) {
        readings.push_back(point.raw);
    }

    // Perform calibration based on sensor type
    bool success = false;
    switch (sensor_type_) {
        case SensorType::ACCELEROMETER:
            success = calibrateAccelerometer(readings);
            break;
        case SensorType::GYROSCOPE:
            success = calibrateGyroscope(readings);
            break;
        case SensorType::MAGNETOMETER:
            // For magnetometer, need reference field
            if (calibration_data_.size() > 0) {
                Eigen::Vector3d ref_field = calibration_data_[0].reference;
                success = calibrateMagnetometer(readings, ref_field);
            }
            break;
    }

    if (success) {
        params_.calibration_quality = computeCalibrationQuality();
        status_ = CalibrationStatus::CALIBRATED;
    } else {
        status_ = CalibrationStatus::FAILED;
    }

    return success;
}

bool IMUCalibration::calibrateAccelerometer(const std::vector<RawReading>& readings) {
    if (readings.size() < 6) {
        std::cerr << "[IMUCalibration] Need at least 6 positions for accelerometer calibration"
                  << std::endl;
        return false;
    }

    // Estimate bias as mean of readings (assuming gravity cancels out)
    estimateBias(readings);

    // For accelerometer, use static calibration
    return calibrateAccelStatic(readings);
}

bool IMUCalibration::calibrateGyroscope(const std::vector<RawReading>& readings,
                                        const std::vector<double>& reference_rates) {
    if (readings.empty()) {
        return false;
    }

    // Estimate bias from zero-velocity periods or known rotations
    if (reference_rates.empty()) {
        // Zero-velocity calibration
        return calibrateGyroZeroVelocity(readings);
    } else {
        // Rotation-based calibration
        return calibrateGyroRotation(readings, reference_rates);
    }
}

bool IMUCalibration::calibrateMagnetometer(const std::vector<RawReading>& readings,
                                           const Eigen::Vector3d& reference_field) {
    if (readings.size() < 6) {
        std::cerr << "[IMUCalibration] Need at least 6 orientations for magnetometer calibration"
                  << std::endl;
        return false;
    }

    // Use ellipsoid fitting for magnetometer
    return calibrateMagEllipsoidFit(readings);
}

CalibratedReading IMUCalibration::calibrateReading(const RawReading& raw) const {
    std::lock_guard<std::mutex> lock(mutex_);

    CalibratedReading calibrated;

    if (status_ != CalibrationStatus::CALIBRATED) {
        calibrated.valid = false;
        return calibrated;
    }

    // Apply temperature compensation
    double temp_scale = 1.0;
    if (std::abs(params_.temperature_coeff) > 1e-6) {
        double temp_diff = raw.temperature - params_.reference_temperature;
        temp_scale = 1.0 + params_.temperature_coeff * temp_diff;
    }

    // Apply calibration: calibrated = scale_matrix * (raw - bias) * temp_scale
    Eigen::Vector3d corrected = raw.value - params_.bias;
    corrected *= temp_scale;
    calibrated.value = params_.scale_matrix * corrected;

    // Compute uncertainty (simplified)
    calibrated.covariance =
        Eigen::Matrix3d::Identity() * (params_.bias_uncertainty * params_.bias_uncertainty +
                                       params_.scale_uncertainty * params_.scale_uncertainty);

    calibrated.valid = true;
    return calibrated;
}

IMUCalibration::CalibrationParams IMUCalibration::getCalibrationParams() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return params_;
}

CalibrationStatus IMUCalibration::getStatus() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
}

bool IMUCalibration::isValid() const {
    return getStatus() == CalibrationStatus::CALIBRATED;
}

void IMUCalibration::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    status_ = CalibrationStatus::NOT_CALIBRATED;
    calibration_data_.clear();
    recent_readings_.clear();
    params_ = CalibrationParams{};
    params_.scale_matrix = Eigen::Matrix3d::Identity();
    params_.misalignment = Eigen::Matrix3d::Identity();
}

void IMUCalibration::estimateBias(const std::vector<RawReading>& readings) {
    if (readings.empty()) {
        return;
    }

    Eigen::Vector3d bias_sum = Eigen::Vector3d::Zero();
    for (const auto& reading : readings) {
        bias_sum += reading.value;
    }
    params_.bias = bias_sum / static_cast<double>(readings.size());
}

bool IMUCalibration::calibrateAccelStatic(const std::vector<RawReading>& readings) {
    // For accelerometer static calibration:
    // We know gravity magnitude (9.81 m/s²)
    // At each orientation, |accel| should equal gravity

    const double g = 9.81;
    std::vector<CalibrationPoint> points;

    for (const auto& reading : readings) {
        CalibrationPoint point;
        point.raw = reading;
        // Reference is gravity vector in sensor frame
        // Magnitude should be g, direction depends on orientation
        double magnitude = reading.value.norm();
        if (magnitude > 0.1) {
            point.reference = reading.value.normalized() * g;
            point.reference_uncertainty = 0.1;  // 0.1 m/s² uncertainty
            points.push_back(point);
        }
    }

    if (points.size() < 6) {
        return false;
    }

    estimateScaleAndMisalignment(points);
    return true;
}

bool IMUCalibration::calibrateGyroZeroVelocity(const std::vector<RawReading>& readings) {
    // For zero-velocity periods, gyro should read zero
    estimateBias(readings);

    // Estimate scale factors from variance
    Eigen::Vector3d variance = Eigen::Vector3d::Zero();
    for (const auto& reading : readings) {
        Eigen::Vector3d diff = reading.value - params_.bias;
        variance += diff.cwiseProduct(diff);
    }
    variance /= static_cast<double>(readings.size());

    // Scale matrix is identity with scale factors from variance
    params_.scale_matrix = Eigen::Matrix3d::Identity();
    // Scale factors inversely related to variance (higher variance = lower confidence)

    return true;
}

bool IMUCalibration::calibrateGyroRotation(const std::vector<RawReading>& readings,
                                           const std::vector<double>& reference_rates) {
    if (readings.size() != reference_rates.size()) {
        return false;
    }

    // Estimate bias and scale from known rotation rates
    estimateBias(readings);

    // Estimate scale factors
    Eigen::Vector3d scale = Eigen::Vector3d::Ones();
    for (size_t i = 0; i < readings.size(); ++i) {
        Eigen::Vector3d corrected = readings[i].value - params_.bias;
        double magnitude = corrected.norm();
        if (magnitude > 0.01 && std::abs(reference_rates[i]) > 0.01) {
            scale = scale.cwiseProduct(Eigen::Vector3d::Constant(reference_rates[i] / magnitude));
        }
    }

    params_.scale_matrix = scale.asDiagonal();
    return true;
}

bool IMUCalibration::calibrateMagEllipsoidFit(const std::vector<RawReading>& readings) {
    // Ellipsoid fitting for magnetometer calibration
    // Fit to: (x - center)^T * A * (x - center) = 1

    if (readings.size() < 6) {
        return false;
    }

    // Simple ellipsoid fit (hard iron and soft iron correction)
    // Hard iron: bias correction
    estimateBias(readings);

    // Soft iron: scale and misalignment
    // For now, use identity scale matrix
    // Full ellipsoid fitting would require solving for 9 parameters

    params_.scale_matrix = Eigen::Matrix3d::Identity();
    return true;
}

void IMUCalibration::estimateScaleAndMisalignment(const std::vector<CalibrationPoint>& points) {
    if (points.size() < 6) {
        return;
    }

    // Least squares estimation of scale matrix
    // Solve: calibrated = scale_matrix * (raw - bias)
    // Or: reference = scale_matrix * (raw - bias)

    Eigen::MatrixXd A(points.size() * 3, 9);
    Eigen::VectorXd b(points.size() * 3);

    for (size_t i = 0; i < points.size(); ++i) {
        const auto& point = points[i];
        Eigen::Vector3d corrected = point.raw.value - params_.bias;

        // Build linear system for scale matrix elements
        // For each component: ref_i = sum_j(scale_ij * corrected_j)
        for (int row = 0; row < 3; ++row) {
            int idx = i * 3 + row;
            b(idx) = point.reference(row);

            for (int col = 0; col < 3; ++col) {
                A(idx, row * 3 + col) = corrected(col);
            }
        }
    }

    // Solve least squares
    Eigen::VectorXd scale_vec = A.colPivHouseholderQr().solve(b);

    // Reshape to matrix
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            params_.scale_matrix(i, j) = scale_vec(i * 3 + j);
        }
    }
}

double IMUCalibration::computeCalibrationQuality() const {
    if (calibration_data_.empty()) {
        return 0.0;
    }

    // Compute quality based on residuals
    double total_error = 0.0;
    int count = 0;

    for (const auto& point : calibration_data_) {
        auto calibrated = calibrateReading(point.raw);
        if (calibrated.valid) {
            Eigen::Vector3d error = calibrated.value - point.reference;
            total_error += error.norm();
            count++;
        }
    }

    if (count == 0) {
        return 0.0;
    }

    double avg_error = total_error / count;
    // Quality is inverse of error (normalized)
    double quality = 1.0 / (1.0 + avg_error);
    return std::clamp(quality, 0.0, 1.0);
}

bool IMUCalibration::detectDrift(const RawReading& reading) const {
    // Simple drift detection: check if reading is far from expected
    // This is a placeholder - real implementation would use statistical tests

    if (recent_readings_.size() < 10) {
        return false;
    }

    // Compute mean and std of recent readings
    Eigen::Vector3d mean = Eigen::Vector3d::Zero();
    for (const auto& r : recent_readings_) {
        mean += r.value;
    }
    mean /= static_cast<double>(recent_readings_.size());

    Eigen::Vector3d diff = reading.value - mean;
    double distance = diff.norm();

    // Threshold based on sensor type
    double threshold = (sensor_type_ == SensorType::MAGNETOMETER) ? 0.1 : 1.0;

    return distance > threshold;
}

// IMUCalibrationSystem implementation

IMUCalibrationSystem::IMUCalibrationSystem() {
    accel_calibrator_ = std::make_shared<IMUCalibration>(IMUCalibration::SensorType::ACCELEROMETER);
    gyro_calibrator_ = std::make_shared<IMUCalibration>(IMUCalibration::SensorType::GYROSCOPE);
    mag_calibrator_ = std::make_shared<IMUCalibration>(IMUCalibration::SensorType::MAGNETOMETER);
}

IMUCalibrationSystem::~IMUCalibrationSystem() = default;

std::shared_ptr<IMUCalibration> IMUCalibrationSystem::getCalibrator(SensorType type) {
    switch (type) {
        case SensorType::ACCELEROMETER:
            return accel_calibrator_;
        case SensorType::GYROSCOPE:
            return gyro_calibrator_;
        case SensorType::MAGNETOMETER:
            return mag_calibrator_;
    }
    return nullptr;
}

bool IMUCalibrationSystem::calibrateAll(
    const std::vector<IMUCalibration::RawReading>& accel_readings,
    const std::vector<IMUCalibration::RawReading>& gyro_readings,
    const std::vector<IMUCalibration::RawReading>& mag_readings,
    const Eigen::Vector3d& reference_magnetic_field) {
    bool success = true;

    // Calibrate accelerometer
    if (!accel_readings.empty()) {
        for (const auto& reading : accel_readings) {
            IMUCalibration::CalibrationPoint point;
            point.raw = reading;
            // Reference will be computed in calibrateAccelerometer
            accel_calibrator_->addCalibrationPoint(point);
        }
        success &= accel_calibrator_->calibrate();
    }

    // Calibrate gyroscope
    if (!gyro_readings.empty()) {
        for (const auto& reading : gyro_readings) {
            IMUCalibration::CalibrationPoint point;
            point.raw = reading;
            gyro_calibrator_->addCalibrationPoint(point);
        }
        success &= gyro_calibrator_->calibrate();
    }

    // Calibrate magnetometer
    if (!mag_readings.empty()) {
        for (const auto& reading : mag_readings) {
            IMUCalibration::CalibrationPoint point;
            point.raw = reading;
            point.reference = reference_magnetic_field;
            point.reference_uncertainty = 0.001;  // 1 mT uncertainty
            mag_calibrator_->addCalibrationPoint(point);
        }
        success &= mag_calibrator_->calibrate();
    }

    return success;
}

IMUCalibrationSystem::CalibratedIMU IMUCalibrationSystem::calibrateIMU(
    const IMUCalibration::RawReading& accel, const IMUCalibration::RawReading& gyro,
    const IMUCalibration::RawReading& mag) const {
    CalibratedIMU calibrated;

    calibrated.accelerometer = accel_calibrator_->calibrateReading(accel);
    calibrated.gyroscope = gyro_calibrator_->calibrateReading(gyro);
    calibrated.magnetometer = mag_calibrator_->calibrateReading(mag);

    return calibrated;
}

IMUCalibrationSystem::CalibrationStatus IMUCalibrationSystem::getStatus() const {
    CalibrationStatus status;
    status.accel = accel_calibrator_->getStatus();
    status.gyro = gyro_calibrator_->getStatus();
    status.mag = mag_calibrator_->getStatus();
    return status;
}

}  // namespace calibration
}  // namespace fsw
