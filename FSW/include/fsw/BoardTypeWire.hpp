#ifndef FSW_BOARD_TYPE_WIRE_HPP
#define FSW_BOARD_TYPE_WIRE_HPP

#include <cstdint>

namespace fsw {
namespace daq_wire {

/** Legacy DAQv2 wire numeric board_type (Elodin / discovery); heartbeat body no longer carries type. */
constexpr uint8_t kUnknown = 0;
constexpr uint8_t kPressureTransducer = 1;
constexpr uint8_t kLoadCell = 2;
constexpr uint8_t kRtd = 3;
constexpr uint8_t kThermocouple = 4;
constexpr uint8_t kActuator = 5;

}  // namespace daq_wire
}  // namespace fsw

#endif
