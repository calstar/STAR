#include "control/HoldTimer.hpp"

#include <iostream>

namespace sequencer {

HoldTimer::~HoldTimer() {
    stop();
}

// ─────────────────────────────────────────────────────────────────────────────
void HoldTimer::start(HoldSpec spec) {
    stop();  // reap any previous timer, including one that expired naturally (see stop())

    std::function<void(bool)> on_active;
    uint32_t duration = 0;
    std::string label;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        spec_ = std::move(spec);
        current_duration_ms_ = spec_.duration_ms;
        restart_ = false;
        active_ = true;
        on_active = spec_.on_active;
        duration = current_duration_ms_;
        label = spec_.label;
    }

    // Notify BEFORE the clock starts. on_active can be a TCP connect to another service with a
    // timeout of its own; if the deadline were anchored ahead of it, a slow or unreachable peer
    // would eat that time out of the hold and shorten the window the operator asked for.
    if (on_active)
        on_active(true);

    {
        std::lock_guard<std::mutex> lk(mtx_);
        started_at_ = Clock::now();
    }
    std::cout << "[HoldTimer] " << label << " started (" << duration << " ms)" << std::endl;

    timer_thread_ = std::thread([this]() {
        runTimer();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
void HoldTimer::stop() {
    // Claim the "it ended" notification with an exchange, so exactly one of stop() and runTimer()
    // raises on_active(false). A hold that expired naturally has already set active_ false and
    // notified, and must not be announced as stopped a second time.
    const bool was_active = active_.exchange(false);

    std::function<void(bool)> on_active;
    std::string label;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        restart_ = false;
        on_active = spec_.on_active;
        label = spec_.label;
        cv_.notify_all();
    }

    // Reap the thread whenever it is joinable, not only when a hold was active: runTimer() clears
    // active_ before invoking on_expire_, so a naturally expired hold leaves a joinable thread
    // behind with active_ already false. Skipping it there would leave start() move-assigning onto
    // a joinable std::thread, which is std::terminate ("terminate called without an active
    // exception").
    if (timer_thread_.joinable()) {
        if (timer_thread_.get_id() == std::this_thread::get_id()) {
            // We are ON the timer thread: on_expire_ ran a state transition, and leaving the held
            // state called back into stop(). A thread cannot join itself, and it is about to
            // return anyway, so detach. Note this is reached only after the exchange above, so it
            // cannot deadlock against the outer caller.
            timer_thread_.detach();
        } else {
            timer_thread_.join();
        }
    }

    if (was_active) {
        if (on_active)
            on_active(false);
        std::cout << "[HoldTimer] " << label << " stopped" << std::endl;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
bool HoldTimer::extend() {
    std::lock_guard<std::mutex> lk(mtx_);
    if (!active_.load())
        return false;
    if (spec_.extended_ms == 0)
        return false;  // this hold is a fixed window by construction

    current_duration_ms_ = spec_.extended_ms;
    started_at_ = Clock::now();  // extended_ms runs from the extend call, not from the start
    restart_ = true;
    cv_.notify_all();
    std::cout << "[HoldTimer] " << spec_.label << " extended to " << spec_.extended_ms << " ms"
              << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
uint32_t HoldTimer::currentDurationMs() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return current_duration_ms_;
}

// ─────────────────────────────────────────────────────────────────────────────
void HoldTimer::runTimer() {
    std::unique_lock<std::mutex> lk(mtx_);
    for (;;) {
        const auto deadline = started_at_ + std::chrono::milliseconds(current_duration_ms_);
        // Re-check the clock rather than passing a predicate: wait_until may return early for a
        // spurious wake, and the deadline is the authority on whether the hold is over.
        while (active_.load() && !restart_ && Clock::now() < deadline)
            cv_.wait_until(lk, deadline);

        if (!active_.load())
            return;  // stop() cancelled us; it owns the notification and the reaping
        if (restart_) {
            restart_ = false;
            continue;  // extend() moved the deadline
        }
        break;  // deadline reached
    }

    active_ = false;
    // Copy the callbacks and release the lock before calling out. on_expire_ transitions state,
    // which calls back into stop() on this very thread; running that under mtx_ would deadlock on
    // a non-recursive mutex.
    auto on_expire = spec_.on_expire;
    auto on_active = spec_.on_active;
    const std::string label = spec_.label;
    lk.unlock();

    std::cout << "[HoldTimer] " << label << " expired" << std::endl;
    if (on_active)
        on_active(false);
    if (on_expire)
        on_expire();
}

}  // namespace sequencer
