#include <chrono>
#include <iostream>

#include "PTObservationMatrix.hpp"

// Default configuration function
PTObservationMatrixConfig getDefaultPTObservationMatrixConfig() {
    PTObservationMatrixConfig config;
    config.max_data_age_ms = 1000.0;        // 1 second
    config.time_sync_tolerance_ms = 100.0;  // 100 ms
    config.enable_outlier_detection = true;
    config.outlier_threshold_sigma = 3.0;
    config.max_pt_sensors = 9;
    config.enable_interpolation = true;
    config.interpolation_window_ms = 500.0;
    return config;
}

// PTObservationMatrixBuilder Implementation
PTObservationMatrixBuilder::PTObservationMatrixBuilder(const PTObservationMatrixConfig& config)
    : config_(config) {
    // Constructor implementation
}

void PTObservationMatrixBuilder::addPTSensors(
    const std::vector<std::shared_ptr<PTMessage>>& pt_messages) {
    for (const auto& pt_msg : pt_messages) {
        PTMeasurement measurement;
        measurement.sensor_id = pt_msg->getField<1>();      // sensor_id
        measurement.raw_voltage_v = pt_msg->getField<2>();  // voltage
        measurement.pt_location = pt_msg->getField<3>();    // pt_location
        measurement.timestamp_ns = pt_msg->getField<0>();   // timestamp
        measurement.valid = true;

        measurements_.push_back(measurement);
        latest_measurements_[pt_msg->getField<1>()] = measurement;  // sensor_id
    }
}

PTObservationMatrixResult PTObservationMatrixBuilder::buildEngineStateObservationMatrix(
    size_t state_vector_size) {
    PTObservationMatrixResult result;

    // Create a simple observation matrix
    result.observation_matrix = Eigen::MatrixXd::Zero(measurements_.size(), state_vector_size);

    // For now, just create a simple mapping
    for (size_t i = 0; i < measurements_.size() && i < state_vector_size; ++i) {
        result.observation_matrix(i, i) = 1.0;
    }

    result.measurement_vector = Eigen::VectorXd::Zero(measurements_.size());
    for (size_t i = 0; i < measurements_.size(); ++i) {
        result.measurement_vector(i) = measurements_[i].raw_voltage_v;  // voltage
    }

    result.measurement_covariance =
        Eigen::MatrixXd::Identity(measurements_.size(), measurements_.size()) * 0.01;

    return result;
}

PTObservationMatrixResult PTObservationMatrixBuilder::buildCustomObservationMatrix(
    const std::map<size_t, uint8_t>& sensor_locations, size_t state_vector_size) {
    PTObservationMatrixResult result;

    // Create observation matrix based on custom mapping
    result.observation_matrix = Eigen::MatrixXd::Zero(sensor_locations.size(), state_vector_size);
    result.measurement_vector = Eigen::VectorXd::Zero(sensor_locations.size());
    result.measurement_covariance =
        Eigen::MatrixXd::Identity(sensor_locations.size(), sensor_locations.size()) * 0.01;

    // Simple implementation - map each PT sensor to its corresponding state
    size_t sensor_idx = 0;
    for (const auto& pair : sensor_locations) {
        if (sensor_idx < sensor_locations.size() && pair.first < state_vector_size) {
            result.observation_matrix(sensor_idx, pair.first) = 1.0;

            // Find measurement for this sensor
            auto it = latest_measurements_.find(pair.second);
            if (it != latest_measurements_.end()) {
                result.measurement_vector(sensor_idx) = it->second.raw_voltage_v;  // voltage
            }
            sensor_idx++;
        }
    }

    return result;
}

void PTObservationMatrixBuilder::clear() {
    measurements_.clear();
    latest_measurements_.clear();
}

std::vector<PTMeasurement> PTObservationMatrixBuilder::getCurrentMeasurements() const {
    return measurements_;
}

std::map<uint8_t, std::map<std::string, double>> PTObservationMatrixBuilder::getPTStatistics()
    const {
    std::map<uint8_t, std::map<std::string, double>> stats;

    for (const auto& pair : latest_measurements_) {
        std::map<std::string, double> sensor_stats;
        sensor_stats["voltage"] = pair.second.raw_voltage_v;
        sensor_stats["timestamp_ns"] = static_cast<double>(pair.second.timestamp_ns);
        sensor_stats["valid"] = pair.second.valid ? 1.0 : 0.0;

        stats[pair.first] = sensor_stats;
    }

    return stats;
}

bool PTObservationMatrixBuilder::hasRecentPTData(uint8_t sensor_id) const {
    auto it = latest_measurements_.find(sensor_id);
    if (it != latest_measurements_.end()) {
        // Check if data is recent (within max_data_age_ms)
        uint64_t current_time = std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::system_clock::now().time_since_epoch())
                                    .count();
        uint64_t data_age = current_time - (it->second.timestamp_ns / 1000000);  // Convert ns to ms
        return data_age < config_.max_data_age_ms;
    }
    return false;
}

size_t PTObservationMatrixBuilder::getPTSensorCount() const {
    return latest_measurements_.size();
}

std::vector<uint8_t> PTObservationMatrixBuilder::getActivePTSensors() const {
    std::vector<uint8_t> active_sensors;
    for (const auto& pair : latest_measurements_) {
        if (hasRecentPTData(pair.first)) {
            active_sensors.push_back(pair.first);
        }
    }
    return active_sensors;
}

void PTObservationMatrixBuilder::filterMeasurements() {
    // Filter measurements by age and validity
    auto it = measurements_.begin();
    while (it != measurements_.end()) {
        if (!hasRecentPTData(it->sensor_id)) {  // sensor_id
            it = measurements_.erase(it);
        } else {
            ++it;
        }
    }
}

void PTObservationMatrixBuilder::detectOutliers() {
    // Simple outlier detection implementation
    if (!config_.enable_outlier_detection) {
        return;
    }

    // This is a placeholder - real implementation would use statistical methods
    for (auto& measurement : measurements_) {
        double voltage = measurement.raw_voltage_v;
        // Simple range check as placeholder
        if (voltage < 0.0 || voltage > 5.0) {
            measurement.valid = false;
        }
    }
}
