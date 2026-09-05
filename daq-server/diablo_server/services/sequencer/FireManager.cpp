#include "control/FireManager.hpp"

#include <chrono>
#include <iostream>

namespace sequencer {

FireManager::FireManager(uint32_t fire_duration_ms, uint32_t fire_extended_ms)
    : fire_duration_ms_(fire_duration_ms),
      fire_extended_ms_(fire_extended_ms),
      current_duration_ms_(fire_duration_ms) {
}

FireManager::~FireManager() {
    stop();
}

void FireManager::notify(bool active) {
    if (notifier_)
        notifier_(active);
}

// ─────────────────────────────────────────────────────────────────────────────
void FireManager::start(std::function<void()> on_expire) {
    stop();  // ensure any previous timer is cleaned up

    on_expire_ = std::move(on_expire);
    cancel_ = false;
    current_duration_ms_ = fire_duration_ms_;
    active_ = true;

    notify(true);
    std::cout << "[FireManager] FIRE started (" << fire_duration_ms_ << " ms)" << std::endl;

    timer_thread_ = std::thread([this]() {
        runTimer();
    });
}

void FireManager::stop() {
    // NOTE: we must always reap timer_thread_ if it is joinable, even when
    // active_ is already false. runTimer() sets active_ = false *before*
    // invoking on_expire_(), which means a natural timer expiration leaves
    // the std::thread object joinable but with active_ == false. The next
    // start() then move-assigns into a joinable std::thread, which triggers
    // std::terminate ("terminate called without an active exception").
    const bool was_active = active_.exchange(false);
    cancel_ = true;

    if (timer_thread_.joinable()) {
        if (timer_thread_.get_id() == std::this_thread::get_id()) {
            // Called from on_expire_ on the timer thread itself: cannot
            // join self, so detach. The thread is about to return anyway.
            timer_thread_.detach();
        } else {
            timer_thread_.join();
        }
    }

    if (was_active) {
        notify(false);
        std::cout << "[FireManager] FIRE stopped" << std::endl;
    }
}

void FireManager::extend() {
    if (!active_)
        return;
    current_duration_ms_ = fire_extended_ms_;
    cancel_ = true;  // signal the timer to restart
    // Timer thread re-reads current_duration_ms_ after the cancel signal
    std::cout << "[FireManager] FIRE extended to " << fire_extended_ms_ << " ms" << std::endl;
}

// ─────────────────────────────────────────────────────────────────────────────
void FireManager::runTimer() {
    while (active_) {
        cancel_ = false;
        const uint32_t duration = current_duration_ms_.load();
        const auto step = std::chrono::milliseconds(50);
        uint32_t elapsed_ms = 0;

        while (active_ && !cancel_ && elapsed_ms < duration) {
            std::this_thread::sleep_for(step);
            elapsed_ms += 50;
        }

        if (!active_)
            return;  // stop() was called

        if (cancel_) {
            // extend() was called — restart with the new duration
            std::cout << "[FireManager] Timer restarted (extended)" << std::endl;
            continue;
        }

        // Timer expired naturally
        std::cout << "[FireManager] Fire timer expired — transitioning to ARMED" << std::endl;
        active_ = false;
        notify(false);
        if (on_expire_)
            on_expire_();
        return;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

}  // namespace sequencer
