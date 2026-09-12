#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace sequencer {

/**
 * What one hold is: how long, and who to tell.
 *
 * The durations arrive here rather than living on the timer as members. That is deliberate --
 * FireManager carried them in `fire_duration_ms_` behind a `configure()` setter documented "call
 * before start()", and reloadConfig() was exactly the caller that forgot, so a burn silently ran
 * the previous config's window. A number that is passed in cannot go stale.
 */
struct HoldSpec {
    /** How long to hold, in milliseconds. */
    uint32_t duration_ms = 0;
    /** What extend() restarts the countdown at, measured from the extend call. 0 refuses extend()
     *  entirely -- a characterization pulse has a duration the operator asked for, and stretching
     *  it silently would make the mass they weighed describe a different window. */
    uint32_t extended_ms = 0;
    /** Called when the hold ends of its own accord. Not called when stop() cancels it. */
    std::function<void()> on_expire;
    /** true when the hold begins, false when it ends by any path. nullptr means nobody is told --
     *  which is how a hold that the controller must not hear about simply has no way to notify it,
     *  rather than relying on a suppression flag someone can forget to check. */
    std::function<void(bool)> on_active;
    /** Names this hold in the log ("FIRE", "Flow Test"). */
    std::string label = "HOLD";
};

/**
 * A cancellable hold of an exact length, and nothing else.
 *
 * Owns no I/O and knows nothing about states: it counts down and raises callbacks, and its owner
 * decides what they mean. That is why the same object serves both the burn window and a
 * characterization pulse -- the only difference between them is the HoldSpec handed to start().
 *
 * One instance per owner, not one per kind of hold. The rig occupies exactly one state at a time,
 * so exactly one hold can be running; a second timer object would make "both armed at once"
 * representable, and the failure mode there is a valve held open by a timer nobody is watching.
 *
 * The countdown is a steady_clock deadline waited on with condition_variable::wait_until. The
 * predecessor slept in 50 ms steps and added a nominal 50 to a counter, so it measured sleep
 * *calls* rather than time: every iteration overshot, the error only ever accumulated in one
 * direction, and a requested duration quantised to the step. A deadline cannot drift, and the wait
 * wakes immediately on stop() instead of at the next step boundary.
 *
 * Threading: start() and stop() are not safe to call concurrently with each other -- the caller
 * serialises them (SequencerService does, through transitionTo). extend() and isActive() are safe
 * from any thread.
 */
class HoldTimer {
public:
    using Clock = std::chrono::steady_clock;

    HoldTimer() = default;
    ~HoldTimer();

    HoldTimer(const HoldTimer&) = delete;
    HoldTimer& operator=(const HoldTimer&) = delete;

    /**
     * Begin a hold. Supersedes any hold already running (which is stopped first, so its on_expire
     * never fires). Returns as soon as the countdown is armed; expiry arrives on a timer thread.
     */
    void start(HoldSpec spec);

    /**
     * Cancel the hold and reap the timer thread. Raises on_active(false) if a hold was actually
     * running, so the "it ended" notification happens exactly once whichever way it ended.
     * Safe to call when nothing is running, and safe to call from on_expire (see the .cpp).
     */
    void stop();

    /**
     * Restart the countdown at spec.extended_ms, measured from now.
     * @return false if no hold is running, or if this hold set extended_ms = 0.
     */
    bool extend();

    bool isActive() const {
        return active_.load();
    }

    /** The window currently being counted -- extended_ms after a successful extend(). */
    uint32_t currentDurationMs() const;

private:
    void runTimer();

    mutable std::mutex mtx_;
    std::condition_variable cv_;
    std::thread timer_thread_;

    /** Read without the lock by isActive() and by the wait loop, so atomic. */
    std::atomic<bool> active_{false};
    /** Set by extend() to make the timer thread recompute its deadline. */
    bool restart_ = false;
    Clock::time_point started_at_{};
    uint32_t current_duration_ms_ = 0;

    HoldSpec spec_;
};

}  // namespace sequencer
