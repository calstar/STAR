#pragma once

#include <atomic>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "control/StateMachine.hpp"
#include "elodin/ElodinClient.hpp"

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
    int board_id{0};       // Board ID (e.g. 11, 12, 13, 14)
    std::string board_ip;  // IP of the board that owns this actuator
    bool is_no{false};     // Normally Open: invert the logical position
    bool is_pwm{false};    // PWM type: sequencer skips in FIRE state
};

/**
 * Sends UDP actuator commands based on state transitions.
 * Manages the continuous re-send loop (~10 Hz). Debug mode: manual overrides apply until
 * cleared (Sequencer clears them on every state transition so the CSV wins when changing state).
 *
 * Thread-safe: applyForState, setManualOverride, clearAllManualOverrides, stopContinuousLoop.
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
    /**
     * Command every actuator for `state`.
     *
     * `is_transition` selects between the two things this does. On an actual state change it runs
     * the CSV's per-actuator delays as a staged schedule; on the 1 Hz republish it sends the
     * settled (final) positions with no delay. Without that split the republish would re-arm every
     * pending delay once a second and the schedule would never finish.
     */
    void applyForState(State state, bool is_transition = false);

    /**
     * Start the 1 Hz continuous re-send loop for the given state.
     * Stops any previously running loop first.
     */
    /** `allow_delays` false makes the entry apply immediately — used for abort states, which must
     *  not sit behind a delay. */
    void startContinuousLoop(State state, bool allow_delays = true);

    /** Stop the continuous re-send loop (blocks until the thread exits). */
    void stopContinuousLoop();

    /** Send one UDP packet for a single role (debug manual command). */
    bool sendSingleActuator(const std::string& name, int pos);

    /** Debug: hold this logical position for the role until cleared or state transition. */
    void setManualOverride(const std::string& name, int pos);

    /** Clear all manual overrides (e.g. leaving debug mode or transitioning state). */
    void clearAllManualOverrides();

    /** Set the Elodin client for publishing commanded state [0x32, ch] to the DB. */
    /**
     * Which state hands PWM actuators to controller_service. During it this commander stops
     * commanding PWM roles entirely, so exactly one thing drives them during a burn. Was the
     * State::FIRE enumerator; now follows [fire] state like every other fire decision.
     */
    void setFireState(State s) {
        fire_state_ = s;
    }

    void setElodinClient(fsw::elodin::ElodinClient* client) {
        elodin_ = client;
    }

    /** Publish initial de-energized state for all actuators to Elodin DB [0x32].
     *  Does NOT send UDP commands — only populates the DB so the frontend has data on startup. */
    void publishInitialState();

    bool isLoaded() const {
        return loaded_;
    }

private:
    std::map<std::string, ActuatorRole> roles_;
    /** state -> actuator -> delay in seconds, from state_machine_actuator_delays.csv. */
    std::map<std::string, std::map<std::string, double>> state_actuator_delays_;
    /** Bumped on every transition so an in-flight delayed stage from the previous state aborts
     *  instead of landing after we have already moved on. */
    State fire_state_{State::FIRE};
    std::atomic<uint64_t> schedule_gen_{0};
    /** Roles whose delayed stage has not fired yet. The 1 Hz republish skips these: the board holds
     *  its last commanded position, which is exactly the pre-transition value we want it to keep
     *  until the delay elapses. Without this the republish would send the settled position first
     *  and any delay longer than the republish period could never be observed. */
    std::set<std::string> pending_roles_;
    std::mutex pending_roles_mutex_;
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
    fsw::elodin::ElodinClient* elodin_{nullptr};

    // Resolve state name case-insensitively. Returns end() if not found.
    std::map<std::string, std::map<std::string, int>>::const_iterator findStateActuators(
        const std::string& state_name) const;

    // Build and send one UDP actuator command packet to a board.
    /** Send to every board with the retransmits interleaved, so boards stay in step. */
    bool sendBatch(const std::map<std::string, std::vector<std::pair<uint8_t, uint8_t>>>& by_board);
    bool sendUDP(const std::string& board_ip,
                 const std::vector<std::pair<uint8_t, uint8_t>>& id_state_pairs);

    // Publish commanded actuator state [0x32, global_channel] to Elodin DB.
    // global_channel encodes board + local channel to avoid collisions across boards.
    void publishCommandedState(uint8_t global_channel, uint8_t logical_pos);
};

}  // namespace sequencer
