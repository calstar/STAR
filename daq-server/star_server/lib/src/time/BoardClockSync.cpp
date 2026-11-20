#include "time/BoardClockSync.hpp"

#include <algorithm>
#include <cmath>

namespace fsw {
namespace time {

namespace {
constexpr int64_t NS_PER_MS = 1000000LL;
constexpr double JITTER_EMA_ALPHA = 0.1;

/** Modular uint32 forward step (wrap-safe): how far b advanced past a. */
inline uint32_t forward_step_ms(uint32_t a, uint32_t b) {
    return static_cast<uint32_t>(b - a);
}

/** Board timeline position in ns. All offset math is exact int64 — doubles
 *  cannot represent epoch-ns (53-bit mantissa) and the rounding error would
 *  leak into the future-clamp comparison. */
inline int64_t board_ns(uint64_t unwrapped_ms) {
    return static_cast<int64_t>(unwrapped_ms) * NS_PER_MS;
}
}  // namespace

void BoardClockSync::resync(BoardState& s, uint32_t newest_raw_ms, uint64_t arrival_ns,
                            bool count) {
    // Re-anchor: the newest chunk is assumed sent "just now" — offset derived
    // from this packet's arrival alone. Accuracy for THIS packet equals the
    // legacy arrival-stamping; the window rebuilds from here.
    s.last_raw_ms = newest_raw_ms;
    s.last_unwrapped_ms = newest_raw_ms;  // restart the 64-bit timeline
    const int64_t residual = static_cast<int64_t>(arrival_ns) - board_ns(s.last_unwrapped_ms);
    s.offset_ns = residual;
    s.window.clear();
    s.window.emplace_back(arrival_ns, residual);
    s.locked = true;
    if (count)
        s.stats.resyncs++;
}

std::vector<uint64_t> BoardClockSync::stamp_packet(const std::string& board_key,
                                                   uint64_t arrival_ns,
                                                   const std::vector<uint32_t>& chunk_ms) {
    std::vector<uint64_t> out(chunk_ms.size(), arrival_ns);
    if (chunk_ms.empty())
        return out;

    BoardState& s = boards_[board_key];
    s.stats.packets++;

    if (cfg_.mode == TimeSyncConfig::Mode::Arrival) {
        // Revert switch: historical behavior, every chunk at arrival time.
        s.stats.locked = false;
        return out;
    }

    const uint64_t max_gap_ms = static_cast<uint64_t>(cfg_.max_plausible_gap_s) * 1000ULL;
    const uint32_t newest_raw = chunk_ms.back();

    // ── Unwrap the packet's newest chunk against the previous packet ─────────
    bool reinitialized = false;
    if (!s.locked) {
        resync(s, newest_raw, arrival_ns, /*count=*/false);  // first packet: not a resync
        reinitialized = true;
    } else {
        const uint32_t step = forward_step_ms(s.last_raw_ms, newest_raw);
        if (step <= max_gap_ms) {
            // Continuous (a uint32 wrap lands here too — small modular step).
            s.last_unwrapped_ms += step;
            s.last_raw_ms = newest_raw;
        } else {
            // Implausible forward jump: reboot (millis reset) or a stall longer
            // than max_plausible_gap. Either way the old anchor is useless.
            resync(s, newest_raw, arrival_ns, /*count=*/true);
            reinitialized = true;
        }
    }

    if (!reinitialized) {
        // ── Offset update: sliding-window minimum of residuals ───────────────
        const int64_t residual = static_cast<int64_t>(arrival_ns) - board_ns(s.last_unwrapped_ms);

        // Lost lock (clock discontinuity that kept a plausible step size)?
        const int64_t resync_thr_ns = static_cast<int64_t>(cfg_.resync_threshold_ms) * NS_PER_MS;
        if (residual - s.offset_ns > resync_thr_ns || s.offset_ns - residual > resync_thr_ns) {
            resync(s, newest_raw, arrival_ns, /*count=*/true);
        } else {
            s.window.emplace_back(arrival_ns, residual);
            const uint64_t window_ns =
                static_cast<uint64_t>(cfg_.window_seconds) * 1000ULL * NS_PER_MS;
            while (!s.window.empty() && s.window.front().first + window_ns < arrival_ns) {
                s.window.pop_front();
            }
            int64_t mn = s.window.front().second;
            for (const auto& e : s.window)
                mn = std::min(mn, e.second);
            // Includes the current packet's residual → offset ≤ residual, which
            // guarantees the newest chunk never stamps past arrival.
            s.offset_ns = mn;

            // Jitter diagnostic: this packet's delivery excess above the floor.
            const double excess_ms =
                static_cast<double>(residual - s.offset_ns) / static_cast<double>(NS_PER_MS);
            s.stats.jitter_ms += JITTER_EMA_ALPHA * (excess_ms - s.stats.jitter_ms);
        }
    }

    // ── Stamp every chunk: unwrap within the packet, apply offset, clamp ─────
    // Walk backward from the newest chunk (anchored at s.last_unwrapped_ms);
    // modular steps make mid-packet wraps exact.
    const size_t n = chunk_ms.size();
    std::vector<uint64_t> unwrapped(n, 0);
    std::vector<char> valid(n, 1);
    unwrapped[n - 1] = s.last_unwrapped_ms;
    for (size_t i = n - 1; i-- > 0;) {
        const uint32_t step = forward_step_ms(chunk_ms[i], chunk_ms[i + 1]);
        if (step <= max_gap_ms && unwrapped[i + 1] >= step) {
            unwrapped[i] = unwrapped[i + 1] - step;
            valid[i] = valid[i + 1];
        } else {
            // Garbage intra-packet spacing — safety-clamp this and older chunks.
            valid[i] = 0;
        }
    }

    const int64_t arrival = static_cast<int64_t>(arrival_ns);
    const int64_t age_ns = static_cast<int64_t>(cfg_.max_batch_age_s) * 1000LL * NS_PER_MS;
    const int64_t lower = arrival - age_ns;

    for (size_t i = 0; i < n; i++) {
        uint64_t t_ns;
        const int64_t t = board_ns(unwrapped[i]) + s.offset_ns;
        if (!valid[i] || t < lower || t > arrival) {
            // Safety clamp: flat arrival time — exactly the pre-sync behavior.
            t_ns = arrival_ns;
            s.stats.clamp_fallbacks++;
        } else {
            t_ns = static_cast<uint64_t>(t);
        }
        // Per-board monotonic guard: emitted chunk timestamps never decrease.
        if (t_ns < s.last_emitted_ns)
            t_ns = s.last_emitted_ns;
        s.last_emitted_ns = t_ns;
        out[i] = t_ns;
    }

    s.stats.offset_ms = static_cast<double>(s.offset_ns) / static_cast<double>(NS_PER_MS);
    s.stats.locked = s.locked;
    return out;
}

BoardClockSync::BoardStats BoardClockSync::stats(const std::string& board_key) const {
    auto it = boards_.find(board_key);
    return it != boards_.end() ? it->second.stats : BoardStats{};
}

std::vector<std::string> BoardClockSync::boards() const {
    std::vector<std::string> keys;
    keys.reserve(boards_.size());
    for (const auto& [k, _] : boards_)
        keys.push_back(k);
    return keys;
}

}  // namespace time
}  // namespace fsw
