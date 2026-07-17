#ifndef FSW_BOARD_CLOCK_SYNC_HPP
#define FSW_BOARD_CLOCK_SYNC_HPP

/**
 * @file BoardClockSync.hpp
 * @brief Per-board clock sync for DAQ sample timestamping.
 *
 * Boards stamp each sensor chunk with uint32 millis() from a cheap local
 * crystal: accurate RELATIVE spacing, meaningless absolute value, wraps at
 * 2^32 ms (~49.7 days; faster on other firmware). The bridge historically
 * stamped every sample in a UDP packet with one receive time, flattening a
 * multi-chunk batch onto one instant and leaking network jitter into the
 * recorded timeline.
 *
 * This module reconstructs true sample times server-side, one instance per
 * source board:
 *  - UNWRAP: uint32 board ms extended to 64-bit via modular forward deltas.
 *    A forward step beyond max_plausible_gap is a reboot (or long stall) →
 *    resync. A wrap is just a small modular step → seamless, no resync.
 *  - OFFSET: sliding-window MINIMUM of residual = arrival − board_time.
 *    Network delay is one-sided noise (a packet can't arrive before it was
 *    sent), so residuals scatter ABOVE the true offset and the window floor
 *    is the best estimate; congestion cannot drag it. The window bounds
 *    drift staleness to ~window_seconds × crystal-ppm (≈0.5 ms at defaults).
 *  - SPREADING: each chunk stamped at board_time + offset, so batched scans
 *    keep their true spacing instead of collapsing onto arrival time.
 *  - INVARIANTS: because the current packet's residual participates in the
 *    window min, offset ≤ residual and the newest chunk never stamps in the
 *    future. Every stamp is additionally clamped to
 *    [arrival − max_batch_age, arrival] (violation → flat arrival fallback +
 *    counter: worst case equals the old behavior), and per-board emitted
 *    chunk timestamps are forced non-decreasing.
 *
 * Mode "arrival" reproduces the historical behavior exactly (revert switch,
 * config.toml [time_sync]).
 *
 * Pure and deterministic: no sockets, no real clock — arrival times are
 * inputs, so unit tests drive every edge case (see lib/test/
 * test_board_clock_sync.cpp).
 */

#include <cstdint>
#include <deque>
#include <map>
#include <string>
#include <vector>

namespace fsw {
namespace time {

struct TimeSyncConfig {
    enum class Mode { BoardClock, Arrival };
    Mode mode = Mode::BoardClock;
    uint32_t window_seconds = 10;       // residual-min sliding window
    uint32_t max_plausible_gap_s = 60;  // modular forward step beyond this = reboot
    uint32_t max_batch_age_s = 5;       // stamps confined to [arrival - this, arrival]
    uint32_t resync_threshold_ms = 1000;  // |residual - offset| beyond this = lost lock
    uint32_t log_interval_s = 10;       // diagnostics cadence (used by the bridge)
};

class BoardClockSync {
public:
    explicit BoardClockSync(const TimeSyncConfig& cfg) : cfg_(cfg) {}

    /**
     * Stamp one packet's chunks for one board.
     *
     * @param board_key  stable identity of the source board (source IP)
     * @param arrival_ns server receive time of the packet (epoch ns)
     * @param chunk_ms   the packet's chunk timestamps in send order (board
     *                   uint32 millis; may wrap mid-packet)
     * @return one epoch-ns timestamp per chunk, same order as chunk_ms
     */
    std::vector<uint64_t> stamp_packet(const std::string& board_key,
                                       uint64_t arrival_ns,
                                       const std::vector<uint32_t>& chunk_ms);

    struct BoardStats {
        double offset_ms = 0.0;       // current arrival-vs-board offset estimate
        double jitter_ms = 0.0;       // EMA of residual excess over the offset floor
        uint32_t resyncs = 0;         // reboot / lost-lock re-initializations
        uint32_t clamp_fallbacks = 0; // chunks stamped at flat arrival (safety clamp)
        uint64_t packets = 0;
        bool locked = false;
    };

    /** Stats for one board (default-constructed if unknown). */
    BoardStats stats(const std::string& board_key) const;

    /** All boards seen (for periodic diagnostics logging). */
    std::vector<std::string> boards() const;

private:
    struct BoardState {
        bool locked = false;
        uint32_t last_raw_ms = 0;        // newest chunk of the previous packet (raw)
        uint64_t last_unwrapped_ms = 0;  // 64-bit unwrapped counterpart
        // Offset math is exact int64 ns — doubles cannot represent epoch-ns.
        int64_t offset_ns = 0;           // arrival_ns - unwrapped_board_ns (window min)
        // (arrival_ns, residual_ns) per packet; pruned to window_seconds by arrival.
        std::deque<std::pair<uint64_t, int64_t>> window;
        uint64_t last_emitted_ns = 0;    // per-board monotonic guard
        BoardStats stats;
    };

    void resync(BoardState& s, uint32_t newest_raw_ms, uint64_t arrival_ns, bool count);

    TimeSyncConfig cfg_;
    std::map<std::string, BoardState> boards_;
};

}  // namespace time
}  // namespace fsw

#endif  // FSW_BOARD_CLOCK_SYNC_HPP
