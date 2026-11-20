#pragma once
/**
 * Output smoothing for calibrated PT pressure, per sensor uid (ESP32 and LabJack T7 alike).
 *
 * An exponential moving average seeded with the sensor's FIRST reading. It used to live in a
 * plain std::unordered_map<uint16_t, double> read through operator[], which default-inserts 0.0:
 * the "not yet set" test (isfinite) then passed on the very first sample, and every PT ramped up
 * from 0 psi over its first handful of readings (a 300 psi tank archived a 68 psi minimum).
 */
#include <cmath>
#include <cstdint>
#include <unordered_map>

namespace fsw::calibration {

class PtSmoother {
public:
    /** 0.25 → roughly a 4-sample effective window. */
    explicit PtSmoother(double alpha = 0.25) : alpha_(alpha) {
    }

    /** Feed one reading; returns the smoothed value. The first reading, or the first after a
     *  non-finite one, is passed through unchanged and seeds the average. */
    double step(uint16_t uid, double value) {
        auto it = state_.find(uid);
        if (it == state_.end() || !std::isfinite(it->second)) {
            state_[uid] = value;
            return value;
        }
        it->second = alpha_ * value + (1.0 - alpha_) * it->second;
        return it->second;
    }

    void reset(uint16_t uid) {
        state_.erase(uid);
    }

private:
    double alpha_;
    std::unordered_map<uint16_t, double> state_;
};

}  // namespace fsw::calibration
