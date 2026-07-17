/**
 * Unit tests for fsw::time::BoardClockSync (pure, deterministic — no sockets,
 * no real clock). House style: plain main(), return 0 on pass / 1 on failure
 * (see test_sequencer_elodin.cpp). Registered with CTest in lib/CMakeLists.txt.
 *
 * Edge-case matrix (from the time-sync design):
 *  1. within-packet spreading           6. uint32 wrap mid-packet
 *  2. min-filter under one-sided jitter 7. safety clamp → arrival fallback
 *  3. crystal drift (both signs)        8. per-board monotonic guard
 *  4. reboot → resync → re-lock         9. multi-board independence
 *  5. uint32 wrap between packets      10. arrival mode (revert switch)
 */

#include "time/BoardClockSync.hpp"

#include <algorithm>
#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

using fsw::time::BoardClockSync;
using fsw::time::TimeSyncConfig;

static int g_failures = 0;

#define CHECK(cond, ...)                                            \
    do {                                                            \
        if (!(cond)) {                                              \
            g_failures++;                                           \
            std::printf("  ❌ [%s:%d] ", __func__, __LINE__);      \
            std::printf(__VA_ARGS__);                               \
            std::printf("\n");                                      \
        }                                                           \
    } while (0)

namespace {

constexpr uint64_t NS_MS = 1000000ULL;
constexpr uint64_t EPOCH = 1800000000000000000ULL;  // arbitrary epoch-ns base
constexpr uint64_t U32_WRAP = 4294967296ULL;        // 2^32

TimeSyncConfig default_cfg() {
    TimeSyncConfig cfg;
    cfg.mode = TimeSyncConfig::Mode::BoardClock;
    cfg.window_seconds = 10;
    cfg.max_plausible_gap_s = 60;
    cfg.max_batch_age_s = 5;
    cfg.resync_threshold_ms = 1000;
    return cfg;
}

/** |a-b| for uint64 without underflow. */
uint64_t absdiff(uint64_t a, uint64_t b) { return a > b ? a - b : b - a; }

/** Deterministic LCG so jitter sequences are reproducible. */
struct Lcg {
    uint64_t s;
    explicit Lcg(uint64_t seed) : s(seed) {}
    uint64_t next() { s = s * 6364136223846793005ULL + 1442695040888963407ULL; return s >> 33; }
    uint64_t below(uint64_t n) { return next() % n; }
};

// ── 1. Within-packet spreading ───────────────────────────────────────────────
void test_spreading() {
    BoardClockSync sync(default_cfg());
    // First packet: 3 chunks 100 ms apart; anchor = arrival.
    const uint64_t arrival = EPOCH;
    auto out = sync.stamp_packet("b1", arrival, {1000, 1100, 1200});
    CHECK(out.size() == 3, "expected 3 stamps");
    CHECK(out[2] == arrival, "newest chunk must land on arrival (got delta %" PRIu64 ")",
          absdiff(out[2], arrival));
    CHECK(out[1] == arrival - 100 * NS_MS, "middle chunk -100ms");
    CHECK(out[0] == arrival - 200 * NS_MS, "oldest chunk -200ms");
    CHECK(sync.stats("b1").locked, "board should be locked after first packet");
    CHECK(sync.stats("b1").resyncs == 0, "first packet is not a resync");
}

// ── 2. Min-filter under one-sided jitter (+ congestion immunity) ─────────────
void test_min_filter_jitter() {
    BoardClockSync sync(default_cfg());
    // True relationship: send_time = EPOCH + board_ms. Delays one-sided, with a
    // known minimum of 0 occurring periodically → offset should lock to truth.
    const uint64_t delays[] = {5, 17, 3, 0, 12, 8, 0, 22, 1, 15};
    uint32_t board_ms = 1000;
    uint64_t last = 0;
    for (int i = 0; i < 100; i++) {
        const uint64_t true_send = EPOCH + static_cast<uint64_t>(board_ms) * NS_MS;
        const uint64_t arrival = true_send + delays[i % 10] * NS_MS;
        auto out = sync.stamp_packet("b1", arrival, {board_ms});
        last = out[0];
        board_ms += 100;
    }
    // After lock, every stamp should equal the true send time exactly (min=0 seen).
    const uint64_t true_last = EPOCH + static_cast<uint64_t>(board_ms - 100) * NS_MS;
    CHECK(absdiff(last, true_last) <= 1 * NS_MS, "locked stamp off by %" PRIu64 " ns",
          absdiff(last, true_last));

    // Congestion burst: 20 packets all +50 ms late — stamps must stay true
    // (the min-filter ignores one-sided delay; board time + offset is used).
    for (int i = 0; i < 20; i++) {
        const uint64_t true_send = EPOCH + static_cast<uint64_t>(board_ms) * NS_MS;
        auto out = sync.stamp_packet("b1", true_send + 50 * NS_MS, {board_ms});
        CHECK(absdiff(out[0], true_send) <= 1 * NS_MS,
              "congested packet stamped %" PRIu64 " ns off truth", absdiff(out[0], true_send));
        board_ms += 100;
    }
    CHECK(sync.stats("b1").resyncs == 0, "no resyncs expected under jitter/congestion");
    CHECK(sync.stats("b1").jitter_ms > 1.0, "jitter stat should reflect the 50ms burst");
}

// ── 3. Crystal drift, both signs ─────────────────────────────────────────────
void test_drift() {
    for (const double ppm : {+200.0, -200.0}) {
        BoardClockSync sync(default_cfg());
        const std::string key = ppm > 0 ? "fast" : "slow";
        uint64_t worst = 0;
        // 60 s at 10 Hz; board clock runs at (1+ppm) rate; delivery delay 2 ms.
        for (int i = 0; i < 600; i++) {
            const double real_s = 0.1 * i;
            const uint64_t true_send = EPOCH + static_cast<uint64_t>(real_s * 1e9);
            const uint32_t board_ms =
                static_cast<uint32_t>(1000.0 + real_s * 1000.0 * (1.0 + ppm * 1e-6));
            auto out = sync.stamp_packet(key, true_send + 2 * NS_MS, {board_ms});
            if (i > 100) worst = std::max(worst, absdiff(out[0], true_send));
        }
        // Bound: delivery delay (2ms, constant → indistinguishable from offset)
        // plus window staleness (10 s × 200 ppm = 2 ms) plus ms quantization.
        CHECK(worst <= 6 * NS_MS, "%s drift worst error %" PRIu64 " ns (limit 6ms)",
              key.c_str(), worst);
        CHECK(sync.stats(key).resyncs == 0, "%s drift must not cause resyncs", key.c_str());
    }
}

// ── 4. Reboot → resync → re-lock ─────────────────────────────────────────────
void test_reboot() {
    BoardClockSync sync(default_cfg());
    uint64_t arrival = EPOCH;
    uint32_t board_ms = 3000000;  // ~50 min uptime
    uint64_t prev_stamp = 0;
    for (int i = 0; i < 50; i++) {
        auto out = sync.stamp_packet("b1", arrival, {board_ms});
        prev_stamp = out[0];
        arrival += 100 * NS_MS;
        board_ms += 100;
    }
    CHECK(sync.stats("b1").resyncs == 0, "pre-reboot: no resyncs");

    // Reboot: millis resets to ~0. Forward modular step ≈ 2^32 - uptime → huge.
    board_ms = 5;
    auto out = sync.stamp_packet("b1", arrival, {board_ms});
    CHECK(sync.stats("b1").resyncs == 1, "reboot must count exactly one resync");
    CHECK(out[0] == arrival, "resync packet anchors at arrival");
    CHECK(out[0] >= prev_stamp, "monotonicity across reboot");

    // Re-locked: subsequent packets spread normally off the new anchor.
    arrival += 100 * NS_MS;
    board_ms += 100;
    auto out2 = sync.stamp_packet("b1", arrival, {static_cast<uint32_t>(board_ms - 50), board_ms});
    CHECK(out2[1] == arrival, "post-reboot newest at arrival");
    CHECK(out2[0] == arrival - 50 * NS_MS, "post-reboot spreading intact");
    CHECK(sync.stats("b1").resyncs == 1, "re-lock must not add resyncs");
}

// ── 5. uint32 wrap between packets ───────────────────────────────────────────
void test_wrap_between_packets() {
    BoardClockSync sync(default_cfg());
    uint64_t arrival = EPOCH;
    uint64_t board_ms64 = U32_WRAP - 2000;  // 2 s before wrap
    uint64_t prev = 0;
    for (int i = 0; i < 50; i++) {  // crosses the wrap around i=20
        const uint32_t raw = static_cast<uint32_t>(board_ms64 & 0xFFFFFFFFULL);
        auto out = sync.stamp_packet("b1", arrival, {raw});
        if (i > 0) {
            CHECK(out[0] - prev == 100 * NS_MS,
                  "spacing must stay exactly 100ms across the wrap (i=%d, got %" PRIu64 ")",
                  i, out[0] - prev);
        }
        prev = out[0];
        arrival += 100 * NS_MS;
        board_ms64 += 100;
    }
    CHECK(sync.stats("b1").resyncs == 0, "a wrap is NOT a reboot — no resync");
    CHECK(sync.stats("b1").clamp_fallbacks == 0, "no clamps across wrap");
}

// ── 6. uint32 wrap mid-packet ────────────────────────────────────────────────
void test_wrap_mid_packet() {
    BoardClockSync sync(default_cfg());
    // Prime the board just before the wrap.
    sync.stamp_packet("b1", EPOCH, {static_cast<uint32_t>(U32_WRAP - 400)});
    // Packet whose chunks span the wrap: ...-200, -100, then 0 (=wrap), +100.
    const uint64_t arrival = EPOCH + 300 * NS_MS;
    auto out = sync.stamp_packet(
        "b1", arrival,
        {static_cast<uint32_t>(U32_WRAP - 200), static_cast<uint32_t>(U32_WRAP - 100), 0, 100});
    CHECK(out[3] - out[2] == 100 * NS_MS, "post-wrap spacing");
    CHECK(out[2] - out[1] == 100 * NS_MS, "spacing across the wrap boundary");
    CHECK(out[1] - out[0] == 100 * NS_MS, "pre-wrap spacing");
    CHECK(sync.stats("b1").resyncs == 0, "mid-packet wrap is not a resync");
    CHECK(sync.stats("b1").clamp_fallbacks == 0, "mid-packet wrap must not clamp");
}

// ── 7. Safety clamp → flat arrival fallback ──────────────────────────────────
void test_clamp_fallback() {
    BoardClockSync sync(default_cfg());
    sync.stamp_packet("b1", EPOCH, {1000});
    // Chunk claiming to be 10 s older than the newest (> max_batch_age 5 s):
    // plausible intra-packet step, but the stamp lands before the age floor.
    const uint64_t arrival = EPOCH + 10100 * NS_MS;
    auto out = sync.stamp_packet("b1", arrival, {1100, 11100});
    CHECK(out[0] == arrival, "too-old chunk must fall back to arrival");
    CHECK(sync.stats("b1").clamp_fallbacks == 1, "fallback must be counted");
    CHECK(out[1] == arrival, "newest chunk at arrival here");

    // Garbage intra-packet spacing (backwards step > max gap): older chunk clamps.
    const uint64_t arrival2 = arrival + 100 * NS_MS;
    auto out2 = sync.stamp_packet("b1", arrival2, {900000000, 11200});
    CHECK(out2[0] == arrival2, "garbage-spaced chunk must fall back to arrival");
    CHECK(sync.stats("b1").clamp_fallbacks == 2, "second fallback counted");
    // Invariant: nothing ever stamps in the future.
    for (auto t : out2) CHECK(t <= arrival2, "no stamp may exceed arrival");
}

// ── 8. Per-board monotonic guard ─────────────────────────────────────────────
void test_monotonic_guard() {
    BoardClockSync sync(default_cfg());
    // Packet 1 delayed 10 ms with an empty window → offset absorbs the delay.
    const uint64_t send1 = EPOCH + 1000 * NS_MS;
    auto out1 = sync.stamp_packet("b1", send1 + 10 * NS_MS, {1000});
    // Packet 2: board advances only 5 ms but delivery delay drops to 0 →
    // naively t2 = t1 - 5ms. Guard must hold the line.
    const uint64_t send2 = EPOCH + 1005 * NS_MS;
    auto out2 = sync.stamp_packet("b1", send2, {1005});
    CHECK(out2[0] >= out1[0], "emitted stamps must be non-decreasing (got -%" PRIu64 " ns)",
          out1[0] > out2[0] ? out1[0] - out2[0] : 0);
}

// ── 9. Multi-board independence ──────────────────────────────────────────────
void test_multi_board() {
    BoardClockSync sync(default_cfg());
    // Board A: normal. Board B: absurd absolute clock (offset ~ -1h), which is
    // fine — offset is per-board. A reboot on B must not disturb A.
    uint64_t arrival = EPOCH;
    uint32_t a_ms = 1000, b_ms = 3600000;
    uint64_t a_prev = 0;
    for (int i = 0; i < 30; i++) {
        auto oa = sync.stamp_packet("A", arrival + 1 * NS_MS, {a_ms});
        sync.stamp_packet("B", arrival + 2 * NS_MS, {b_ms});
        if (i > 0) CHECK(oa[0] - a_prev == 100 * NS_MS, "board A spacing exact");
        a_prev = oa[0];
        arrival += 100 * NS_MS;
        a_ms += 100;
        b_ms += 100;
    }
    sync.stamp_packet("B", arrival + 2 * NS_MS, {7});  // B reboots
    CHECK(sync.stats("B").resyncs == 1, "B resynced");
    CHECK(sync.stats("A").resyncs == 0, "A unaffected by B's reboot");
    auto oa = sync.stamp_packet("A", arrival + 100 * NS_MS + 1 * NS_MS, {a_ms});
    CHECK(oa[0] - a_prev == 100 * NS_MS, "A spacing exact after B's reboot");
}

// ── 10. Arrival mode (revert switch) ─────────────────────────────────────────
void test_arrival_mode() {
    TimeSyncConfig cfg = default_cfg();
    cfg.mode = TimeSyncConfig::Mode::Arrival;
    BoardClockSync sync(cfg);
    const uint64_t arrival = EPOCH + 42 * NS_MS;
    auto out = sync.stamp_packet("b1", arrival, {1000, 1100, 1200});
    for (auto t : out) CHECK(t == arrival, "arrival mode: every chunk at arrival");
    CHECK(sync.stats("b1").resyncs == 0 && sync.stats("b1").clamp_fallbacks == 0,
          "arrival mode touches no sync machinery");
}

// ── Fuzz: random jitter, invariants always hold ──────────────────────────────
void test_fuzz_invariants() {
    BoardClockSync sync(default_cfg());
    Lcg rng(0xD1AB70);
    uint32_t board_ms = 500;
    uint64_t arrival = EPOCH;
    uint64_t prev = 0;
    for (int i = 0; i < 2000; i++) {
        const uint32_t n_chunks = 1 + static_cast<uint32_t>(rng.below(4));
        std::vector<uint32_t> chunks;
        for (uint32_t c = 0; c < n_chunks; c++) {
            chunks.push_back(board_ms);
            board_ms += 20 + static_cast<uint32_t>(rng.below(30));
        }
        arrival += (50 + rng.below(100)) * NS_MS;                 // real time advances
        const uint64_t jittered = arrival + rng.below(40) * NS_MS;  // one-sided delay
        auto out = sync.stamp_packet("fz", jittered, chunks);
        for (auto t : out) {
            CHECK(t <= jittered, "fuzz: stamp beyond arrival at i=%d", i);
            CHECK(t >= prev, "fuzz: non-monotonic stamp at i=%d", i);
            prev = t;
        }
    }
}

}  // namespace

int main() {
    std::printf("BoardClockSync unit tests\n");
    test_spreading();
    test_min_filter_jitter();
    test_drift();
    test_reboot();
    test_wrap_between_packets();
    test_wrap_mid_packet();
    test_clamp_fallback();
    test_monotonic_guard();
    test_multi_board();
    test_arrival_mode();
    test_fuzz_invariants();

    if (g_failures == 0) {
        std::printf("✅ all BoardClockSync tests passed\n");
        return 0;
    }
    std::printf("❌ %d failure(s)\n", g_failures);
    return 1;
}
