#include "ObservationMatrix.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>

#include "Timer.hpp"

ObservationMatrixBuilder::ObservationMatrixBuilder(const ObservationMatrixConfig& config)
    : config_(config) {
}

void ObservationMatrixBuilder::addPTSensors(
    const std::vector<std::shared_ptr<PTMessage>>& pt_messages, bool use_pressure,
    bool use_temperature) {
    for (const auto& pt_msg : pt_messages) {
        if (!pt_msg)
            continue;

        auto measurements = convertPTMessage(*pt_msg, use_pressure, use_temperature);
        for (const auto& measurement : measurements) {
            addSensorMeasurement(measurement);
        }
    }
}

void ObservationMatrixBuilder::addIMUSensors(
    const std::vector<std::shared_ptr<IMUMessage>>& imu_messages, bool use_accelerometer,
    bool use_gyroscope) {
    // Placeholder implementation
    std::cout << "IMU sensor integration not yet implemented" << std::endl;
}

void ObservationMatrixBuilder::addBarometerSensors(
    const std::vector<std::shared_ptr<BarometerMessage>>& barometer_messages) {
    // Placeholder implementation
    std::cout << "Barometer sensor integration not yet implemented" << std::endl;
}

void ObservationMatrixBuilder::addGPSSensors(
    const std::vector<std::shared_ptr<GPSPositionMessage>>& gps_position_messages,
    const std::vector<std::shared_ptr<GPSVelocityMessage>>& gps_velocity_messages) {
    // Placeholder implementation
    std::cout << "GPS sensor integration not yet implemented" << std::endl;
}

void ObservationMatrixBuilder::addSensorMeasurement(const SensorMeasurement& measurement) {
    if (measurement.valid && isMeasurementRecent(measurement.timestamp_ns)) {
        measurements_.push_back(measurement);
        measurements_by_type_[measurement.type].push_back(measurement);
    }
}

ObservationMatrixResult ObservationMatrixBuilder::buildObservationMatrix(
    size_t state_vector_size, const std::map<size_t, SensorType>& state_mapping) {
    ObservationMatrixResult result;
    result.valid = false;
    result.timestamp_ns = getCurrentTimestamp();

    try {
        // Filter and validate measurements
        filterMeasurements();

        if (measurements_.empty()) {
            result.error_message = "No valid measurements available";
            return result;
        }

        // Build measurement vector and observation matrix
        result.measurement_vector = buildMeasurementVector(state_mapping);
        result.observation_matrix = buildObservationMatrixOnly(state_vector_size, state_mapping);
        result.measurement_covariance = buildMeasurementCovariance(measurements_);

        // Extract metadata
        for (const auto& measurement : measurements_) {
            result.measurements.push_back(measurement);
            result.measurement_types.push_back(measurement.type);
            result.sensor_ids.push_back(measurement.sensor_id);
        }

        result.valid = true;

    } catch (const std::exception& e) {
        result.error_message = std::string("Error building observation matrix: ") + e.what();
    }

    return result;
}

ObservationMatrixResult ObservationMatrixBuilder::buildEngineStateObservationMatrix() {
    // Define state mapping for engine states
    // This is a simplified mapping - adjust based on your actual state vector
    std::map<size_t, SensorType> state_mapping;
    state_mapping[0] = SensorType::PT_PRESSURE;     // Chamber pressure
    state_mapping[1] = SensorType::PT_PRESSURE;     // Fuel inlet pressure
    state_mapping[2] = SensorType::PT_PRESSURE;     // Oxidizer inlet pressure
    state_mapping[3] = SensorType::PT_TEMPERATURE;  // Temperature state

    return buildObservationMatrix(4, state_mapping);  // 4-state engine model
}

ObservationMatrixResult ObservationMatrixBuilder::buildNavigationStateObservationMatrix() {
    // Define state mapping for navigation states
    std::map<size_t, SensorType> state_mapping;
    state_mapping[0] = SensorType::IMU_ACCEL;     // Position
    state_mapping[1] = SensorType::IMU_ACCEL;     // Velocity
    state_mapping[2] = SensorType::IMU_GYRO;      // Attitude
    state_mapping[3] = SensorType::GPS_POSITION;  // GPS position

    return buildObservationMatrix(4, state_mapping);  // 4-state navigation model
}

void ObservationMatrixBuilder::clear() {
    measurements_.clear();
    measurements_by_type_.clear();
}

std::vector<SensorMeasurement> ObservationMatrixBuilder::getCurrentMeasurements() const {
    return measurements_;
}

std::map<SensorType, std::map<std::string, double>> ObservationMatrixBuilder::getSensorStatistics()
    const {
    std::map<SensorType, std::map<std::string, double>> stats;

    for (const auto& type_pair : measurements_by_type_) {
        SensorType type = type_pair.first;
        const auto& measurements = type_pair.second;

        std::map<std::string, double> type_stats;
        type_stats["count"] = static_cast<double>(measurements.size());

        if (!measurements.empty()) {
            // Calculate statistics
            double sum = 0.0;
            double sum_sq = 0.0;
            uint64_t min_time = measurements[0].timestamp_ns;
            uint64_t max_time = measurements[0].timestamp_ns;

            for (const auto& measurement : measurements) {
                sum += measurement.value;
                sum_sq += measurement.value * measurement.value;
                min_time = std::min(min_time, measurement.timestamp_ns);
                max_time = std::max(max_time, measurement.timestamp_ns);
            }

            type_stats["mean"] = sum / measurements.size();
            type_stats["variance"] =
                (sum_sq / measurements.size()) - (type_stats["mean"] * type_stats["mean"]);
            type_stats["time_span_ms"] = static_cast<double>(max_time - min_time) / 1000000.0;
        }

        stats[type] = type_stats;
    }

    return stats;
}

bool ObservationMatrixBuilder::hasRecentData(SensorType sensor_type) const {
    auto it = measurements_by_type_.find(sensor_type);
    if (it == measurements_by_type_.end()) {
        return false;
    }

    uint64_t current_time = getCurrentTimestamp();
    const uint64_t timeout_ns = static_cast<uint64_t>(config_.max_data_age_ms) * 1000000;

    for (const auto& measurement : it->second) {
        if (current_time - measurement.timestamp_ns < timeout_ns) {
            return true;
        }
    }

    return false;
}

size_t ObservationMatrixBuilder::getSensorCount(SensorType sensor_type) const {
    auto it = measurements_by_type_.find(sensor_type);
    return (it != measurements_by_type_.end()) ? it->second.size() : 0;
}

// Private method implementations

void ObservationMatrixBuilder::filterMeasurements() {
    uint64_t current_time = getCurrentTimestamp();
    const uint64_t timeout_ns = static_cast<uint64_t>(config_.max_data_age_ms) * 1000000;

    // Filter by age
    auto it = std::remove_if(measurements_.begin(), measurements_.end(),
                             [current_time, timeout_ns](const SensorMeasurement& m) {
                                 return !m.valid || (current_time - m.timestamp_ns) > timeout_ns;
                             });
    measurements_.erase(it, measurements_.end());

    // Update measurements_by_type_
    measurements_by_type_.clear();
    for (const auto& measurement : measurements_) {
        measurements_by_type_[measurement.type].push_back(measurement);
    }
}

void ObservationMatrixBuilder::detectOutliers() {
    // Simple outlier detection implementation
    if (!config_.enable_outlier_detection)
        return;

    for (auto& type_pair : measurements_by_type_) {
        auto& measurements = type_pair.second;
        if (measurements.size() < 3)
            continue;

        // Calculate mean and standard deviation
        double sum = 0.0;
        for (const auto& m : measurements) {
            sum += m.value;
        }
        double mean = sum / measurements.size();

        double sum_sq = 0.0;
        for (const auto& m : measurements) {
            double diff = m.value - mean;
            sum_sq += diff * diff;
        }
        double std_dev = std::sqrt(sum_sq / measurements.size());

        // Mark outliers
        for (auto& measurement : measurements) {
            if (std::abs(measurement.value - mean) > config_.outlier_threshold_sigma * std_dev) {
                measurement.valid = false;
            }
        }
    }
}

void ObservationMatrixBuilder::synchronizeTimestamps() {
    // Simple timestamp synchronization - adjust based on your needs
    if (measurements_.empty())
        return;

    uint64_t reference_time = measurements_[0].timestamp_ns;
    const uint64_t tolerance_ns = static_cast<uint64_t>(config_.time_sync_tolerance_ms) * 1000000;

    for (auto& measurement : measurements_) {
        if (std::abs(static_cast<int64_t>(measurement.timestamp_ns - reference_time)) >
            tolerance_ns) {
            measurement.valid = false;
        }
    }
}

void ObservationMatrixBuilder::interpolateMissingData() {
    // Placeholder for interpolation implementation
    // This would interpolate missing sensor readings based on available data
}

Eigen::VectorXd ObservationMatrixBuilder::buildMeasurementVector(
    const std::map<size_t, SensorType>& state_mapping) {
    Eigen::VectorXd measurement_vector(state_mapping.size());

    for (const auto& state_pair : state_mapping) {
        size_t state_idx = state_pair.first;
        SensorType sensor_type = state_pair.second;

        // Find the most recent measurement of this type
        auto type_it = measurements_by_type_.find(sensor_type);
        if (type_it != measurements_by_type_.end() && !type_it->second.empty()) {
            // Use the most recent measurement
            measurement_vector(state_idx) = type_it->second.back().value;
        } else {
            measurement_vector(state_idx) = 0.0;  // Default value for missing data
        }
    }

    return measurement_vector;
}

Eigen::MatrixXd ObservationMatrixBuilder::buildObservationMatrixOnly(
    size_t state_vector_size, const std::map<size_t, SensorType>& state_mapping) {
    Eigen::MatrixXd H = Eigen::MatrixXd::Zero(state_mapping.size(), state_vector_size);

    // Build identity-like matrix based on state mapping
    for (const auto& state_pair : state_mapping) {
        size_t measurement_idx = state_pair.first;
        size_t state_idx = state_pair.first;  // Simplified mapping

        if (measurement_idx < H.rows() && state_idx < H.cols()) {
            H(measurement_idx, state_idx) = 1.0;  // Direct measurement
        }
    }

    return H;
}

Eigen::MatrixXd ObservationMatrixBuilder::buildMeasurementCovariance(
    const std::vector<SensorMeasurement>& measurements) {
    size_t n = measurements.size();
    Eigen::MatrixXd R = Eigen::MatrixXd::Zero(n, n);

    for (size_t i = 0; i < n; ++i) {
        R(i, i) = measurements[i].uncertainty * measurements[i].uncertainty;
    }

    return R;
}

std::vector<SensorMeasurement> ObservationMatrixBuilder::convertPTMessage(
    const PTMessage& pt_message, bool use_pressure, bool use_temperature) {
    std::vector<SensorMeasurement> measurements;

    if (use_pressure) {
        SensorMeasurement pressure_measurement;
        pressure_measurement.type = SensorType::PT_PRESSURE;
        pressure_measurement.sensor_id = pt_message.getField<1>();  // sensor_id
        pressure_measurement.value =
            pt_message.getField<2>();  // raw_voltage_v (will be converted to pressure later)
        pressure_measurement.uncertainty = 50.0;  // Default voltage uncertainty (Pa equivalent)
        pressure_measurement.timestamp_ns = pt_message.getField<0>();  // timestamp_ns
        pressure_measurement.valid = true;  // Assume valid for raw voltage
        measurements.push_back(pressure_measurement);
    }

    if (use_temperature) {
        SensorMeasurement temp_measurement;
        temp_measurement.type = SensorType::PT_TEMPERATURE;
        temp_measurement.sensor_id = pt_message.getField<1>();  // sensor_id
        temp_measurement.value =
            25.0;  // Default temperature (no temperature field in current PTMessage)
        temp_measurement.uncertainty = 1.0;  // Default temperature uncertainty
        temp_measurement.timestamp_ns = pt_message.getField<0>();  // timestamp_ns
        temp_measurement.valid = true;                             // Assume valid
        measurements.push_back(temp_measurement);
    }

    return measurements;
}

std::vector<SensorMeasurement> ObservationMatrixBuilder::convertIMUMessage(
    const IMUMessage& imu_message, bool use_accelerometer, bool use_gyroscope) {
    // Placeholder implementation
    return std::vector<SensorMeasurement>();
}

SensorMeasurement ObservationMatrixBuilder::convertBarometerMessage(
    const BarometerMessage& barometer_message) {
    // Placeholder implementation
    SensorMeasurement measurement;
    measurement.valid = false;
    return measurement;
}

std::vector<SensorMeasurement> ObservationMatrixBuilder::convertGPSPositionMessage(
    const GPSPositionMessage& gps_message, bool use_position) {
    // Placeholder implementation
    return std::vector<SensorMeasurement>();
}

std::vector<SensorMeasurement> ObservationMatrixBuilder::convertGPSVelocityMessage(
    const GPSVelocityMessage& gps_message, bool use_velocity) {
    // Placeholder implementation
    return std::vector<SensorMeasurement>();
}

double ObservationMatrixBuilder::calculateUncertainty(const SensorMeasurement& measurement) {
    return measurement.uncertainty;
}

bool ObservationMatrixBuilder::isMeasurementRecent(uint64_t timestamp) const {
    uint64_t current_time = getCurrentTimestamp();
    const uint64_t timeout_ns = static_cast<uint64_t>(config_.max_data_age_ms) * 1000000;
    return (current_time - timestamp) < timeout_ns;
}

uint64_t ObservationMatrixBuilder::getCurrentTimestamp() const {
    return Timer::get_time_ns();
}

// Factory functions

ObservationMatrixConfig getDefaultObservationMatrixConfig() {
    ObservationMatrixConfig config;
    config.max_data_age_ms = 1000.0;
    config.time_sync_tolerance_ms = 50.0;
    config.enable_outlier_detection = true;
    config.outlier_threshold_sigma = 3.0;
    config.enable_interpolation = false;
    config.interpolation_window_ms = 100.0;
    config.max_sensors_per_type = 10;
    return config;
}

std::shared_ptr<ObservationMatrixBuilder> createObservationMatrixBuilder() {
    return std::make_shared<ObservationMatrixBuilder>(getDefaultObservationMatrixConfig());
}
