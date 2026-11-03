#ifndef DAQ_T7_MESSAGES_HPP
#define DAQ_T7_MESSAGES_HPP

#include <array>
#include <cstdint>

#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace sensor {

/**
 * @brief One LabJack T7 analog-input sample, published by t7_bridge.
 *
 * Same 21-byte shape as the other sensor messages, but the value is volts as a float. LJM
 * returns calibrated volts (LabJack's per-device calibration is applied on the device side of
 * the library), so there are no ADC counts to carry.
 *
 * Layout: u64 timestamp_ns | u8 ain | u8[3] pad | f32 volts | u32 sample_ts_ms | u8 status
 */
using T7RawMessage = CommsMessage<uint64_t,                // (0) timestamp_ns — epoch ns
                                  uint8_t,                 // (1) ain — AIN number on the T7
                                  std::array<uint8_t, 3>,  // (2) padding
                                  float,                   // (3) volts
                                  uint32_t,  // (4) sample_ts_ms — ms since stream start
                                  uint8_t    // (5) status — 0 = ok
                                  >;

}  // namespace sensor
}  // namespace messages
}  // namespace comms

#endif  // DAQ_T7_MESSAGES_HPP
