#ifndef VALVE_CONTROL_MESSAGE_HPP
#define VALVE_CONTROL_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Valve Control Message
 *
 * Contains valve position, commands, and status for individual valves
 */
using ValveControlMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                        uint8_t,    // (1) valve_id - valve identifier
                        uint8_t,    // (2) valve_type - ValveType enum (motor/solenoid)
                        double,     // (3) commanded_position (0-1) - commanded position
                        double,     // (4) actual_position (0-1) - actual position from encoder
                        double,     // (5) position_error - position error
                        double,     // (6) velocity (1/s) - current velocity
                        double,     // (7) current (A) - motor current
                        double,     // (8) temperature (°C) - motor temperature
                        double,     // (9) rate_limit (1/s) - position rate limit
                        bool,       // (10) emergency_close - emergency close flag
                        bool,       // (11) fault_detected - fault status
                        uint8_t,    // (12) valve_state - ValveState enum
                        double,     // (13) command_confidence (0-1) - command confidence
                        uint64_t>;  // (14) time_monotonic (ns) - monotonic timestamp

// Function to set valve control measurements
static void set_valve_control_measurement(
    ValveControlMessage& message, double timestamp, uint8_t valve_id, uint8_t valve_type,
    double commanded_position, double actual_position, double position_error, double velocity,
    double current, double temperature, double rate_limit, bool emergency_close,
    bool fault_detected, uint8_t valve_state, double command_confidence, uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(valve_id);
    message.setField<2>(valve_type);
    message.setField<3>(commanded_position);
    message.setField<4>(actual_position);
    message.setField<5>(position_error);
    message.setField<6>(velocity);
    message.setField<7>(current);
    message.setField<8>(temperature);
    message.setField<9>(rate_limit);
    message.setField<10>(emergency_close);
    message.setField<11>(fault_detected);
    message.setField<12>(valve_state);
    message.setField<13>(command_confidence);
    message.setField<14>(time_monotonic);
}

static ValveControlMessage generateTestMessageValveControl() {
    ValveControlMessage message;
    set_valve_control_measurement(message, 0.0, 1, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 25.0, 0.5, false,
                                  false, 0, 1.0, 0);
    return message;
}

#endif  // VALVE_CONTROL_MESSAGE_HPP
