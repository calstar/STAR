#ifndef DAQ_CONTROLLER_MESSAGES_HPP
#define DAQ_CONTROLLER_MESSAGES_HPP

#include <cstdint>

#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace control {

// Import CommsMessage from parent namespace
using comms::CommsMessage;

/**
 * @brief Controller actuation command message
 *
 * Contains PWM duty cycles and on/off states from RobustDDPController.
 * Written to Elodin DB for logging and replay.
 */
using ControllerActuationMessage =
    CommsMessage<uint64_t,  // (0) timestamp_ns - monotonic timestamp
                 float,     // (1) duty_F - Fuel duty cycle [0,1]
                 float,     // (2) duty_O - Oxidizer duty cycle [0,1]
                 uint8_t,   // (3) u_F_on - Fuel solenoid on/off (0=OFF, 1=ON)
                 uint8_t,   // (4) u_O_on - Oxidizer solenoid on/off (0=OFF, 1=ON)
                 uint8_t    // (5) valid - Command validity flag
                 >;

/**
 * @brief Controller diagnostics message
 *
 * Contains controller internal state and diagnostics for monitoring and replay.
 */
// Field order: U64 + 6xF64 + I32 + 2xU8
// I32 is at byte offset 56 (4-byte aligned); U8s follow at 60, 61.
using ControllerDiagnosticsMessage =
    CommsMessage<uint64_t,  // (0) timestamp_ns   offset=0  (8 bytes)
                 double,    // (1) F_ref           offset=8  (8 bytes)
                 double,    // (2) MR_ref          offset=16 (8 bytes)
                 double,    // (3) F_estimated     offset=24 (8 bytes)
                 double,    // (4) MR_estimated    offset=32 (8 bytes)
                 double,    // (5) P_ch            offset=40 (8 bytes)
                 double,    // (6) cost            offset=48 (8 bytes)
                 int32_t,   // (7) solver_iters    offset=56 (4 bytes, 4-byte aligned)
                 uint8_t,   // (8) safety_filtered offset=60 (1 byte)
                 uint8_t    // (9) cutoff_active   offset=61 (1 byte)
                 >;

/**
 * @brief Controller measurement input message
 *
 * Contains sensor measurements fed to the controller.
 * Written to DB for replay/debugging.
 */
using ControllerMeasurementMessage =
    CommsMessage<uint64_t,  // (0) timestamp_ns - monotonic timestamp
                 double,    // (1) P_copv - COPV pressure [Pa]
                 double,    // (2) P_reg - Regulator pressure [Pa]
                 double,    // (3) P_u_fuel - Fuel upstream pressure [Pa]
                 double,    // (4) P_u_ox - Oxidizer upstream pressure [Pa]
                 double,    // (5) P_d_fuel - Fuel downstream pressure [Pa]
                 double     // (6) P_d_ox - Oxidizer downstream pressure [Pa]
                 >;

}  // namespace control
}  // namespace messages
}  // namespace comms

#endif  // DAQ_CONTROLLER_MESSAGES_HPP
