#ifndef CALIBRATED_PT_MESSAGE_HPP
#define CALIBRATED_PT_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace sensor {

/**
 * @brief Calibrated Pressure Transducer message for Elodin
 *
 * Contains both raw ADC counts and calibrated pressure in PSI.
 * This message is published alongside RawPTMessage for calibrated sensors.
 *
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + float (4) + uint32_t (4) + uint8_t (1) = 21
 * bytes
 */
using CalibratedPTMessage =
    CommsMessage<uint64_t,                // (0) timestamp_ns - monotonic timestamp in nanoseconds
                 uint8_t,                 // (1) channel_id - sensor channel identifier
                 std::array<uint8_t, 3>,  // (2) padding - 3 bytes to align float to 4-byte boundary
                 float,     // (3) calibrated_pressure_psi - calibrated pressure in PSI
                 uint32_t,  // (4) raw_adc_counts - raw ADC reading (for reference)
                 uint8_t    // (5) calibration_status - 0=uncalibrated, 1=calibrated
                 >;

}  // namespace sensor
}  // namespace messages
}  // namespace comms

#endif  // CALIBRATED_PT_MESSAGE_HPP



