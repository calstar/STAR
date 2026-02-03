#ifndef ENGINE_CONTROL_MESSAGE_HPP
#define ENGINE_CONTROL_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Engine Control System Message
 *
 * Contains engine control state, valve commands, and performance metrics
 */
using EngineControlMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                   uint8_t,    // (1) engine_phase - EnginePhase enum
                   double,     // (2) thrust_demand (N) - commanded thrust
                   double,     // (3) thrust_actual (N) - actual thrust
                   double,     // (4) chamber_pressure (Pa) - chamber pressure
                   double,     // (5) mixture_ratio_demand - commanded O/F ratio
                   double,     // (6) mixture_ratio_actual - actual O/F ratio
                   double,     // (7) fuel_valve_position (0-1) - fuel valve position
                   double,     // (8) ox_valve_position (0-1) - oxidizer valve position
                   double,     // (9) fuel_flow_rate (kg/s) - fuel mass flow rate
                   double,     // (10) ox_flow_rate (kg/s) - oxidizer mass flow rate
                   double,     // (11) specific_impulse (s) - Isp
                   double,     // (12) efficiency - overall efficiency (0-1)
                   bool,       // (13) ignition_confirmed - ignition status
                   bool,       // (14) all_systems_go - system health status
                   uint64_t>;  // (15) time_monotonic (ns) - monotonic timestamp

// Function to set engine control measurements
static void set_engine_control_measurement(
    EngineControlMessage& message, double timestamp, uint8_t engine_phase, double thrust_demand,
    double thrust_actual, double chamber_pressure, double mixture_ratio_demand,
    double mixture_ratio_actual, double fuel_valve_position, double ox_valve_position,
    double fuel_flow_rate, double ox_flow_rate, double specific_impulse, double efficiency,
    bool ignition_confirmed, bool all_systems_go, uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(engine_phase);
    message.setField<2>(thrust_demand);
    message.setField<3>(thrust_actual);
    message.setField<4>(chamber_pressure);
    message.setField<5>(mixture_ratio_demand);
    message.setField<6>(mixture_ratio_actual);
    message.setField<7>(fuel_valve_position);
    message.setField<8>(ox_valve_position);
    message.setField<9>(fuel_flow_rate);
    message.setField<10>(ox_flow_rate);
    message.setField<11>(specific_impulse);
    message.setField<12>(efficiency);
    message.setField<13>(ignition_confirmed);
    message.setField<14>(all_systems_go);
    message.setField<15>(time_monotonic);
}

static EngineControlMessage generateTestMessageEngineControl() {
    EngineControlMessage message;
    set_engine_control_measurement(message, 0.0, 0, 0.0, 0.0, 101325.0, 6.0, 6.0, 0.0, 0.0, 0.0,
                                   0.0, 0.0, 0.0, false, false, 0);
    return message;
}

#endif  // ENGINE_CONTROL_MESSAGE_HPP
