#ifndef FSW_MONOTONIC_TIME_HPP
#define FSW_MONOTONIC_TIME_HPP

/**
 * @file MonotonicTime.hpp
 * @brief Centralized monotonic timestamp utilities for all FSW services.
 *
 * ALL services MUST use these functions for timestamps written to Elodin DB.
 * This ensures consistent time correlation across daq_bridge, calibration_service,
 * controller_service, sequencer_service, and data_logger_service.
 *
 * Uses CLOCK_MONOTONIC (via std::chrono::steady_clock) which:
 *   - Never jumps backward (unlike system_clock / NTP)
 *   - Survives NTP corrections
 *   - Matches Elodin DB's internal monotonic timestamp
 */

#include <chrono>
#include <cstdint>
#include <ctime>

namespace fsw {
namespace time {

/**
 * @brief Get current monotonic time in nanoseconds since boot.
 * Use this for ALL Elodin DB timestamp_ns fields.
 */
inline uint64_t monotonic_ns() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()
        ).count()
    );
}

/**
 * @brief Get current monotonic time in microseconds since boot.
 */
inline uint64_t monotonic_us() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now().time_since_epoch()
        ).count()
    );
}

/**
 * @brief Get current monotonic time in milliseconds since boot.
 */
inline uint64_t monotonic_ms() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()
        ).count()
    );
}

/**
 * @brief Get current monotonic time as a steady_clock time_point.
 */
inline std::chrono::steady_clock::time_point monotonic_now() {
    return std::chrono::steady_clock::now();
}

/**
 * @brief Convert steady_clock time_point to nanoseconds since boot.
 */
inline uint64_t to_ns(std::chrono::steady_clock::time_point tp) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            tp.time_since_epoch()
        ).count()
    );
}

/**
 * @brief Compute elapsed nanoseconds between two time points.
 */
inline uint64_t elapsed_ns(
    std::chrono::steady_clock::time_point start,
    std::chrono::steady_clock::time_point end
) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count()
    );
}

}  // namespace time
}  // namespace fsw

#endif  // FSW_MONOTONIC_TIME_HPP
