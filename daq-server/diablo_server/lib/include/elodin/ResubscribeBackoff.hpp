#pragma once
/**
 * When to re-subscribe to Elodin tables that have gone quiet.
 *
 * Elodin does not deliver a table that did not exist when it was subscribed, so a subscriber that
 * starts before its publisher (calibration_service before daq_bridge or t7_bridge, on every
 * session start) sees nothing until it subscribes again. A fixed 5 s silence threshold made every
 * such start show ~5–8 s of no calibrated data. This retries after 1 s of silence, then backs off
 * (1, 2, 4, then every `max_interval`) so a stream that is genuinely down is not hammered, and
 * snaps back to the short interval once data flows again.
 */
#include <algorithm>
#include <chrono>

namespace fsw::elodin {

class ResubscribeBackoff {
public:
    using Clock = std::chrono::steady_clock;
    using Duration = Clock::duration;

    explicit ResubscribeBackoff(Clock::time_point now,
                                Duration min_interval = std::chrono::seconds(1),
                                Duration max_interval = std::chrono::seconds(5))
        : min_(min_interval),
          max_(max_interval),
          interval_(min_interval),
          last_packet_(now),
          last_subscribe_(now) {
    }

    /** A packet from the watched tables arrived: the subscription works. */
    void packet(Clock::time_point now) {
        last_packet_ = now;
        interval_ = min_;
    }

    /** Just (re-)subscribed — on start, reconnect, or because due() said so. */
    void subscribed(Clock::time_point now) {
        last_subscribe_ = now;
    }

    /** Silence has lasted the current interval since both the last packet and the last
     *  subscription. Call subscribed() after acting on it; the next interval doubles. */
    bool due(Clock::time_point now) {
        if (now - last_packet_ < interval_ || now - last_subscribe_ < interval_)
            return false;
        interval_ = std::min(interval_ * 2, max_);
        return true;
    }

    Duration silence(Clock::time_point now) const {
        return now - last_packet_;
    }

    /** Reset after a reconnect: packets are expected afresh, starting from the short interval. */
    void restart(Clock::time_point now) {
        last_packet_ = now;
        last_subscribe_ = now;
        interval_ = min_;
    }

private:
    Duration min_;
    Duration max_;
    Duration interval_;
    Clock::time_point last_packet_;
    Clock::time_point last_subscribe_;
};

}  // namespace fsw::elodin
