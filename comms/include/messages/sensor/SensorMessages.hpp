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
 */
using RawPTMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,     // (1) channel_id - sensor channel identifier
    uint32_t,    // (2) raw_adc_counts - raw ADC reading
    uint32_t,    // (3) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t      // (4) status_flags - status/health flags
>;

/**
 * @brief Raw Thermocouple sample message for Elodin
 */
using RawTCMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,     // (1) channel_id - sensor channel identifier
    uint32_t,    // (2) raw_adc_counts - raw ADC reading
    uint32_t,    // (3) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t      // (4) status_flags - status/health flags
>;

/**
 * @brief Raw RTD sample message for Elodin
 */
using RawRTDMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,     // (1) channel_id - sensor channel identifier
    uint32_t,    // (2) raw_resistance_counts - ADC counts representing resistance
    uint32_t,    // (3) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t      // (4) status_flags - status/health flags
>;

/**
 * @brief Raw Load Cell sample message for Elodin
 */
using RawLCMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp in nanoseconds
    uint8_t,     // (1) channel_id - sensor channel identifier
    uint32_t,    // (2) raw_adc_counts - raw ADC reading
    uint32_t,    // (3) sample_timestamp_ms - embedded timestamp in milliseconds
    uint8_t      // (4) status_flags - status/health flags
>;

} // namespace sensor
} // namespace messages
using comms::CommsMessage;
} // namespace comms

#endif // DAQ_SENSOR_MESSAGES_HPP

