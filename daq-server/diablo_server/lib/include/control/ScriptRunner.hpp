#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "control/ScriptStates.hpp"

namespace sequencer {

/**
 * What a running script is allowed to do to the world.
 *
 * Everything the interpreter can reach is a callback supplied by its owner, so the language has no
 * way to touch anything that was not handed to it — and so the whole runner is testable against
 * recording stubs, with no sockets and no boards.
 */
struct ScriptEnv {
    /** Command one valve by canonical config name. Expected to set the script position AND send
     *  immediately, exactly as debug manual control does. */
    std::function<void(const std::string& role, int pos)> set_valve;

    /**
     * Leave the state. TERMINAL: the runner unwinds its whole stack after calling this and the
     * thread exits.
     *
     * The owner must post this rather than perform it inline — the worker that handles the
     * transition joins this thread, so doing the transition synchronously from here is a
     * guaranteed deadlock (the same one documented for the fire timer's expiry callback).
     */
    std::function<void(State target)> transition;

    /**
     * Read a calibrated pressure by canonical role name.
     *
     * Returns false when the value must not be acted on — no reading yet, too old, or flagged
     * uncalibrated. The script then FAILS rather than proceeding on a stand-in number: an
     * uncalibrated PT publishes a smooth, plausible 0.0 PSI, and a "cycle until 90% of COPV" loop
     * reading zero computes a target of zero and does nothing at all, successfully.
     */
    std::function<bool(const std::string& role, double& psi)> read_pressure;

    /** Where the script's log lines are attributed. */
    std::string state_name;
};

/**
 * Runs one dynamic state's script on its own thread.
 *
 * Modelled on HoldTimer, and for its reasons rather than by analogy:
 *
 *  - **Its own thread.** It must not run on the command worker. That worker serialises every
 *    command through one queue, so a 30 s script executing there would block every TRANSITION,
 *    ACTUATOR and abort for its whole runtime, and the command timeout would start firing on
 *    ordinary operator input.
 *
 *  - **wait_until on a steady_clock deadline**, never sleep_for. HoldTimer records why: its
 *    predecessor counted sleep *calls* and overshot in one direction every iteration. A loop body
 *    with a delay(0.2) compounds exactly that error, a hundred times over.
 *
 *  - **The program is passed by value into start()**, never stored on the runner. A duration that
 *    lives behind a setter is one a reload can forget to refresh, which is how a burn once ran the
 *    previous config's window.
 *
 *  - **stop() is idempotent, reaps the thread, and fires no completion callback.** Cancellation is
 *    not an ending the script gets to react to.
 *
 * The stop flag is checked at every statement boundary, inside every wait, and at the top of every
 * loop iteration, so a transition or an abort preempts a running script in well under a
 * millisecond rather than at the next statement.
 *
 * Because it owns a thread, the interpreter is a plain recursive tree walk — the thread IS the
 * continuation. No resumable VM, no stepped scheduler.
 */
class ScriptRunner {
public:
    using Clock = std::chrono::steady_clock;

    ScriptRunner() = default;
    ~ScriptRunner();

    ScriptRunner(const ScriptRunner&) = delete;
    ScriptRunner& operator=(const ScriptRunner&) = delete;

    /** Begin running `ds`. Supersedes anything already running (which is stopped first). */
    void start(const DynamicState& ds, ScriptEnv env);

    /**
     * Cancel and reap. Safe when nothing is running, and safe to call from the transition the
     * script itself requested — that path detaches rather than self-joining, which would be a
     * std::terminate.
     */
    void stop();

    bool isActive() const {
        return active_.load();
    }

    /** Seconds since start(), which is what elapsed() reports. 0 when not running. */
    double elapsedSeconds() const;

private:
    void run(DynamicState ds, ScriptEnv env);

    mutable std::mutex mtx_;
    std::condition_variable cv_;
    std::thread thread_;
    std::atomic<bool> active_{false};
    std::atomic<bool> stop_{false};
    Clock::time_point started_at_{};
};

}  // namespace sequencer
