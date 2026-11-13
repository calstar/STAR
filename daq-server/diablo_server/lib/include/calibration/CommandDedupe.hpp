#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace fsw::calibration {

/**
 * Drops a CalibrationCommand the service has already handled.
 *
 * elodin-db delivers a table once per subscription to it, and a second subscribe on the same
 * connection is a second subscription: every packet then arrives twice. The service's "no packets
 * for 5 s, re-subscribe" fallback does exactly that, and it re-adds the command table each time —
 * so after it had fired once, every capture landed twice (CI, 2026-11-07: ten captures stored
 * twenty points, and a load cell's single "linear" capture became a two-point line that streamed
 * the reference instead of PENDING physics). After N firings it would be N+1.
 *
 * The backend stamps every command with its own timestamp, so two commands with the same 16 bytes
 * are one command delivered twice, whatever made the copy. Remembers the last kDepth.
 */
class CommandDedupe {
public:
    static constexpr std::size_t kBytes = 16;  // ts(8) | type(1) | pad(1) | sensor(2) | ref(4)
    static constexpr std::size_t kDepth = 32;

    /** true if this exact command was already seen (drop it); otherwise records it. */
    bool seen(const uint8_t* cmd) {
        for (std::size_t i = 0; i < count_; ++i)
            if (std::memcmp(recent_[i].data(), cmd, kBytes) == 0)
                return true;
        std::memcpy(recent_[next_].data(), cmd, kBytes);
        next_ = (next_ + 1) % kDepth;
        if (count_ < kDepth)
            ++count_;
        return false;
    }

private:
    std::array<std::array<uint8_t, kBytes>, kDepth> recent_{};
    std::size_t next_ = 0;
    std::size_t count_ = 0;
};

}  // namespace fsw::calibration
