#ifndef VOLTAGE_FILTER_HPP
#define VOLTAGE_FILTER_HPP

#include <cmath>
#include <deque>

/**
 * @brief Robust voltage filtering system for PT calibration
 *
 * Implements multiple filtering strategies:
 * 1. Exponential Moving Average (EMA) for fast response
 * 2. Low-pass filter for noise reduction
 * 3. Outlier detection and rejection
 * 4. Adaptive filtering based on signal characteristics
 */
class VoltageFilter {
public:
    struct FilterConfig {
        double ema_alpha;          // EMA smoothing factor (0.01 = very smooth, 0.3 = responsive)
        double lowpass_cutoff_hz;  // Low-pass filter cutoff frequency
        double outlier_threshold;  // Standard deviations for outlier detection
        size_t buffer_size;        // Buffer size for statistical analysis
        double min_voltage;        // Minimum valid voltage
        double max_voltage;        // Maximum valid voltage
        double max_change_rate;    // Maximum voltage change per sample (V/s)

        FilterConfig()
            : ema_alpha(0.1),
              lowpass_cutoff_hz(1.0),
              outlier_threshold(3.0),
              buffer_size(20),
              min_voltage(0.001),
              max_voltage(10.0),
              max_change_rate(5.0) {
        }
    };

    VoltageFilter(const FilterConfig& config = FilterConfig());

    /**
     * @brief Filter a new voltage reading
     * @param raw_voltage Raw voltage input
     * @param dt Time since last sample (seconds)
     * @return Filtered voltage
     */
    double filter(double raw_voltage, double dt = 0.1);

    /**
     * @brief Reset the filter state
     */
    void reset();

    /**
     * @brief Get current filter statistics
     */
    struct FilterStats {
        double ema_output;
        double lowpass_output;
        double final_output;
        double variance;
        bool was_outlier;
        bool was_rate_limited;
    };
    FilterStats getStats() const {
        return stats_;
    }

    /**
     * @brief Update filter configuration
     */
    void updateConfig(const FilterConfig& config);

private:
    FilterConfig config_;
    FilterStats stats_;

    // EMA state
    double ema_state_;
    bool ema_initialized_;

    // Low-pass filter state
    double lowpass_state_;
    bool lowpass_initialized_;

    // Statistical analysis buffer
    std::deque<double> voltage_buffer_;
    double sum_;
    double sum_sq_;

    // Rate limiting state
    double last_voltage_;
    double last_time_;
    bool first_sample_;

    /**
     * @brief Apply exponential moving average
     */
    double applyEMA(double voltage);

    /**
     * @brief Apply low-pass filter (simple RC filter)
     */
    double applyLowPass(double voltage, double dt);

    /**
     * @brief Check for outliers using statistical analysis
     */
    bool isOutlier(double voltage) const;

    /**
     * @brief Apply rate limiting to prevent sudden jumps
     */
    double applyRateLimit(double voltage, double dt);

    /**
     * @brief Update statistical buffer
     */
    void updateBuffer(double voltage);
};

#endif  // VOLTAGE_FILTER_HPP
