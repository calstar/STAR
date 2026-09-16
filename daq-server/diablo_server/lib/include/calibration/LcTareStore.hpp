#ifndef LC_TARE_STORE_HPP
#define LC_TARE_STORE_HPP

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace fsw {
namespace calibration {

/**
 * The publish-path entity name for an LC channel: "LC<slot>_Cal.CH<connector>", where slot is
 * board_id % 10 with 0 -> 10 — the same rule DatabaseConfig uses to name the calibrated LC
 * VTables, and the same board_number the LC publish path already holds.
 *
 * It exists as one shared function because the failure mode of a second copy is specific and
 * has already happened: slot is NOT board_id, so PT board 22 and LC board 42 are both slot 2,
 * and deriving a uid back out of an entity string collides them. Node must key on this string
 * rather than re-derive it.
 */
std::string lc_tare_entity(uint8_t board_id, uint8_t connector);

/**
 * One load cell's tare: the scale reads zero at the load it was holding when the operator
 * pressed Tare.
 *
 * A tare is NOT a calibration point, and the difference is the reason this store exists
 * separately from CubicCalibrationStore. A vented PT genuinely is at 0 psig, so capturing a
 * zero on one is a true reference point and belongs in the shared fit. A load cell holding a
 * tank is not at 0 kg: capturing that as a zero would inject a false point, and because
 * add_point re-runs a least-squares fit over every point, it would tilt the whole cubic rather
 * than shift its intercept. LC therefore gets a display-only tare, and its zero-capture keeps
 * meaning "unloaded".
 *
 * WHAT IS STORED IS THE ADC CODE, NOT THE KILOGRAMS.
 *
 * `offset_kg` is a derived cache, re-evaluated from `adc_at_tare` through the current curve on
 * every re-fit, clear, and profile swap. Persisting kilograms as the truth is the bug this
 * layout exists to prevent: tare a 20 kg tank against a bad two-point fit that reads it as 18,
 * improve the fit until the same tank evaluates to 20, and a frozen 18 kg offset displays 2 kg
 * for a tank that never moved — a plausible-looking wrong number on a pad display. Re-deriving
 * from the code gives 20 - 20 = 0.
 *
 * Subtraction happens in kilograms, never in counts: the curve is a cubic, so offsetting its
 * input shifts the slope you get instead of translating its output.
 */
struct LcTare {
    uint16_t uid = 0;          // board_id*100 + connector
    std::string entity;        // publish-path identity, e.g. "LC2_Cal.CH1" — see set()
    double adc_at_tare = 0.0;  // the truth
    double offset_kg = 0.0;    // derived from adc_at_tare through the live curve; a cache
    double set_at_ms = 0.0;    // unix milliseconds, for "tared 2h ago"
    uint64_t curve_fp = 0;     // fingerprint of the curve offset_kg was computed against
};

/**
 * Owns the per-channel tares for the calibration service. Thread-safe, persisted atomically to
 * one JSON file (temp + rename) that the Node backend reads to apply the subtraction — the
 * service never sends the value, because [0x46,0x00] is one-way and there is no reply packet.
 * This mirrors how cubic calibration already reaches the UI.
 *
 * Ownership, which is deliberately asymmetric: C++ is the STEADY-STATE writer. Node may remove
 * the file, but only while sensor-calibration is not running. That is what lets a tare be
 * cleared at session start and still survive a service restart inside a session — two
 * requirements that together force a file that is persistent AND externally cleared. Neither
 * half is redundant; do not "simplify" one away.
 */
class LcTareStore {
public:
    explicit LcTareStore(std::string file_path);

    /** adc -> kg through whichever model this uid streams (select_lc_kg: cubic fit or the
     *  datasheet physics conversion). Taken as a callable so this class never learns which. */
    using Evaluator = std::function<double(double adc)>;

    /**
     * Record a tare for `uid` at `adc_at_tare` and derive its offset. `entity` is the
     * publish-path name (LC<slot>_Cal.CH<connector>) computed by the caller from the same
     * board_number/channel the LC publish path uses; Node keys on this string and must never
     * re-derive it, because slot is board_id % 10 and two boards of different kinds share a
     * slot — the collision that put a load cell's curve on a 5000 psi transducer in Sep 2026.
     *
     * Returns false and records nothing when the curve yields a non-finite offset (a degenerate
     * one-point fit does), because a NaN offset downstream silently kills the whole series.
     */
    bool set(uint16_t uid, const std::string& entity, double adc_at_tare, const Evaluator& eval);

    void clear(uint16_t uid);
    void clear_all();

    /** Re-derive offset_kg for one uid under the current curve. No-op when the uid is untared. */
    void recompute(uint16_t uid, const Evaluator& eval);

    /** Re-derive every tare; `eval_for` supplies each uid's evaluator. Call after any change to
     *  an LC curve: a capture, a clear, a profile swap, or startup. */
    void recompute_all(const std::function<Evaluator(uint16_t)>& eval_for);

    /**
     * Re-derive only the tares whose recorded fingerprint disagrees with the curve now live, and
     * return how many those were. Zero is the expected answer: every path that moves a curve is
     * supposed to recompute already.
     *
     * A non-zero answer means one didn't, and the caller should say so loudly — it is the audit
     * that makes a missed recompute hook visible instead of silently subtracting kilograms
     * derived from a curve that no longer exists. In particular it catches the startup ordering
     * mistake of reading this file AFTER the live store reload, where the reload's own recompute
     * runs over an empty map and every restored offset stays stale.
     */
    size_t recompute_stale(const std::function<Evaluator(uint16_t)>& eval_for);

    /**
     * False while the curves cannot be trusted — set when the cubic store failed to load. A
     * recompute then keeps the last good offset rather than replacing it with one computed
     * against a zeroed curve, which would read as a confident wrong number.
     */
    void set_curves_trusted(bool trusted);
    bool curves_trusted() const;

    const LcTare* tare_for(uint16_t uid) const;
    std::vector<uint16_t> uids() const;
    size_t size() const;

    /** Atomically write the JSON record (temp + rename). Blocked while load_failed(). */
    bool save() const;

    /** Load the JSON record. Returns tares loaded. */
    size_t load();

    /** Set when load() could not read an existing file; blocks save() so an unreadable store is
     *  never replaced by the empty one we fell back to. Mirrors CubicCalibrationStore. */
    bool load_failed() const;

    /**
     * A fingerprint of what a curve *does*, not of the coefficients that describe it: the
     * evaluator is sampled at fixed probe codes and the results hashed. Model-agnostic by
     * construction, so a cubic re-fit, a cleared channel and a flip to the physics conversion
     * all move it, and a no-op re-save does not. Cheap defence in depth — if some future path
     * mutates a curve without calling recompute, a mismatched fingerprint makes the stale
     * offset visible instead of silently subtracted.
     */
    static uint64_t fingerprint(const Evaluator& eval);

private:
    mutable std::mutex mutex_;
    std::string file_path_;
    bool load_failed_ = false;
    bool curves_trusted_ = true;
    std::map<uint16_t, LcTare> tares_;

    std::string serialize() const;  // caller holds mutex_
    /** Caller holds mutex_. Returns false when the curve yields a non-finite offset. */
    bool recompute_locked(LcTare& t, const Evaluator& eval);
};

}  // namespace calibration
}  // namespace fsw

#endif  // LC_TARE_STORE_HPP
