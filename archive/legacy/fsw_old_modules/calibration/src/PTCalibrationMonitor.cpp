#include <iostream>

#include "PTCalibrationTool.hpp"

// PTCalibrationMonitor Implementation
PTCalibrationMonitor::PTCalibrationMonitor() {
    // Constructor implementation
}

PTCalibrationMonitor::~PTCalibrationMonitor() {
    // Destructor implementation
}

void PTCalibrationMonitor::startMonitoring(uint8_t sensor_id, uint8_t pt_location) {
    SensorData sensor_data;
    sensor_data.sensor_id = sensor_id;
    sensor_data.pt_location = pt_location;
    sensor_data.status = "Monitoring";
    sensor_data.last_update = std::chrono::system_clock::now();

    sensors_[sensor_id] = sensor_data;
}

std::string PTCalibrationMonitor::getSensorStatus(uint8_t sensor_id) const {
    auto it = sensors_.find(sensor_id);
    if (it != sensors_.end()) {
        return it->second.status;
    }
    return "Unknown";
}

CalibrationQualityMetrics PTCalibrationMonitor::getSensorQuality(uint8_t sensor_id) const {
    CalibrationQualityMetrics metrics;
    // Return default quality metrics
    metrics.nrmse = 0.1;
    metrics.coverage_95 = 0.95;
    metrics.extrapolation_confidence = 0.9;
    return metrics;
}

bool PTCalibrationMonitor::needsRecalibration(uint8_t sensor_id) const {
    auto it = sensors_.find(sensor_id);
    if (it != sensors_.end()) {
        // Simple logic: if sensor hasn't been updated recently, it needs recalibration
        auto now = std::chrono::system_clock::now();
        auto time_since_update =
            std::chrono::duration_cast<std::chrono::hours>(now - it->second.last_update);
        return time_since_update.count() > 24;  // 24 hours
    }
    return false;
}

std::vector<uint8_t> PTCalibrationMonitor::getMonitoredSensors() const {
    std::vector<uint8_t> sensor_ids;
    for (const auto& pair : sensors_) {
        sensor_ids.push_back(pair.first);
    }
    return sensor_ids;
}

void PTCalibrationMonitor::addPTMeasurement(const PTMessage& pt_message, double reference_pressure,
                                            const EnvironmentalState& environment) {
    // Process PT measurement for monitoring
    uint8_t sensor_id = pt_message.getField<1>();

    auto it = sensors_.find(sensor_id);
    if (it != sensors_.end()) {
        it->second.last_update = std::chrono::system_clock::now();
        it->second.status = "Active";
    }
}

void PTCalibrationMonitor::updateSensorStatus(uint8_t sensor_id) {
    auto it = sensors_.find(sensor_id);
    if (it != sensors_.end()) {
        it->second.last_update = std::chrono::system_clock::now();
        it->second.status = "Active";
    }
}
