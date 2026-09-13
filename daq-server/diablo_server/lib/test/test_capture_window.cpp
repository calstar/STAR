/**
 * Unit tests for fsw::calibration::CaptureWindow (pure, deterministic — no clock).
 * House style: plain main(), return 0 on pass / 1 on failure (see
 * test_board_clock_sync.cpp). Registered with CTest in lib/CMakeLists.txt.
 *
 * The headline test is low_rate_step_after_settle: it replays the 2026-09-13 load-cell
 * failure at the measured 13.7 Hz and asserts both that the bounded window is right AND
 * that the old unbounded mean was wrong by the margin actually seen on the stand.
 *
 *  1. low-rate step, captured after settling   5. clear() on reconnect
 *  2. window bound at high rate                6. settle detection (4 cases)
 *  3. stale sensor rejected, no fallback       7. ring eviction bounds
 *  4. no samples / too few                     8. uids() skips empty
 */

#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "calibration/CaptureWindow.hpp"

using fsw::calibration::CaptureResult;
using fsw::calibration::CaptureWindow;

static int g_failures = 0;

#define CHECK(cond, ...)                                      \
    do {                                                      \
        if (!(cond)) {                                        \
            g_failures++;                                     \
            std::printf("  ❌ [%s:%d] ", __func__, __LINE__); \
            std::printf(__VA_ARGS__);                         \
            std::printf("\n");                                \
        }                                                     \
    } while (0)

namespace {

constexpr uint64_t NS_MS = 1000000ULL;
constexpr uint64_t EPOCH = 1800000000000000000ULL;
constexpr uint16_t UID = 4101;  // the Fuel Scale, LC board 41 connector 1

/** The measured load-cell cadence: 13.7 Hz is one sample every ~73 ms. */
constexpr uint64_t LC_PERIOD_MS = 73;
/** A fast transducer, for contrast. */
constexpr uint64_t PT_PERIOD_MS = 4;

/** Deterministic noise, same shape as test_board_clock_sync.cpp's Lcg. */
struct Lcg {
    uint64_t s = 0x2026091300000001ULL;
    int32_t next(int32_t amplitude) {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return static_cast<int32_t>((s >> 33) % (2 * amplitude + 1)) - amplitude;
    }
};

/** Feed `count` samples at `period_ms`, returning the time just after the last one. */
uint64_t feed(CaptureWindow& w, uint64_t t_ms, size_t count, uint64_t period_ms, int32_t value,
              Lcg* noise = nullptr, int32_t amplitude = 0) {
    for (size_t i = 0; i < count; i++) {
        const int32_t v = noise ? value + noise->next(amplitude) : value;
        const uint64_t ns = EPOCH + t_ms * NS_MS;
        w.push(UID, v, ns, ns);
        t_ms += period_ms;
    }
    return t_ms;
}

uint64_t now_ns(uint64_t t_ms) {
    return EPOCH + t_ms * NS_MS;
}

// ── 1. The field failure, replayed ───────────────────────────────────────────────────
//
// 30 s at one load, step, then 13 s at the new load — the exact gap between the operator's
// third and fourth Fuel Scale captures. The bounded window must see only the new load.
void low_rate_step_after_settle() {
    CaptureWindow w;
    Lcg noise;
    constexpr int32_t kBefore = 100000;
    constexpr int32_t kAfter = 150000;  // a 50,000-count step, like a 2.268 kg weight

    uint64_t t = 0;
    t = feed(w, t, 411, LC_PERIOD_MS, kBefore, &noise, 800);  // ~30 s at 13.7 Hz
    t = feed(w, t, 178, LC_PERIOD_MS, kAfter, &noise, 800);   // ~13 s after the step

    const CaptureResult r = w.capture(UID, now_ns(t));
    CHECK(r.ok, "capture should succeed, reason=%s", r.reason);
    CHECK(std::fabs(r.adc_avg - kAfter) < 0.01 * (kAfter - kBefore),
          "bounded mean %.1f should be within 1%% of the step of %d", r.adc_avg, kAfter);
    CHECK(r.settled, "a step that finished 13 s ago must read as settled (z=%.1f)", r.drift_z);
    CHECK(r.span_ms <= fsw::calibration::kCaptureWindowMs + LC_PERIOD_MS,
          "span %" PRIu64 " ms should not exceed the window", r.span_ms);

    // And the regression itself: the OLD behaviour averaged the last 128 samples whatever
    // their age. At 13.7 Hz that is 9.3 s, so it still holds the previous load — which is
    // how a 2.268 kg step recorded 39238 counts instead of ~53000, 26% short.
    //
    // Reproduce that arithmetic here so the test pins the real defect, not a tolerance:
    // replay only 3 s past the step (what the operator's 13 s gap left after handling the
    // weight) and confirm the unbounded 128-sample mean falls well short of the true value.
    constexpr size_t kOldRingMax = 128;  // the constant this class replaced
    std::vector<int32_t> hist;
    Lcg n2;
    for (size_t i = 0; i < 411; i++)
        hist.push_back(kBefore + n2.next(800));
    for (size_t i = 0; i < 41; i++)
        hist.push_back(kAfter + n2.next(800));  // ~3 s past the step

    double old_sum = 0.0;
    for (size_t i = hist.size() - kOldRingMax; i < hist.size(); i++)
        old_sum += hist[i];
    const double old_step = old_sum / kOldRingMax - kBefore;
    const double true_step = kAfter - kBefore;
    CHECK(old_step < 0.8 * true_step,
          "the old 128-sample mean should fall >20%% short (got %.0f of %.0f)", old_step,
          true_step);

    // The bounded window, on that same history, does not.
    CaptureWindow bounded;
    uint64_t t2 = 0;
    for (size_t i = 0; i < hist.size(); i++) {
        const uint64_t ns = EPOCH + t2 * NS_MS;
        bounded.push(UID, hist[i], ns, ns);
        t2 += LC_PERIOD_MS;
    }
    const CaptureResult fixed = bounded.capture(UID, now_ns(t2));
    CHECK(fixed.ok && std::fabs(fixed.adc_avg - kAfter) < 0.01 * true_step,
          "bounded mean %.1f should still be the new load", fixed.adc_avg);
}

// ── 2. The window is a time bound, not a sample bound ────────────────────────────────
void window_bound_high_rate() {
    CaptureWindow w;
    uint64_t t = 0;
    t = feed(w, t, 1000, PT_PERIOD_MS, 20000);  // 4 s at 250 Hz
    t = feed(w, t, 625, PT_PERIOD_MS, 30000);   // 2.5 s after the step

    const CaptureResult r = w.capture(UID, now_ns(t));
    CHECK(r.ok, "capture should succeed, reason=%s", r.reason);
    CHECK(std::fabs(r.adc_avg - 30000.0) < 1.0, "mean %.1f should be the post-step value",
          r.adc_avg);
    CHECK(r.span_ms <= fsw::calibration::kCaptureWindowMs + PT_PERIOD_MS,
          "span %" PRIu64 " ms should be the window, not the ring", r.span_ms);
    // ~250 samples in 1 s, versus ~14 for the load cell — same window, same meaning.
    CHECK(r.n > 200 && r.n < 300, "expected ~250 samples in the window, got %zu", r.n);
}

// ── 3. A sensor that stopped publishing has no reading ───────────────────────────────
void stale_sensor_rejected() {
    CaptureWindow w;
    uint64_t t = feed(w, 0, 100, LC_PERIOD_MS, 100000);

    const CaptureResult r = w.capture(UID, now_ns(t + 60000));  // 60 s later
    CHECK(!r.ok, "a 60 s old sensor must not yield a capture");
    CHECK(std::string(r.reason) == "stale", "reason should be stale, got %s", r.reason);
    CHECK(r.age_ms >= 60000, "age %" PRIu64 " ms should reflect the gap", r.age_ms);
    // There is deliberately no last-value fallback to rescue this.
}

// ── 4. Nothing to average ────────────────────────────────────────────────────────────
void empty_and_too_few() {
    CaptureWindow w;
    const CaptureResult none = w.capture(UID, now_ns(0));
    CHECK(!none.ok && std::string(none.reason) == "no_samples", "unknown uid → no_samples, got %s",
          none.reason);

    uint64_t t = feed(w, 0, 2, LC_PERIOD_MS, 100000);
    const CaptureResult few = w.capture(UID, now_ns(t));
    CHECK(!few.ok && std::string(few.reason) == "too_few", "2 samples → too_few, got %s",
          few.reason);
}

// ── 5. Samples either side of a reconnect are not one record ─────────────────────────
void clear_on_reconnect() {
    CaptureWindow w;
    uint64_t t = feed(w, 0, 200, LC_PERIOD_MS, 100000);
    CHECK(w.capture(UID, now_ns(t)).ok, "sanity: capture works before the drop");

    w.clear();
    const CaptureResult r = w.capture(UID, now_ns(t));
    CHECK(!r.ok && std::string(r.reason) == "no_samples",
          "after clear() the pre-drop samples must be gone, got %s", r.reason);
    CHECK(w.uids().empty(), "clear() should empty uids()");
}

// ── 6. Settling ──────────────────────────────────────────────────────────────────────
void settle_detection() {
    {  // (a) steady, with noise
        CaptureWindow w;
        Lcg noise;
        uint64_t t = feed(w, 0, 200, LC_PERIOD_MS, 100000, &noise, 800);
        const CaptureResult r = w.capture(UID, now_ns(t));
        CHECK(r.ok && r.settled, "steady noisy signal should be settled (z=%.2f)", r.drift_z);
    }
    {  // (b) a step INSIDE the window
        CaptureWindow w;
        Lcg noise;
        uint64_t t = feed(w, 0, 200, LC_PERIOD_MS, 100000, &noise, 800);
        t = feed(w, t, 7, LC_PERIOD_MS, 150000, &noise, 800);  // ~0.5 s, half the window
        const CaptureResult r = w.capture(UID, now_ns(t));
        CHECK(r.ok, "a mid-step capture is still recorded");
        CHECK(!r.settled, "a step inside the window must read unsettled (z=%.2f)", r.drift_z);
        CHECK(r.drift_z > fsw::calibration::kSettleZ, "drift_z %.2f should exceed the threshold",
              r.drift_z);
    }
    {  // (c) a step that COMPLETED before the window — settled, and at the new value
        CaptureWindow w;
        Lcg noise;
        uint64_t t = feed(w, 0, 200, LC_PERIOD_MS, 100000, &noise, 800);
        t = feed(w, t, 42, LC_PERIOD_MS, 150000, &noise, 800);  // ~3 s at the new load
        const CaptureResult r = w.capture(UID, now_ns(t));
        CHECK(r.ok && r.settled, "a step 3 s ago should be settled (z=%.2f)", r.drift_z);
        CHECK(std::fabs(r.adc_avg - 150000.0) < 500.0, "mean %.1f should be the new load",
              r.adc_avg);
    }
    {  // (d) a perfectly quiet channel — sd 0 must not make drift infinitely significant
        CaptureWindow w;
        uint64_t t = feed(w, 0, 200, LC_PERIOD_MS, 100000);
        const CaptureResult r = w.capture(UID, now_ns(t));
        CHECK(r.ok && r.settled, "a constant signal is settled (z=%.2f)", r.drift_z);
        CHECK(std::isfinite(r.drift_z), "drift_z must stay finite when sd is 0");
        CHECK(r.spread == 0.0, "spread should be 0, got %.1f", r.spread);
    }
}

// ── 7. The ring cannot grow without bound ────────────────────────────────────────────
void ring_bounds() {
    CaptureWindow w;
    feed(w, 0, 15000, PT_PERIOD_MS, 20000);  // 60 s at 250 Hz
    CHECK(w.size(UID) <= fsw::calibration::kRingMax, "ring %zu should be capped at %zu",
          w.size(UID), fsw::calibration::kRingMax);
    // Span eviction should bite first at this rate: 4 s at 250 Hz is ~1000 samples.
    CHECK(w.size(UID) <= 1010, "span eviction should hold the ring near 4 s, got %zu", w.size(UID));
}

// ── 8. uids() is the live set ────────────────────────────────────────────────────────
void uids_reports_live_sensors() {
    CaptureWindow w;
    const uint64_t ns = EPOCH;
    w.push(2101, 10, ns, ns);
    w.push(4101, 20, ns, ns);
    w.push(2201, 30, ns, ns);
    const std::vector<uint16_t> ids = w.uids();
    CHECK(ids.size() == 3, "expected 3 uids, got %zu", ids.size());
    CHECK(ids[0] == 2101 && ids[1] == 2201 && ids[2] == 4101, "uids should come back sorted");

    w.clear(4101);
    CHECK(w.uids().size() == 2, "clear(uid) should drop just that one");
}

}  // namespace

int main() {
    std::printf("CaptureWindow tests\n");
    low_rate_step_after_settle();
    window_bound_high_rate();
    stale_sensor_rejected();
    empty_and_too_few();
    clear_on_reconnect();
    settle_detection();
    ring_bounds();
    uids_reports_live_sensors();

    if (g_failures == 0)
        std::printf("  ✅ all passed\n");
    else
        std::printf("  %d failure(s)\n", g_failures);
    return g_failures ? 1 : 0;
}
