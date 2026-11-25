#pragma once

/**
 * CommandQueue — the sequencer's single command worker, its queue, and the watchdog over both.
 *
 * Owns: the FIFO of pending commands, the worker thread that runs them one at a time, and a
 * supervisor thread that watches the worker. SequencerService holds one; every state-machine
 * command (TRANSITION, ACTUATOR, DEBUG_MODE, EXTEND_FIRE from :9998, and the detached hold-expiry
 * and script transitions) goes through it, which is what keeps exactly one thread inside the
 * state machine (see SequencerService.hpp, "Threading contract").
 *
 * ── Lifecycle of a waited-for command (D-LATE, issue #234) ──────────────────────────────────────
 * Each command carries one atomic state, Queued -> Running or Queued -> Cancelled, and nothing
 * else. The worker compare-exchanges Queued -> Running before it runs a command; the waiter (the
 * :9998 connection thread) compare-exchanges Queued -> Cancelled when its deadline passes. Exactly
 * one of the two succeeds, so the reply always tells the truth:
 *   - kDone      the worker ran it; `ok` and `reason` are its result.
 *   - kCancelled the deadline passed while it was still queued. It will never run.
 *   - kPending   the worker claimed it but has not finished within the wedge threshold, or (for a
 *                non-cancellable command: an abort) it is still queued and WILL still run. The
 *                outcome is not known yet; the caller says so instead of guessing.
 *   - kStopped   the queue is shutting down; it was not queued.
 * Before this, a waiter gave up after 10 s and left the command queued, so a transition the
 * operator was told had failed could run whenever the worker got to it.
 *
 * A command's body writes its refusal reason into storage the queue owns, never into the
 * caller's: a kPending waiter returns while the body may still be running.
 *
 * ── Watchdog ────────────────────────────────────────────────────────────────────────────────────
 * The worker stamps a steady-clock time when it starts each command and when it finishes it. The
 * supervisor checks every 100 ms; once the worker has been inside one command for longer than
 * the wedge threshold it raises "wedged" (an stderr line and health().wedged), and clears it when
 * that command finishes. It only observes: it never moves a valve, never cancels the command and
 * never restarts anything (STYLE-S11a, S14a). The backend reads health() through the :9998
 * HEALTH query and raises the operator alert `sequencer_wedged`.
 *
 * Threads: submit()/post()/health() from any thread; the bodies run only on the worker. Guarded
 * by mtx_: queue_, stop_. Everything the supervisor and health() read is atomic.
 *
 * Contract surfaces: the :9998 replies built from Reply (sequencer_main.cpp); the stderr lines
 * below. Frozen in test/characterization/sequencer (README: D-LATE) and pipeline/golden/holds.
 */

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace sequencer {

class CommandQueue {
public:
    /** A command body. Runs on the worker. `reason` is never null; set it on a refusal. */
    using Body = std::function<bool(std::string* reason)>;

    enum class Outcome { kDone, kCancelled, kPending, kStopped };

    struct Reply {
        Outcome outcome = Outcome::kStopped;
        bool ok = false;     // kDone only: what the body returned
        std::string reason;  // kDone: the body's refusal reason; otherwise why there is no result
    };

    struct Options {
        /** How long a cancellable command may sit in the queue before its waiter cancels it. */
        std::chrono::milliseconds deadline{1500};
        /** How long the worker may be inside one command before the supervisor calls it wedged;
         *  also how long a waiter waits for a command the worker has already claimed. */
        std::chrono::milliseconds wedge_threshold{3000};
    };

    struct Health {
        bool wedged = false;
        /** Milliseconds the worker has been inside its current command; 0 when idle. */
        uint64_t busy_ms = 0;
    };

    CommandQueue() = default;
    ~CommandQueue();
    CommandQueue(const CommandQueue&) = delete;
    CommandQueue& operator=(const CommandQueue&) = delete;

    /** Start the worker and the supervisor. Call once. */
    void start(const Options& opts);

    /** Stop accepting work, let the worker drain what is queued, join both threads. Idempotent. */
    void stop();

    /**
     * Queue `body` and wait for its outcome (see the lifecycle above). `cancellable` false keeps
     * the command queued past its deadline: the waiter then reports kPending and the worker
     * still runs it. The sequencer passes false for an abort, which must never be dropped.
     */
    [[nodiscard]] Reply submit(Body body, bool cancellable = true);

    /** Queue `body` and return at once; nothing waits on it, so nothing cancels it. */
    void post(Body body);

    /** The supervisor's view. Answerable from any thread, without the worker. */
    Health health() const;

    const Options& options() const {
        return opts_;
    }

private:
    enum State : uint8_t { kQueued, kRunning, kCancelled };

    struct Entry {
        Body body;
        std::atomic<uint8_t> state{kQueued};
        std::chrono::steady_clock::time_point queued_at;
        // Written by the worker before `done` is set; read by the waiter only after.
        bool ok = false;
        std::string reason;
        std::mutex m;
        std::condition_variable cv;
        bool done = false;  // guarded by m
    };

    void workerLoop();
    void supervisorLoop();
    static int64_t nowNs();

    Options opts_;
    std::deque<std::shared_ptr<Entry>> queue_;
    mutable std::mutex mtx_;
    std::condition_variable cv_;
    bool stop_ = false;     // guarded by mtx_
    bool started_ = false;  // guarded by mtx_
    std::thread worker_;
    std::thread supervisor_;
    std::atomic<bool> supervisor_stop_{false};

    // Watchdog stamps (steady clock, ns). busy while started_ns_ > finished_ns_.
    std::atomic<int64_t> started_ns_{0};
    std::atomic<int64_t> finished_ns_{0};
    std::atomic<bool> wedged_{false};
};

}  // namespace sequencer
