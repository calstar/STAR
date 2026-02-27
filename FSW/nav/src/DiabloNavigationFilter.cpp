#include "../include/DiabloNavigationFilter.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

DiabloNavigationFilter::DiabloNavigationFilter() {
    // Initialize with default config
    config_.position_process_noise = 1.0;          // m²/s
    config_.velocity_process_noise = 0.1;          // m²/s³
    config_.altitude_process_noise = 1.0;          // m²/s
    config_.altitude_measurement_noise = 100.0;    // m² (10m std dev)
    config_.thrust_measurement_noise = 1000.0;     // N² (31.6 N std dev)
    config_.temperature_measurement_noise = 25.0;  // °C² (5°C std dev)
    config_.initial_altitude_uncertainty = 50.0;   // m
    config_.initial_velocity_uncertainty = 1.0;    // m/s
    config_.enable_adaptive_noise = true;
    config_.outlier_rejection_threshold = 3.0;  // 3 sigma

    reset();
}

void DiabloNavigationFilter::initialize(const FilterConfig& config) {
    std::lock_guard<std::mutex> lock(state_mutex_);
    config_ = config;
    reset();
}

void DiabloNavigationFilter::reset() {
    std::lock_guard<std::mutex> lock(state_mutex_);

    state_.altitude_m = 0.0;
    state_.vertical_velocity_ms = 0.0;
    state_.thrust_n = 0.0;

    state_.altitude_variance_m2 =
        config_.initial_altitude_uncertainty * config_.initial_altitude_uncertainty;
    state_.velocity_variance_m2s2 =
        config_.initial_velocity_uncertainty * config_.initial_velocity_uncertainty;
    state_.thrust_variance_n2 = config_.thrust_measurement_noise;

    state_.state_quality = 0.0;
    state_.valid = false;
    state_.timestamp = std::chrono::steady_clock::now();

    altitude_history_.clear();
}

DiabloNavigationFilter::FilterState DiabloNavigationFilter::predict(double dt) {
    std::lock_guard<std::mutex> lock(state_mutex_);

    FilterState predicted = state_;

    // Simple kinematic prediction:
    // h_new = h_old + v_vertical * dt
    // v_new = v_old (assume constant velocity for short dt)

    predicted.altitude_m += predicted.vertical_velocity_ms * dt;

    // Increase uncertainty due to process noise
    predicted.altitude_variance_m2 += config_.altitude_process_noise * dt;
    predicted.velocity_variance_m2s2 += config_.velocity_process_noise * dt;

    // Decay state quality slightly
    predicted.state_quality *= 0.99;

    predicted.timestamp = std::chrono::steady_clock::now();

    return predicted;
}

bool DiabloNavigationFilter::isOutlier(double measurement, double predicted,
                                       double variance) const {
    if (variance <= 0.0)
        return false;

    double innovation = measurement - predicted;
    double std_dev = std::sqrt(variance);
    double normalized_innovation = std::abs(innovation) / std_dev;

    return normalized_innovation > config_.outlier_rejection_threshold;
}

void DiabloNavigationFilter::adaptNoiseBasedOnQuality(double sensor_quality) {
    if (!config_.enable_adaptive_noise)
        return;

    // Adapt measurement noise based on sensor quality
    // Lower quality = higher noise
    double quality_factor = 1.0 / std::max(0.1, sensor_quality);
    config_.altitude_measurement_noise = 100.0 * quality_factor;
    config_.thrust_measurement_noise = 1000.0 * quality_factor;
}

double DiabloNavigationFilter::estimateVelocityFromAltitude(double dt) {
    if (altitude_history_.size() < 2 || dt <= 0.0) {
        return 0.0;
    }

    // Use linear regression on recent altitude points
    double sum_t = 0.0, sum_h = 0.0, sum_t2 = 0.0, sum_th = 0.0;
    size_t n = altitude_history_.size();

    auto now = std::chrono::steady_clock::now();

    for (const auto& [altitude, timestamp] : altitude_history_) {
        auto time_diff =
            std::chrono::duration_cast<std::chrono::milliseconds>(now - timestamp).count() / 1000.0;
        double t = -time_diff;  // Negative because we're going backwards in time

        sum_t += t;
        sum_h += altitude;
        sum_t2 += t * t;
        sum_th += t * altitude;
    }

    // Linear regression: h = a + b*t, velocity = b
    double denominator = n * sum_t2 - sum_t * sum_t;
    if (std::abs(denominator) < 1e-6) {
        return 0.0;
    }

    double velocity = (n * sum_th - sum_t * sum_h) / denominator;

    return velocity;
}

DiabloNavigationFilter::FilterState DiabloNavigationFilter::update(
    const DiabloSensorFusion::FusedMeasurement& measurement) {
    std::lock_guard<std::mutex> lock(state_mutex_);

    if (!measurement.valid) {
        // Prediction only, no update
        return state_;
    }

    // Predict forward to measurement time
    auto time_diff = std::chrono::duration_cast<std::chrono::milliseconds>(measurement.timestamp -
                                                                           state_.timestamp)
                         .count() /
                     1000.0;

    if (time_diff > 0.0 && time_diff < 10.0) {  // Reasonable time difference
        FilterState predicted = predict(time_diff);

        // Kalman update for altitude
        if (measurement.altitude_m > 0.0) {
            double predicted_altitude = predicted.altitude_m;
            double innovation = measurement.altitude_m - predicted_altitude;
            double innovation_variance =
                predicted.altitude_variance_m2 +
                measurement.uncertainty_altitude_m * measurement.uncertainty_altitude_m;

            // Check for outlier
            if (!isOutlier(measurement.altitude_m, predicted_altitude, innovation_variance)) {
                // Kalman gain
                double K = predicted.altitude_variance_m2 / innovation_variance;

                // Update state
                state_.altitude_m = predicted_altitude + K * innovation;
                state_.altitude_variance_m2 = (1.0 - K) * predicted.altitude_variance_m2;

                // Update quality
                state_.state_quality = std::min(1.0, state_.state_quality + 0.1);
            } else {
                // Outlier detected, use predicted state
                state_.altitude_m = predicted_altitude;
                state_.altitude_variance_m2 = predicted.altitude_variance_m2;
                state_.state_quality *= 0.95;  // Decrease quality
            }
        }

        // Update velocity estimate from altitude history
        altitude_history_.push_back({state_.altitude_m, measurement.timestamp});
        if (altitude_history_.size() > VELOCITY_HISTORY_SIZE) {
            altitude_history_.pop_front();
        }

        state_.vertical_velocity_ms = estimateVelocityFromAltitude(time_diff);

        // Update thrust (direct measurement, no filtering needed for now)
        if (measurement.thrust_estimated_n >= 0.0) {
            // Simple exponential moving average for thrust
            double alpha = 0.7;  // Smoothing factor
            state_.thrust_n =
                alpha * measurement.thrust_estimated_n + (1.0 - alpha) * state_.thrust_n;
            state_.thrust_variance_n2 =
                measurement.uncertainty_thrust_n * measurement.uncertainty_thrust_n;
        }

        // Adapt noise based on sensor quality
        adaptNoiseBasedOnQuality(measurement.quality);

        state_.timestamp = measurement.timestamp;
        state_.valid = true;
    }

    return state_;
}

DiabloNavigationFilter::FilterState DiabloNavigationFilter::getCurrentState() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return state_;
}
