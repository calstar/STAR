#ifndef DAQ_SENSOR_MESSAGES_HPP
#define DAQ_SENSOR_MESSAGES_HPP

#include <cstdint>
#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace sensor {

/**
 * @brief Raw Pressure Transducer sample message for Elodin
 * 
 * Simplified schema focused on raw sensor data.
 * Calibrated values will be added in a separate table later.
 * 
 * CRITICAL: Includes padding bytes to ensure uint32_t fields are 4-byte aligned
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + uint32_t (4) + uint32_t (4) + uint8_t (1) = 21 bytes
 */
using RawPTMessage = CommsMessage<
    uint64_t,           // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,            // (1) channel_id - sensor channel identifier
    std::array<uint8_t, 3>,  // (2) padding - 3 bytes to align uint32_t to 4-byte boundary
    uint32_t,           // (3) raw_adc_counts - raw ADC reading
    uint32_t,           // (4) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t             // (5) status_flags - status/health flags
>;

/**
 * @brief Raw Thermocouple sample message for Elodin
 * CRITICAL: Includes padding bytes to ensure uint32_t fields are 4-byte aligned
 */
using RawTCMessage = CommsMessage<
    uint64_t,           // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,            // (1) channel_id - sensor channel identifier
    std::array<uint8_t, 3>,  // (2) padding - 3 bytes to align uint32_t to 4-byte boundary
    uint32_t,           // (3) raw_adc_counts - raw ADC reading
    uint32_t,           // (4) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t             // (5) status_flags - status/health flags
>;

/**
 * @brief Raw RTD sample message for Elodin
 * CRITICAL: Includes padding bytes to ensure uint32_t fields are 4-byte aligned
 */
using RawRTDMessage = CommsMessage<
    uint64_t,           // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,            // (1) channel_id - sensor channel identifier
    std::array<uint8_t, 3>,  // (2) padding - 3 bytes to align uint32_t to 4-byte boundary
    uint32_t,           // (3) raw_resistance_counts - ADC counts representing resistance
    uint32_t,           // (4) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t             // (5) status_flags - status/health flags
>;

/**
 * @brief Raw Load Cell sample message for Elodin
 * CRITICAL: Includes padding bytes to ensure uint32_t fields are 4-byte aligned
 */
using RawLCMessage = CommsMessage<
    uint64_t,           // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,            // (1) channel_id - sensor channel identifier
    std::array<uint8_t, 3>,  // (2) padding - 3 bytes to align uint32_t to 4-byte boundary
    uint32_t,           // (3) raw_adc_counts - raw ADC reading
    uint32_t,           // (4) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t             // (5) status_flags - status/health flags
>;

} // namespace sensor
} // namespace messages
using comms::CommsMessage;
} // namespace comms

#endif // DAQ_SENSOR_MESSAGES_HPP

