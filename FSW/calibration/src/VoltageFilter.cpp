#include "VoltageFilter.hpp"
#include <algorithm>

VoltageFilter::VoltageFilter(const FilterConfig& config)
    : config_(config), ema_state_(0.0), ema_initialized_(false),
      lowpass_state_(0.0), lowpass_initialized_(false),
      sum_(0.0), sum_sq_(0.0), last_voltage_(0.0), last_time_(0.0),
      first_sample_(true) {
    stats_ = {};
}

double VoltageFilter::filter(double raw_voltage, double dt) {
    // Clamp input voltage to reasonable range
    raw_voltage = std::clamp(raw_voltage, config_.min_voltage, config_.max_voltage);
    
    // Initialize on first sample
    if (first_sample_) {
        ema_state_ = raw_voltage;
        lowpass_state_ = raw_voltage;
        last_voltage_ = raw_voltage;
        last_time_ = 0.0;
        first_sample_ = false;
        
        stats_.ema_output = raw_voltage;
        stats_.lowpass_output = raw_voltage;
        stats_.final_output = raw_voltage;
        stats_.was_outlier = false;
        stats_.was_rate_limited = false;
        
        updateBuffer(raw_voltage);
        return raw_voltage;
    }
    
    // Apply rate limiting first
    double rate_limited_voltage = applyRateLimit(raw_voltage, dt);
    stats_.was_rate_limited = (rate_limited_voltage != raw_voltage);
    
    // Apply exponential moving average
    double ema_output = applyEMA(rate_limited_voltage);
    stats_.ema_output = ema_output;
    
    // Apply low-pass filter
    double lowpass_output = applyLowPass(ema_output, dt);
    stats_.lowpass_output = lowpass_output;
    
    // Check for outliers
    bool is_outlier = isOutlier(lowpass_output);
    stats_.was_outlier = is_outlier;
    
    // If outlier, use EMA output instead
    double final_output = is_outlier ? ema_output : lowpass_output;
    stats_.final_output = final_output;
    
    // Update statistical buffer
    updateBuffer(final_output);
    
    // Calculate variance for statistics
    if (voltage_buffer_.size() > 1) {
        double mean = sum_ / voltage_buffer_.size();
        stats_.variance = (sum_sq_ / voltage_buffer_.size()) - (mean * mean);
        stats_.variance = std::max(0.0, stats_.variance); // Ensure non-negative
    } else {
        stats_.variance = 0.0;
    }
    
    // Update last values
    last_voltage_ = final_output;
    last_time_ += dt;
    
    return final_output;
}

void VoltageFilter::reset() {
    ema_state_ = 0.0;
    ema_initialized_ = false;
    lowpass_state_ = 0.0;
    lowpass_initialized_ = false;
    voltage_buffer_.clear();
    sum_ = 0.0;
    sum_sq_ = 0.0;
    last_voltage_ = 0.0;
    last_time_ = 0.0;
    first_sample_ = true;
    stats_ = {};
}

void VoltageFilter::updateConfig(const FilterConfig& config) {
    config_ = config;
    // Reset filter state when configuration changes
    reset();
}

double VoltageFilter::applyEMA(double voltage) {
    if (!ema_initialized_) {
        ema_state_ = voltage;
        ema_initialized_ = true;
        return voltage;
    }
    
    // EMA: y[n] = α * x[n] + (1-α) * y[n-1]
    ema_state_ = config_.ema_alpha * voltage + (1.0 - config_.ema_alpha) * ema_state_;
    return ema_state_;
}

double VoltageFilter::applyLowPass(double voltage, double dt) {
    if (!lowpass_initialized_) {
        lowpass_state_ = voltage;
        lowpass_initialized_ = true;
        return voltage;
    }
    
    // Simple RC low-pass filter: y[n] = α * x[n] + (1-α) * y[n-1]
    // where α = dt / (dt + RC), RC = 1/(2π*fc)
    double rc = 1.0 / (2.0 * M_PI * config_.lowpass_cutoff_hz);
    double alpha = dt / (dt + rc);
    
    lowpass_state_ = alpha * voltage + (1.0 - alpha) * lowpass_state_;
    return lowpass_state_;
}

bool VoltageFilter::isOutlier(double voltage) const {
    if (voltage_buffer_.size() < 3) {
        return false; // Need at least 3 samples for statistical analysis
    }
    
    // Calculate mean and standard deviation
    double mean = sum_ / voltage_buffer_.size();
    double variance = (sum_sq_ / voltage_buffer_.size()) - (mean * mean);
    variance = std::max(0.0, variance); // Ensure non-negative
    double std_dev = std::sqrt(variance);
    
    if (std_dev < 1e-9) {
        return false; // No variation, can't be an outlier
    }
    
    // Check if voltage is more than threshold standard deviations from mean
    double z_score = std::abs(voltage - mean) / std_dev;
    return z_score > config_.outlier_threshold;
}

double VoltageFilter::applyRateLimit(double voltage, double dt) {
    if (first_sample_) {
        return voltage;
    }
    
    double max_change = config_.max_change_rate * dt;
    double voltage_change = voltage - last_voltage_;
    
    if (std::abs(voltage_change) > max_change) {
        // Apply rate limiting
        if (voltage_change > 0) {
            return last_voltage_ + max_change;
        } else {
            return last_voltage_ - max_change;
        }
    }
    
    return voltage;
}

void VoltageFilter::updateBuffer(double voltage) {
    voltage_buffer_.push_back(voltage);
    
    // Maintain buffer size
    if (voltage_buffer_.size() > config_.buffer_size) {
        double removed_voltage = voltage_buffer_.front();
        voltage_buffer_.pop_front();
        
        // Update running sums
        sum_ -= removed_voltage;
        sum_sq_ -= removed_voltage * removed_voltage;
    }
    
    // Add new voltage to running sums
    sum_ += voltage;
    sum_sq_ += voltage * voltage;
}
