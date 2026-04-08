#pragma once

#include <atomic>
#include <string>
#include <thread>

#include "control/AbortBroadcaster.hpp"
#include "control/ActuatorCommander.hpp"
#include "control/FireManager.hpp"
#include "control/StateMachine.hpp"
#include "elodin/ElodinClient.hpp"

namespace sequencer {

/**
 * Top-level sequencer service.
 *
 * Owns and wires together:
 *   - StateMachine      — transition validation
 *   - ActuatorCommander — UDP actuator commanding
 *   - AbortBroadcaster  — abort UDP broadcast
 *   - FireManager       — FIRE countdown + controller_service notifications
 *   - ElodinClient      — publishes state + allowed transitions to Elodin DB
 *
 * All external commands arrive via the TCP server in sequencer_main.cpp
 * and are dispatched to the methods below.
 */
class SequencerService {
public:
    SequencerService() = default;
    ~SequencerService();

    /**
     * Load config, CSVs, connect to Elodin.
     * @param config_path  Path to config.toml (falls back to standard locations).
     * @return true on success.
     */
    bool init(const std::string& config_path = "config/config.toml");

    /**
     * Request a state transition by name (e.g. "Fuel Fill").
     * Validates via StateMachine unless debug mode is on.
     * Applies actuators, fires abort/FIRE lifecycle handlers, publishes to Elodin.
     * @return true if transition was accepted and executed.
     */
    bool transitionTo(const std::string& state_name);

    /**
     * Enable or disable debug mode.
     * Debug mode: all state transitions allowed, manual actuator commands accepted.
     */
    bool setDebugMode(bool enabled);

    /**
     * Debug mode only: manual OPEN/CLOSE for one role. Overrides persist until a state
     * transition (which clears overrides and applies the new state's CSV).
     */
    bool manualActuator(const std::string& name, int pos);

    /**
     * Extend the FIRE window (only valid while in FIRE state).
     */
    bool extendFire();

    /**
     * Hot-reload config.toml and CSVs without restarting.
     */
    bool reloadConfig();

    State currentState() const {
        return current_state_.load();
    }
    bool isDebugMode() const {
        return debug_mode_.load();
    }

private:
    StateMachine state_machine_;
    ActuatorCommander actuator_commander_;
    AbortBroadcaster abort_broadcaster_;
    FireManager fire_manager_;
    fsw::elodin::ElodinClient elodin_;

    std::atomic<State> current_state_{State::IDLE};
    std::atomic<bool> debug_mode_{false};

    std::string config_path_;
    std::string config_content_;

    std::thread state_snapshot_thread_;
    std::atomic<bool> state_snapshot_stop_{false};

    // Abort states where AbortBroadcaster should fire
    static bool isAbortState(State s);

    // Publish current state + allowed transitions to Elodin [0x50, 0x00]
    void publishState();
    // Publish raw state transition to Elodin [0x43, 0x00] (legacy VTable)
    void publishStateTransition(State from, State to);
    /** 1 Hz CONTROLLER.state rows (from=to=current) so exports/GUI have a dense system-state stream. */
    void startStateSnapshotPublisher();

    bool loadConfig(const std::string& path);
};

}  // namespace sequencer
