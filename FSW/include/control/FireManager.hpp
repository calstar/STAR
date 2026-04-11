#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>

namespace sequencer {

/**
 * Manages the FIRE state lifecycle:
 *   - Countdown timer that auto-transitions to ARMED when it expires.
 *   - EXTEND_FIRE command that resets the timer to fire_extended_ms.
 *   - Notifies controller_service via TCP (FIRE_START / FIRE_STOP).
 *
 * Usage:
 *   FireManager fm(6000, 10000);
 *   fm.setControllerEndpoint("127.0.0.1", 8000);
 *   fm.start([&]() { sequencer.transitionTo(State::ARMED); });
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
     * Set the TCP endpoint of controller_service for FIRE_START / FIRE_STOP messages.
     * Call before start(). Defaults to 127.0.0.1:8000.
     */
    void setControllerEndpoint(const std::string& host, uint16_t port);

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

    std::string controller_host_{"127.0.0.1"};
    uint16_t controller_port_{8000};

    void runTimer();
    void notifyController(const std::string& msg);
};

}  // namespace sequencer
