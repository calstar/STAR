#pragma once

#include <atomic>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "control/StateMachine.hpp"

namespace sequencer {

/**
 * Config entry for one named actuator role loaded from config.toml [actuator_roles].
 *
 * Format in config.toml:  role_name = ["TYPE", channel, board_id]
 *   TYPE:  "NC"  — normally closed (logical pos = hw state)
 *          "NO"  — normally open   (logical pos inverted for hw: 0→hw1, 1→hw0)
 *          "PWM" — controlled by controller_service, not by sequencer (skipped in FIRE)
 */
struct ActuatorRole {
    int channel{0};        // 1-based actuator ID on the board
    std::string board_ip;  // IP of the board that owns this actuator
    bool is_no{false};     // Normally Open: invert the logical position
    bool is_pwm{false};    // PWM type: sequencer skips in FIRE state
};

/**
 * Sends UDP actuator commands based on state transitions.
 * Manages the continuous re-send loop (1 Hz) and manual overrides for debug mode.
 *
 * Thread-safe: applyForState, setManualOverride, clearManualOverride, stopContinuousLoop
 * may be called from multiple threads.
 */
class ActuatorCommander {
public:
    /**
     * Load actuator roles from config content and state→actuator map from CSV.
     * @param config_content  Raw config.toml file contents (already read).
     * @param csv_path        Path to state_machine_actuators.csv (with fallbacks).
     * @return true on success.
     */
    bool load(const std::string& config_content, const std::string& csv_path);

    /**
     * Send actuator commands for the given state (one shot).
     * Groups commands by board IP, sends one UDP packet per board.
     * PWM actuators are skipped in FIRE state.
     */
    void applyForState(State state);

    /**
     * Start the 1 Hz continuous re-send loop for the given state.
     * Stops any previously running loop first.
     */
    void startContinuousLoop(State state);

    /** Stop the continuous re-send loop (blocks until the thread exits). */
    void stopContinuousLoop();

    /**
     * Send a single actuator command by role name (for debug manual override).
     * @param name  Role name (e.g. "LOX Main").
     * @param pos   0 = closed, 1 = open.
     * @return true if sent successfully.
     */
    bool sendSingleActuator(const std::string& name, int pos);

    /**
     * Register a manual override for a role (debug mode).
     * The continuous loop will hold this value instead of the state-default.
     */
    void setManualOverride(const std::string& name, int pos);

    /** Clear a specific manual override; continuous loop returns to state-default. */
    void clearManualOverride(const std::string& name);

    /** Clear all manual overrides. */
    void clearAllManualOverrides();

    bool isLoaded() const {
        return loaded_;
    }

private:
    std::map<std::string, ActuatorRole> roles_;
    // CSV: state_name → { actuator_name → logical_pos (0 or 1) }
    std::map<std::string, std::map<std::string, int>> state_actuators_;

    std::map<std::string, int> manual_overrides_;
    std::mutex overrides_mutex_;

    std::thread loop_thread_;
    std::atomic<bool> loop_running_{false};
    State loop_state_{State::IDLE};

    std::string bind_addr_{"0.0.0.0"};
    uint16_t actuator_port_{5005};
    bool loaded_{false};

    // Resolve state name case-insensitively. Returns end() if not found.
    std::map<std::string, std::map<std::string, int>>::const_iterator findStateActuators(
        const std::string& state_name) const;

    // Build and send one UDP actuator command packet to a board.
    bool sendUDP(const std::string& board_ip,
                 const std::vector<std::pair<uint8_t, uint8_t>>& id_state_pairs);
};

}  // namespace sequencer
