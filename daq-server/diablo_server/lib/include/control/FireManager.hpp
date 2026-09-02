#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>

namespace sequencer {

/**
 * The FIRE countdown, and nothing else.
 *
 *   - Counts down fire_duration_ms and reports expiry.
 *   - EXTEND_FIRE resets the timer to fire_extended_ms.
 *
 * Deliberately owns no I/O and knows nothing about states. It used to open its own TCP socket to
 * controller_service on every FIRE_START/FIRE_STOP even though SequencerService already held that
 * endpoint and passed it in — and because it could not name a state, `start()` took an opaque
 * callback that the caller had to fill with a stringified state, which a rename could break. Both
 * problems came from the same misplaced responsibility. Now it raises callbacks and its owner
 * decides what they mean.
 *
 * Usage:
 *   FireManager fm(6000, 10000);
 *   fm.setNotifier([&](bool active) { sequencer.notifyControllerFire(active); });
 *   fm.start([&]() { sequencer.transitionTo(fire_expiry_target_state); });
 *   // ... later if extend pressed:
 *   fm.extend();
 *   // ... on FIRE exit (any path):
 *   fm.stop();
 */
class FireManager {
public:
    /**
     * @param fire_duration_ms    Normal FIRE window in milliseconds (default 6000).
     * @param fire_extended_ms    Extended FIRE window in milliseconds (default 10000).
     */
    explicit FireManager(uint32_t fire_duration_ms = 6000, uint32_t fire_extended_ms = 10000);
    ~FireManager();

    /**
     * Called with true when the burn starts and false when it stops, on whatever thread caused it.
     * The owner turns this into whatever notification is appropriate — keeping every message to
     * controller_service in one place instead of two processes writing the same gate.
     */
    void setNotifier(std::function<void(bool)> notifier) {
        notifier_ = std::move(notifier);
    }

    /** Update fire durations (call before start()). */
    void configure(uint32_t fire_duration_ms, uint32_t fire_extended_ms) {
        fire_duration_ms_ = fire_duration_ms;
        fire_extended_ms_ = fire_extended_ms;
    }

    /**
     * Begin the FIRE countdown.
     * Sends FIRE_START to controller_service.
     * @param on_expire  Called (from a background thread) when the timer runs out.
     */
    void start(std::function<void()> on_expire);

    /**
     * Stop and cancel the FIRE countdown (called on any FIRE exit).
     * Sends FIRE_STOP to controller_service.
     */
    void stop();

    /**
     * Extend the FIRE window to fire_extended_ms from now.
     * Cancels the current countdown and restarts with fire_extended_ms.
     */
    void extend();

    bool isActive() const {
        return active_;
    }

private:
    uint32_t fire_duration_ms_;
    uint32_t fire_extended_ms_;

    std::atomic<bool> active_{false};
    std::atomic<bool> cancel_{false};
    std::atomic<uint32_t> current_duration_ms_;

    std::thread timer_thread_;
    std::function<void()> on_expire_;

    std::function<void(bool)> notifier_;

    void runTimer();
    void notify(bool active);
};

}  // namespace sequencer
