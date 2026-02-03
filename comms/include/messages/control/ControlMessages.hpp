#ifndef DAQ_CONTROL_MESSAGES_HPP
#define DAQ_CONTROL_MESSAGES_HPP

#include <cstdint>
#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace control {

// Import CommsMessage from parent namespace
using comms::CommsMessage;

/**
 * @brief Actuator command message
 * 
 * Contains commands sent to actuators (valves, igniters, etc.).
 */
using ActuatorCommandMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp
    uint8_t,     // (1) actuator_id - Actuator identifier
    uint8_t,     // (2) command_type - Command type (OPEN, CLOSE, PULSE, etc.)
    float,       // (3) value - Command value (duration, duty cycle, etc.)
    uint8_t      // (4) status - Command status/acknowledgment
>;

/**
 * @brief Control state message
 * 
 * Contains current control system state (PID terms, setpoints, etc.).
 */
using ControlStateMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp
    double,      // (1) setpoint_x - X-axis setpoint
    double,      // (2) setpoint_y - Y-axis setpoint
    double,      // (3) setpoint_z - Z-axis setpoint
    double,      // (4) pid_p_x - X-axis proportional term
    double,      // (5) pid_i_x - X-axis integral term
    double,      // (6) pid_d_x - X-axis derivative term
    double,      // (7) pid_p_y - Y-axis proportional term
    double,      // (8) pid_i_y - Y-axis integral term
    double,      // (9) pid_d_y - Y-axis derivative term
    double,      // (10) pid_p_z - Z-axis proportional term
    double,      // (11) pid_i_z - Z-axis integral term
    double       // (12) pid_d_z - Z-axis derivative term
>;

} // namespace control
} // namespace messages
using comms::CommsMessage;
} // namespace comms

#endif // DAQ_CONTROL_MESSAGES_HPP

