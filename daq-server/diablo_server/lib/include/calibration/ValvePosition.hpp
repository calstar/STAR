#pragma once

/**
 * Motorized ball valve position: raw ADC counts -> % open.
 *
 * The valve reports its position as a 4-20 mA loop (4 mA closed, 20 mA open) across a 100 ohm
 * shunt into the ball valve board's 12-bit ESP32 ADC (firmware/Hotfire_Code/BallValve_Hotfire,
 * analogRead at 11 dB, 3.3 V full scale), so 0.4-2.0 V on the pin. The board sends raw counts and
 * the conversion happens here, like every other board.
 */

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace fsw {
namespace calibration {
namespace valve_position {

constexpr double kAdcMaxCounts = 4095.0;  // 12-bit
constexpr double kAdcRefVolts = 3.3;
constexpr double kShuntOhms = 100.0;
constexpr double kLoopMinMa = 4.0;   // closed
constexpr double kLoopMaxMa = 20.0;  // open
/** Below this the loop is open or unpowered: no position, not "fully closed". */
constexpr double kNoSignalMa = 3.5;

/** cal_status values published beside the position. */
constexpr uint8_t kStatusOk = 1;
constexpr uint8_t kStatusNoSignal = 2;

inline double counts_to_ma(uint32_t counts) {
    return static_cast<double>(counts) / kAdcMaxCounts * kAdcRefVolts / kShuntOhms * 1000.0;
}

/** % open, clamped to 0-100 (a loop a little outside 4-20 mA is still the end of travel). */
inline double ma_to_percent_open(double ma) {
    if (!std::isfinite(ma))
        return 0.0;
    const double pct = (ma - kLoopMinMa) / (kLoopMaxMa - kLoopMinMa) * 100.0;
    return std::clamp(pct, 0.0, 100.0);
}

struct Reading {
    float percent_open;
    uint8_t status;  // kStatusOk or kStatusNoSignal
};

inline Reading from_counts(uint32_t counts) {
    const double ma = counts_to_ma(counts);
    if (ma < kNoSignalMa)
        return {0.0f, kStatusNoSignal};
    return {static_cast<float>(ma_to_percent_open(ma)), kStatusOk};
}

}  // namespace valve_position
}  // namespace calibration
}  // namespace fsw
