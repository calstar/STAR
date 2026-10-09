#ifndef FSW_CAPTURE_WINDOW_HPP
#define FSW_CAPTURE_WINDOW_HPP

/**
 * @file CaptureWindow.hpp
 * @brief The ADC a calibration capture records: a bounded, recent, checked mean.
 *
 * A capture must answer "what is this sensor reading RIGHT NOW", and the answer has to
 * mean the same thing on a 250 Hz pressure transducer and on a 13 Hz load cell.
 *
 * It did not. The calibration service kept a plain `deque<int32_t>` of the last 128
 * samples per sensor and averaged the whole thing, with this comment:
 *
 *     constexpr size_t kPtAdcRingMax = 128;   // ~0.5 s of samples at ~250 Hz
 *
 * No board on the rig runs at 250 Hz. Measured pre-downsample ingest: PT 61-68 Hz,
 * RTD 26 Hz, actuators 10 Hz, and a load cell **13.7 Hz**. So the same 128 samples is
 * 2 s on a PT and **9.3 s** on a load cell, and every capture averaged the last nine
 * seconds of the scale. On 2026-09-13 an operator added weight and captured 13 s later;
 * roughly a quarter of the window still held the previous load, and the point landed 26%
 * short of the line (steps of 52241, 53737, then 39238 counts per equal 2.268 kg). Three
 * separate ZERO-load captures spanned 29,087 counts while the live signal's sigma was
 * 798 — 36 sigma, impossible as noise, ordinary as a moving average over nine seconds.
 *
 * So the window is bounded in TIME, not in samples, and two different clocks answer two
 * different questions:
 *
 *  - MEMBERSHIP uses the sample timestamp `ts_ns` (the bridge's reconstructed host-epoch
 *    time), measured relative to the NEWEST sample in this sensor's ring rather than to
 *    wall-now. Anchoring on the newest sample cancels any constant offset between the
 *    board's epoch and ours, so transport lag longer than the window can never starve
 *    every capture.
 *  - LIVENESS uses `rx_ns`, our own monotonic arrival stamp, against the capture's
 *    `now_rx_ns`. Clock-domain-pure, so it is immune to board clock skew — and it is what
 *    rejects a dead sensor, or a reconnect burst of samples that are old in our terms.
 *
 * SETTLING. A window can be recent and still wrong, if the load changed inside it. The
 * check compares the mean of the window's first half against its second half, normalised
 * by the window's own noise, so a ramp or step reads as drift while plain noise does not.
 * Normalising is what lets one threshold serve a 4-20 mA PT (codes ~1e6) and a load cell
 * (~5e4) with nothing to tune per sensor. An unsettled capture is reported, never
 * silently dropped: the caller records the point and flags it.
 *
 * Pure and deterministic: no clock is read here — times are inputs, so the tests drive
 * every edge case (see lib/test/test_capture_window.cpp).
 *
 * NOTE on [time_sync] mode = "arrival" (BoardClockSync.hpp): that revert switch flattens
 * a whole packet onto one stamp, which coarsens `ts_ns` to per-packet resolution. The
 * newest-sample anchoring keeps membership from failing closed, and kMinCaptureSamples
 * plus the drift check still catch the pathological case — but expect fewer, chunkier
 * samples per window in that mode.
 */

#include <cstddef>
#include <cstdint>
#include <deque>
#include <unordered_map>
#include <vector>

namespace fsw {
namespace calibration {

/** How far back a capture averages. ~14 samples on a 13.7 Hz load cell (standard error
 *  ~214 counts against a 53,000-count weight step) and ~61 on a PT — while staying short
 *  enough that a load change two seconds before the button cannot leak in. */
constexpr uint64_t kCaptureWindowMs = 1000;
/** Newest sample older than this (in OUR clock) means the sensor is not live. */
constexpr uint64_t kMaxSampleAgeMs = 1500;
/** Below this a "mean" is not one, and the settle check has nothing to say. */
constexpr size_t kMinCaptureSamples = 3;
/** Ring eviction: by span so it self-sizes across 10-250 Hz, by count so memory is
 *  bounded if a board ever runs fast. Both are enforced on push. */
constexpr uint64_t kRingSpanMs = 4000;
constexpr size_t kRingMax = 1024;
/** Half-mean difference, in standard errors, above which the window is not settled. */
constexpr double kSettleZ = 6.0;

struct AdcSample {
    uint64_t ts_ns;  ///< sample time, board-derived (spacing is what matters)
    uint64_t rx_ns;  ///< arrival time on OUR monotonic clock
    int32_t adc;
};

/** Why a capture was refused. Stable strings — they go in the log and in the store. */
inline constexpr const char* kReasonOk = "";
inline constexpr const char* kReasonNoSamples = "no_samples";
inline constexpr const char* kReasonStale = "stale";
inline constexpr const char* kReasonTooFew = "too_few";

struct CaptureResult {
    bool ok = false;  ///< false → the caller must NOT create a point
    double adc_avg = 0.0;
    size_t n = 0;          ///< samples inside the window
    uint64_t span_ms = 0;  ///< ts span actually covered
    uint64_t age_ms = 0;   ///< how old the newest sample is, our clock
    double spread = 0.0;   ///< max - min inside the window
    double drift = 0.0;    ///< |mean(2nd half) - mean(1st half)|
    double drift_z = 0.0;  ///< drift in standard errors
    bool settled = true;   ///< false → recorded, but flagged
    const char* reason = kReasonOk;
};

/**
 * Per-sensor ring of recent samples, and the capture decision over it.
 *
 * Keyed by the calibration uid (board_id * 100 + connector). Nothing here reads a clock:
 * `push` is told when the sample was taken and when it arrived, `capture` is told what
 * time it is now.
 */
class CaptureWindow {
public:
    /** Record one sample. Evicts by span and by count. */
    void push(uint16_t uid, int32_t adc, uint64_t ts_ns, uint64_t rx_ns);

    /** What this sensor reads now, or why that cannot be answered. */
    CaptureResult capture(uint16_t uid, uint64_t now_rx_ns) const;

    /** Forget everything. Used on an Elodin reconnect, where the samples either side of
     *  the gap are not a continuous record and must never be averaged together. */
    void clear();
    void clear(uint16_t uid);

    /** Every uid with at least one sample. Zero-All iterates this rather than a
     *  last-value map, so a sensor that has gone quiet is skipped instead of being
     *  zeroed from a stale reading. */
    std::vector<uint16_t> uids() const;

    /** Samples currently held for a uid (diagnostics and tests). */
    size_t size(uint16_t uid) const;

private:
    std::unordered_map<uint16_t, std::deque<AdcSample>> rings_;
};

}  // namespace calibration
}  // namespace fsw

#endif  // FSW_CAPTURE_WINDOW_HPP
