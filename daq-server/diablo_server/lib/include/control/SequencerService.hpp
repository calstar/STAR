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
    /** Resolve-free overload. Internal callers use this so a state never round-trips through its
     *  own name, which is what let a rename refuse the fire timer's expiry transition. */
    bool transitionTo(State to);

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

    // Elodin connection retry. sensor-actuator.service is started alongside sensor-elodin, so the
    // first connect can lose the race by milliseconds; without this the service runs forever with
    // no db and every valve reads "undefined".
    static constexpr int kElodinRetrySeconds = 5;
    std::string elodin_host_ = "127.0.0.1";
    uint16_t elodin_port_ = 2240;
    std::thread elodin_retry_thread_;
    std::atomic<bool> elodin_retry_stop_{false};

    // Abort states where AbortBroadcaster should fire
    static bool isAbortState(State s);

    // Publish current state + allowed transitions to Elodin [0x50, 0x00]
    void publishState();
    // Publish raw state transition to Elodin [0x43, 0x00] (legacy VTable)
    void publishStateTransition(State from, State to);

    /** Connect to Elodin and do everything that depends on the connection: register the ACT_CMD
     *  VTables, hand the client to the commander, publish initial state. Safe to call repeatedly —
     *  a reconnect must re-register, since the VTables live in the db process. */
    bool tryConnectElodin();
    void startElodinRetry();
    void stopElodinRetry();

    bool loadConfig(const std::string& path);

    /** Send FIRE_START / FIRE_STOP to controller_service. The single place anything tells the
     *  controller the burn gate changed. */
    void notifyControllerFire(bool active);

    // ── Fire semantics, from config ───────────────────────────────────────────
    // Which state fires, and where the timer lands when it expires, are config rather than
    // enumerators. `state_val == 16` in ControllerService and a stringified State::ARMED here were
    // the two places a rename or renumber silently broke ignition.
    State fire_state_{State::FIRE};
    State fire_expiry_state_{State::ARMED};
    std::string controller_host_{"127.0.0.1"};
    uint16_t controller_port_{8000};
};

}  // namespace sequencer
