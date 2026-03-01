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
using ControllerDiagnosticsMessage =
    CommsMessage<uint64_t,  // (0) timestamp_ns - monotonic timestamp
                 double,    // (1) F_ref - Reference thrust [N]
                 double,    // (2) MR_ref - Reference mixture ratio
                 double,    // (3) F_estimated - Estimated thrust [N]
                 double,    // (4) MR_estimated - Estimated mixture ratio
                 double,    // (5) P_ch - Chamber pressure [Pa]
                 double,    // (6) cost - Controller cost function value
                 uint8_t,   // (7) safety_filtered - Safety filter active (0/1)
                 uint8_t,   // (8) cutoff_active - Supervisory cutoff active (0/1)
                 int32_t    // (9) solver_iters - DDP solver iterations
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
