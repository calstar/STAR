/**
 * CommandQueue: the sequencer command lifecycle (D-LATE, issue #234) and its watchdog.
 *
 * The bug: a :9998 waiter gave up after 10 s and reported failure, but left its command in the
 * queue, so when the worker came back the transition the operator had been told failed ran
 * anyway. Each command now carries one atomic state, and the waiter and the worker race to move
 * it out of Queued — the waiter to Cancelled, the worker to Running. These tests hold that:
 *
 *   1. stalled worker: a command queued behind it times out as kCancelled, and after the worker
 *      resumes it never runs;
 *   2. a command the worker claimed before the deadline is waited for and reported kDone;
 *   3. a non-cancellable command (an abort) is reported kPending and still runs later;
 *   4. contention: thousands of commands against a 1 ms deadline, from several threads — every
 *      kDone ran exactly once and every kCancelled never ran (run under TSan in CI);
 *   5. the watchdog raises `wedged` past the threshold and clears it when the command finishes.
 *
 * Pure: no config, no sockets, no SequencerService.
 */
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "control/CommandQueue.hpp"

using sequencer::CommandQueue;
using Clock = std::chrono::steady_clock;
using std::chrono::milliseconds;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** A gate a body can block on, so the test controls when the worker is stalled. */
struct Gate {
    std::mutex m;
    std::condition_variable cv;
    bool open = false;
    void wait() {
        std::unique_lock<std::mutex> lk(m);
        cv.wait(lk, [&] {
            return open;
        });
    }
    void release() {
        {
            std::lock_guard<std::mutex> lk(m);
            open = true;
        }
        cv.notify_all();
    }
};

static CommandQueue::Options opts(int deadline_ms, int wedge_ms) {
    CommandQueue::Options o;
    o.deadline = milliseconds(deadline_ms);
    o.wedge_threshold = milliseconds(wedge_ms);
    return o;
}

/** Wait until the worker has run everything queued so far: a sentinel behind it has run. */
static void drain(CommandQueue& q) {
    const auto r = q.submit(
        [](std::string*) {
            return true;
        },
        /*cancellable=*/false);
    (void)r;
}

static void testStalledWorkerCancels() {
    std::cout << "stalled worker: a queued command times out and never runs" << std::endl;
    CommandQueue q;
    q.start(opts(200, 2000));
    Gate gate;
    std::atomic<bool> stall_started{false};
    std::thread staller([&] {
        (void)q.submit([&](std::string*) {
            stall_started = true;
            gate.wait();
            return true;
        });
    });
    while (!stall_started)
        std::this_thread::sleep_for(milliseconds(1));

    std::atomic<bool> ran{false};
    const auto t0 = Clock::now();
    const auto r = q.submit([&](std::string*) {
        ran = true;
        return true;
    });
    const auto waited = std::chrono::duration_cast<milliseconds>(Clock::now() - t0).count();
    check(r.outcome == CommandQueue::Outcome::kCancelled, "reply is a timeout (kCancelled)");
    check(!r.ok, "and not ok");
    check(r.reason.rfind("not executed", 0) == 0, "reason says not executed: " + r.reason);
    check(waited >= 190 && waited < 1000,
          "answered at the deadline (" + std::to_string(waited) + " ms)");

    gate.release();
    staller.join();
    drain(q);
    check(!ran.load(), "after the worker resumes, the cancelled command never ran");
    q.stop();
}

static void testClaimedCommandIsWaitedFor() {
    std::cout << "a command the worker claimed is waited for past the deadline" << std::endl;
    CommandQueue q;
    q.start(opts(100, 2000));
    const auto r = q.submit([](std::string* why) {
        std::this_thread::sleep_for(milliseconds(300));
        *why = "refused for a reason";
        return false;
    });
    check(r.outcome == CommandQueue::Outcome::kDone, "kDone, not a timeout");
    check(!r.ok && r.reason == "refused for a reason", "the body's own result and reason");
    q.stop();
}

static void testAbortIsNeverCancelled() {
    std::cout << "a non-cancellable command (abort) is pending, then still runs" << std::endl;
    CommandQueue q;
    q.start(opts(100, 300));
    Gate gate;
    std::atomic<bool> stall_started{false};
    std::thread staller([&] {
        (void)q.submit([&](std::string*) {
            stall_started = true;
            gate.wait();
            return true;
        });
    });
    while (!stall_started)
        std::this_thread::sleep_for(milliseconds(1));

    std::atomic<bool> ran{false};
    const auto r = q.submit(
        [&](std::string*) {
            ran = true;
            return true;
        },
        /*cancellable=*/false);
    check(r.outcome == CommandQueue::Outcome::kPending, "reply is pending, not cancelled");
    check(r.reason.find("it will run") != std::string::npos,
          "reason says it will run: " + r.reason);
    gate.release();
    staller.join();
    drain(q);
    check(ran.load(), "the abort ran once the worker came back");
    q.stop();
}

static void testExactlyOneWinner() {
    std::cout << "contention: every reply matches what happened" << std::endl;
    CommandQueue q;
    q.start(opts(1, 2000));
    constexpr int kThreads = 8;
    constexpr int kPerThread = 400;
    std::vector<std::atomic<int>> runs(kThreads * kPerThread);
    std::vector<CommandQueue::Outcome> outcomes(kThreads * kPerThread);
    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back([&, t] {
            for (int i = 0; i < kPerThread; ++i) {
                const int id = t * kPerThread + i;
                const auto r = q.submit([&runs, id](std::string*) {
                    runs[id].fetch_add(1);
                    // Long enough that the queue backs up past the 1 ms deadline.
                    std::this_thread::sleep_for(std::chrono::microseconds(100));
                    return true;
                });
                outcomes[id] = r.outcome;
            }
        });
    }
    for (auto& th : threads)
        th.join();
    drain(q);

    int done = 0, cancelled = 0, wrong = 0;
    for (size_t id = 0; id < runs.size(); ++id) {
        const int n = runs[id].load();
        if (outcomes[id] == CommandQueue::Outcome::kDone) {
            ++done;
            wrong += n != 1;
        } else if (outcomes[id] == CommandQueue::Outcome::kCancelled) {
            ++cancelled;
            wrong += n != 0;
        } else {
            ++wrong;  // kPending needs a 2 s body; kStopped needs a stop
        }
    }
    std::cout << "    " << done << " done, " << cancelled << " cancelled" << std::endl;
    check(wrong == 0,
          "kDone ran exactly once, kCancelled never ran (" + std::to_string(wrong) + " wrong)");
    check(done > 0 && cancelled > 0, "both sides won some races");
    q.stop();
}

static void testWatchdog() {
    std::cout << "watchdog: raises past the threshold, clears on recovery" << std::endl;
    CommandQueue q;
    q.start(opts(100, 300));
    check(!q.health().wedged && q.health().busy_ms == 0, "idle: not wedged, not busy");
    Gate gate;
    q.post([&](std::string*) {
        gate.wait();
        return true;
    });

    std::this_thread::sleep_for(milliseconds(150));
    check(!q.health().wedged, "inside a command, under the threshold: not wedged");
    check(q.health().busy_ms > 0, "but busy");

    const auto t0 = Clock::now();
    while (!q.health().wedged && Clock::now() - t0 < milliseconds(2000))
        std::this_thread::sleep_for(milliseconds(10));
    check(q.health().wedged, "past the threshold: wedged");
    check(q.health().busy_ms >= 300,
          "busy_ms past the threshold (" + std::to_string(q.health().busy_ms) + ")");

    gate.release();
    const auto t1 = Clock::now();
    while (q.health().wedged && Clock::now() - t1 < milliseconds(2000))
        std::this_thread::sleep_for(milliseconds(10));
    check(!q.health().wedged, "after the command finishes: cleared");
    check(q.health().busy_ms == 0, "and idle");
    q.stop();
}

int main() {
    testStalledWorkerCancels();
    testClaimedCommandIsWaitedFor();
    testAbortIsNeverCancelled();
    testExactlyOneWinner();
    testWatchdog();
    if (g_failures) {
        std::cout << g_failures << " FAILED" << std::endl;
        return 1;
    }
    std::cout << "all passed" << std::endl;
    return 0;
}
