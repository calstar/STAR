#ifndef CALIBRATED_SENSOR_MESSAGES_HPP
#define CALIBRATED_SENSOR_MESSAGES_HPP

#include <array>
#include <cstdint>

#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace sensor {

// ── CalibratedPTMessage already in CalibratedPTMessage.hpp ──────────────

/**
 * @brief Calibrated Thermocouple message for Elodin
 *
 * Layout: uint64_t(8) + uint8_t(1) + pad[3](3) + float(4) + uint32_t(4) + uint8_t(1) = 21 bytes
 */
using CalibratedTCMessage = CommsMessage<uint64_t,                // (0) timestamp_ns
                                         uint8_t,                 // (1) channel_id
                                         std::array<uint8_t, 3>,  // (2) padding
                                         float,  // (3) calibrated_temperature_c — degrees Celsius
                                         uint32_t,  // (4) raw_adc_counts — for reference
                                         uint8_t    // (5) calibration_status — 0=uncal, 1=cal
                                         >;

/**
 * @brief Calibrated RTD message for Elodin
 *
 * Layout: uint64_t(8) + uint8_t(1) + pad[3](3) + float(4) + uint32_t(4) + uint8_t(1) = 21 bytes
 */
using CalibratedRTDMessage = CommsMessage<uint64_t,                // (0) timestamp_ns
                                          uint8_t,                 // (1) channel_id
                                          std::array<uint8_t, 3>,  // (2) padding
                                          float,  // (3) calibrated_temperature_c — degrees Celsius
                                          uint32_t,  // (4) raw_resistance_counts — for reference
                                          uint8_t    // (5) calibration_status — 0=uncal, 1=cal
                                          >;

/**
 * @brief Calibrated Load Cell message for Elodin
 *
 * Layout: uint64_t(8) + uint8_t(1) + pad[3](3) + float(4) + uint32_t(4) + uint8_t(1) = 21 bytes
 */
using CalibratedLCMessage = CommsMessage<uint64_t,                // (0) timestamp_ns
                                         uint8_t,                 // (1) channel_id
                                         std::array<uint8_t, 3>,  // (2) padding
                                         float,  // (3) calibrated_force_lbf — force in pounds-force
                                         uint32_t,  // (4) raw_adc_counts — for reference
                                         uint8_t    // (5) calibration_status — 0=uncal, 1=cal
                                         >;

}  // namespace sensor
}  // namespace messages
}  // namespace comms

#endif  // CALIBRATED_SENSOR_MESSAGES_HPP
