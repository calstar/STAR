#ifndef DIABLO_NAVIGATION_FILTER_HPP
#define DIABLO_NAVIGATION_FILTER_HPP

#include <Eigen/Dense>
#include <chrono>
#include <deque>
#include <memory>
#include <mutex>

#include "../comms/include/mfNavigationMessage.hpp"
#include "DiabloSensorFusion.hpp"

/**
 * @brief Navigation filter for DiabloAvionics engine control system
 *
 * Implements a lightweight Kalman-style filter optimized for engine state estimation
 * using our sensor suite (PT, TC, RTD, LC). Designed for real-time engine control
 * rather than high-precision navigation.
 */
class DiabloNavigationFilter {
public:
    struct FilterConfig {
        // Process noise (how much we trust the model vs measurements)
        double position_process_noise;  // m²/s
        double velocity_process_noise;  // m²/s³
        double altitude_process_noise;  // m²/s

        // Measurement noise (sensor uncertainties)
        double altitude_measurement_noise;     // m²
        double thrust_measurement_noise;       // N²
        double temperature_measurement_noise;  // °C²

        // Initial uncertainties
        double initial_altitude_uncertainty;  // m
        double initial_velocity_uncertainty;  // m/s

        // Filter parameters
        bool enable_adaptive_noise;          // Adapt noise based on sensor quality
        double outlier_rejection_threshold;  // Sigma threshold for outliers
    };

    struct FilterState {
        // Core state
        double altitude_m;            // Altitude above sea level
        double vertical_velocity_ms;  // Vertical velocity (positive up)
        double thrust_n;              // Current thrust estimate

        // Covariance (uncertainty)
        double altitude_variance_m2;
        double velocity_variance_m2s2;
        double thrust_variance_n2;

        // Quality metrics
        double state_quality;  // Overall state quality (0-1)
        bool valid;            // Is state valid
        std::chrono::steady_clock::time_point timestamp;
    };

    DiabloNavigationFilter();
    ~DiabloNavigationFilter() = default;

    // Configuration
    void initialize(const FilterConfig& config);
    void reset();  // Reset filter to initial state

    // Filter operations
    FilterState predict(double dt);  // Predict state forward by dt
    FilterState update(const DiabloSensorFusion::FusedMeasurement& measurement);
    FilterState getCurrentState() const;

    // Direct state access
    double getAltitude() const {
        return state_.altitude_m;
    }
    double getVerticalVelocity() const {
        return state_.vertical_velocity_ms;
    }
    double getThrust() const {
        return state_.thrust_n;
    }
    double getStateQuality() const {
        return state_.state_quality;
    }

private:
    FilterConfig config_;
    FilterState state_;
    mutable std::mutex state_mutex_;

    // History for velocity estimation
    std::deque<std::pair<double, std::chrono::steady_clock::time_point>> altitude_history_;
    static constexpr size_t VELOCITY_HISTORY_SIZE = 10;

    // Helper functions
    double estimateVelocityFromAltitude(double dt);
    bool isOutlier(double measurement, double predicted, double variance) const;
    void adaptNoiseBasedOnQuality(double sensor_quality);
};

#endif  // DIABLO_NAVIGATION_FILTER_HPP
