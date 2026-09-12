#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "config/Config.hpp"
#include "control/AbortBroadcaster.hpp"
#include "control/ActuatorCommander.hpp"
#include "control/HoldTimer.hpp"
#include "control/StateMachine.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

// Only referenced by const&, so a forward declaration keeps the whole config header out of every
// translation unit that includes this one.
namespace fsw {
namespace config {
struct Config;
}
}  // namespace fsw

namespace sequencer {

/**
 * Top-level sequencer service.
 *
 * Owns and wires together:
 *   - StateMachine      — transition validation
 *   - ActuatorCommander — UDP actuator commanding
 *   - AbortBroadcaster  — abort UDP broadcast
 *   - HoldTimer         — the timed hold (FIRE countdown) + controller notifications
 *   - ElodinClient      — publishes state + allowed transitions to Elodin DB
 *
 * All external commands arrive via the TCP server in sequencer_main.cpp
 * and are dispatched to the methods below.
 *
 * ── Threading contract ──────────────────────────────────────────────────────
 * Every public command method is a thin wrapper that puts work on cmd_queue_ and waits for the
 * single worker thread (commandLoop) to run it. **Exactly one thread is ever inside the state
 * machine.** Callers may come from anywhere: the TCP command path, and the FireManager timer
 * thread when a burn expires.
 *
 * This replaced a design where nothing was serialized at all. Individual fields were atomic,
 * but a transition is a seven-step sequence built out of them — stop the republish loop, apply
 * actuators, restart the loop, assign the state, arm the burn — and making each step atomic does
 * nothing for the sequence. Two threads interleaving it could move-assign onto a still-joinable
 * std::thread, which is a std::terminate: the sequencer died outright if an operator aborted at
 * the moment the fire timer expired.
 *
 * A mutex was the obvious fix and does not work here. An operator thread holding it calls
 * fire_manager_.stop(), which joins the timer thread — while the timer thread is inside its
 * expiry callback waiting for that same mutex. A recursive_mutex does not help; the re-entry is
 * cross-thread. A queue sidesteps it entirely: the timer thread never *enters* the state
 * machine, it posts a request and returns immediately (see kDetached below).
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
    bool transitionTo(const std::string& state_name, uint32_t requested_hold_ms,
                      std::string* refusal_reason = nullptr);
    /** Resolve-free overload. Internal callers use this so a state never round-trips through its
     *  own name, which is what let a rename refuse the fire timer's expiry transition. */
    bool transitionTo(State to);

    /**
     * Transition, optionally overriding the target state's hold with a client-supplied window.
     *
     * `requested_hold_ms` of 0 means "none supplied" — the state's configured default is used, and
     * this is the form every internal caller uses. A non-zero value is only honoured for a state
     * whose hold rule is marked gui_settable, which the burn state never is; anything else is
     * REFUSED WITHOUT TRANSITIONING. That last part is the point: a client that queues a command,
     * disconnects and has it replayed on reconnect must end up where it started, not in a hold it
     * cannot be talked out of.
     *
     * @param refusal_reason optional; on a false return, set to a short phrase suitable for a
     *        protocol reply. One validation, one wording — the TCP layer does not get its own copy
     *        of these rules to drift out of step with.
     */
    bool transitionTo(State to, uint32_t requested_hold_ms, std::string* refusal_reason = nullptr);

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

    State currentState() const {
        return current_state_.load();
    }
    bool isDebugMode() const {
        return debug_mode_.load();
    }

private:
    // ── Command queue ─────────────────────────────────────────────────────────
    struct Command {
        std::function<bool()> fn;
        // Null for a detached (fire-and-forget) command. shared_ptr so the worker can still
        // fulfil the promise after a caller has given up waiting on its future.
        std::shared_ptr<std::promise<bool>> result;
    };

    std::deque<Command> cmd_queue_;
    std::mutex cmd_mutex_;
    std::condition_variable cmd_cv_;
    std::thread cmd_thread_;
    std::atomic<bool> cmd_stop_{false};

    /** How long a caller waits for its command to run before giving up and reporting failure.
     *  Generous: the point is that a wedged worker cannot pin every TCP thread forever, not to
     *  impose a deadline on normal work (a transition is milliseconds). */
    static constexpr int kCommandTimeoutSeconds = 10;

    void commandLoop();
    /** Post work and block until the worker has run it. Returns false if the service is shutting
     *  down or the worker did not get to it within kCommandTimeoutSeconds. */
    bool enqueueAndWait(std::function<bool()> fn);
    /** Post work and return immediately. Used by the fire-expiry callback: waiting there would
     *  reintroduce the join deadlock described above. */
    void enqueueDetached(std::function<bool()> fn);

    // Worker-thread bodies. These hold the real logic and must only ever run on cmd_thread_ —
    // they assume single-threaded access to the state machine and the actuator tables.
    bool doTransitionTo(State to, uint32_t requested_hold_ms = 0,
                        std::string* refusal_reason = nullptr);
    bool doSetDebugMode(bool enabled);
    bool doManualActuator(const std::string& name, int pos);
    bool doExtendFire();

    /**
     * One state's timed hold: how long, where it lands, and whether a client may set the length.
     *
     * Assembled from config at load. Exactly two things create entries — [fire] and [flow] — and
     * `gui_settable` is written as a literal in both places rather than read from config, so no
     * config edit can make a burn window client-settable.
     */
    struct HoldRule {
        uint32_t default_ms = 0;
        uint32_t max_ms = 0;
        /** What EXTEND_FIRE restarts at. 0 makes the hold a fixed window. */
        uint32_t extended_ms = 0;
        State return_state = State::UNKNOWN;
        bool gui_settable = false;
        /**
         * Milliseconds the gate actuator waits after the transition before it opens, from the
         * delays CSV. The hold runs for (this + the requested duration), so the requested duration
         * is what the GATE VALVE is open for rather than what the STATE is held for. 0 when the
         * state opens everything at once.
         */
        uint32_t gate_open_delay_ms = 0;
        /**
         * The same actuator's delay in the RETURN state's column. The valve does not close at the
         * expiry transition either — it closes that much after it, so a stagger on the way out
         * lengthens the open window exactly as a stagger on the way in shortens it.
         */
        uint32_t gate_close_delay_ms = 0;
        std::string gate_actuator;
    };

    StateMachine state_machine_;
    ActuatorCommander actuator_commander_;
    AbortBroadcaster abort_broadcaster_;
    HoldTimer hold_timer_;
    fsw::elodin::ElodinClient elodin_;

    std::atomic<State> current_state_{State::IDLE};
    std::atomic<bool> debug_mode_{false};

    /** Holdable states, by target. Rebuilt on every config load; read on the transition path.
     *  RELOAD_CONFIG runs on a TCP handler thread while a transition may be running on another,
     *  hence the mutex. */
    std::map<State, HoldRule> hold_rules_;
    mutable std::mutex config_mutex_;

    std::string config_path_;
    std::string config_content_;

    /** Local address board-facing UDP leaves from, resolved once in init(). "0.0.0.0" means the
     *  host has no NIC on the board subnet (a dev box) and traffic stays unpinned. */
    std::string daq_bind_address_{"0.0.0.0"};

    /** Delay between ABORT and ABORT_DONE. Was an AbortBroadcaster ctor default; kept here beside
     *  the other fire/abort timings until a config key is wanted for it. */
    static constexpr uint32_t kAbortDoneDelayMs = 3000;

    // Actuator boards as they were at init(). Held so an Elodin reconnect can re-register the
    // VTables without re-reading config.toml — config is frozen for the life of a run.
    std::vector<fsw::elodin::BoardChannels> actuator_boards_;

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

    /**
     * Everything a config load has to apply, in the one order that works.
     *
     * Separate from init() so that order is stated once. It has to be exact: [[states]] is adopted
     * before anything resolves a state name, both CSVs are parsed against that table, and [fire] is
     * resolved last, against the same table rather than the compiled enum.
     */
    bool applyConfig(const fsw::config::Config& cfg);

    /** Send FIRE_START / FIRE_STOP to controller_service. The single place anything tells the
     *  controller the burn gate changed. Retries once if the first attempt is not acknowledged. */
    void notifyControllerFire(bool active);

    /** One attempt: connect, send, wait for the controller's "OK". Returns whether it was
     *  acknowledged — a successful send() is not evidence of delivery, since the kernel buffers
     *  for an application that may never read. */
    bool notifyControllerFireOnce(bool active);

    // ── Fire semantics, from config ───────────────────────────────────────────
    // Which state fires, and where the timer lands when it expires, are config rather than
    // enumerators. `state_val == 16` in ControllerService and a stringified State::ARMED here were
    // the two places a rename or renumber silently broke ignition.
    // Default to UNKNOWN, not a compiled Fire/Armed: an absent or misnamed [fire] entry leaves the
    // fire timer disabled (UNKNOWN never matches a real state in transitionTo's `to ==
    // fire_state_`) rather than silently attaching the burn to whatever state now holds the old
    // literal id.
    State fire_state_{State::UNKNOWN};
    State fire_expiry_state_{State::UNKNOWN};
    // The burn window, from [fire]. Held here rather than on the timer because a duration that
    // lives on the timer behind a setter is one a reload can forget to refresh — which is exactly
    // what happened. HoldTimer takes it per start() instead.
    uint32_t fire_duration_ms_{6000};
    uint32_t fire_extended_ms_{10000};
    std::string controller_host_{"127.0.0.1"};
    uint16_t controller_port_{8000};
    /** [controller_service].sequencer_owns_valves. When true the fire hold is given no notifier at
     *  all, so there is no FIRE_START to suppress and no flag to forget to check. */
    bool sequencer_owns_valves_{false};
};

}  // namespace sequencer
