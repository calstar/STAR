#pragma once
/**
 * Which table subscriptions the DB refused, so a reader can ask again for exactly those.
 *
 * Elodin DB refuses a VTableStream for a table nobody has registered yet, replying ErrorResponse
 * (msg id [0xE0, 0x1D]) with the request id of the subscription it refused. Services start
 * together, so a reader routinely subscribes a few hundred ms before the publisher registers:
 * on 2026-11-05 calibration_service subscribed to the ball valve's raw tables before daq_bridge
 * registered them, and published no ball valve position for the whole session, while every other
 * table, registered a moment earlier, streamed normally.
 *
 * The blunt alternatives are both wrong. Waiting for "no packets at all" never fires when only some
 * tables were refused. Re-asking for every table that has not delivered yet (PressureFeed) is
 * fine for a reader that keeps only the latest value, but a table the DB ACCEPTED and that is
 * merely silent (a board that is off) would gain a second stream per retry, and calibration would
 * then process every sample several times. So: tag each subscription with its own request id, and
 * retry only what was refused.
 *
 * Pure logic, no socket: the caller sends with ElodinClient::subscribe_table(hi, lo, id).
 */
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <utility>
#include <vector>

namespace fsw {
namespace elodin {

/** ErrorResponse: header len(4) | ty(1) | msg id [0xE0, 0x1D] | request id(1). */
inline bool is_error_response(const uint8_t* pkt, size_t len) {
    return len >= 8 && pkt[5] == 0xE0 && pkt[6] == 0x1D;
}

class SubscriptionTracker {
public:
    using Table = std::pair<uint8_t, uint8_t>;
    using Clock = std::chrono::steady_clock;

    explicit SubscriptionTracker(std::chrono::milliseconds retry_after = std::chrono::seconds(1))
        : retry_after_(retry_after) {
    }

    /**
     * The request id to subscribe `table` under. Ids rotate through 1..254: 0 is what untracked
     * subscriptions use, and 255 is the backend's subscription fence.
     */
    uint8_t assign(Table table) {
        const uint8_t id = next_id_;
        next_id_ = next_id_ >= 254 ? 1 : static_cast<uint8_t>(next_id_ + 1);
        by_id_[id] = table;
        return id;
    }

    /**
     * The DB refused the subscription sent under `request_id`. Returns the table it was for, so the
     * caller can say which; {0, 0} for an id this tracker did not hand out.
     */
    Table rejected(uint8_t request_id, Clock::time_point now) {
        auto it = by_id_.find(request_id);
        if (it == by_id_.end())
            return {0, 0};
        const Table t = it->second;
        by_id_.erase(it);
        retry_at_[t] = now + retry_after_;
        return t;
    }

    /** Refused tables whose wait is over; each is forgotten here until rejected again. */
    std::vector<Table> due(Clock::time_point now) {
        std::vector<Table> out;
        for (auto it = retry_at_.begin(); it != retry_at_.end();) {
            if (now >= it->second) {
                out.push_back(it->first);
                it = retry_at_.erase(it);
            } else {
                ++it;
            }
        }
        return out;
    }

    /** Tables currently waiting to be asked for again. */
    size_t refused() const {
        return retry_at_.size();
    }

    /** A new connection: every subscription is sent afresh. */
    void reset() {
        by_id_.clear();
        retry_at_.clear();
    }

private:
    std::chrono::milliseconds retry_after_;
    uint8_t next_id_ = 1;
    std::map<uint8_t, Table> by_id_;
    std::map<Table, Clock::time_point> retry_at_;
};

}  // namespace elodin
}  // namespace fsw
