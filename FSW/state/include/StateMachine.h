#ifndef STATE_MACHINE_H
#define STATE_MACHINE_H

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>

#include "../../comms/include/Timer.hpp"
#include "../../utl/Elodin.hpp"
#include "../comms/include/StateMachineMessage.hpp"
#include "../comms/include/mfNavigationMessage.hpp"
#include "../include/Config.h"
#include "../include/DiabloGlobals.h"

/**
 * @brief State Machine subsystem for DiabloAvionics FSW
 *
 * Manages engine operational modes and state transitions based on sensor
 * inputs and navigation state. Follows the reference FSW pattern.
 */
class StateMachine {
public:
    StateMachine();

    // Initialize the state machine with configuration
    void initialize(Config::StateMachineConfig config);

    // Update the state machine (run state transitions)
    void update();

    // Set engine mode to abort
    void abort();

private:
    EngineMode currentMode;

    // State machine loop time in nanoseconds
    uint64_t state_machine_loop_time_ns;

    // Abort conditions
    double abort_pressure_threshold;     // Pressure threshold to abort (Pa)
    double abort_temperature_threshold;  // Temperature threshold to abort (°C)
    uint64_t abort_cutoff_time;          // Time since launch to abort (ns)

    // Critical times
    uint64_t current_time;  // nanoseconds; Current time
    uint64_t pad_time;      // nanoseconds; Pad time = zero starts when State Machine is initialized
    uint64_t pad_time_shift;  // nanoseconds; When state machine is initialized, current_time =
                              // pad_time_shift

    bool abort_flag;

    // Check for switch conditions
    bool checkForAbort();
    bool checkForPreIgnition();
    bool checkForIgnition();
    bool checkForStartup();
    bool checkForSteadyState();
    bool checkForShutdown();

    // Transition functions
    void transitionToIdle();
    void transitionToPreIgnition();
    void transitionToIgnition();
    void transitionToStartup();
    void transitionToSteadyState();
    void transitionToShutdown();
    void transitionToAbort();

    // Helper to get current navigation state
    mfNavigationMessage getCurrentNavigationMessage() const;

    // Helper to get current PT sensor data
    double getMaxPTPressure() const;
    double getMaxTemperature() const;
};

#endif  // STATE_MACHINE_H
