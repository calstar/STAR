#ifndef LC_ZERO_STORE_HPP
#define LC_ZERO_STORE_HPP

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace fsw {
namespace calibration {

/**
 * One load cell's ZERO: which raw ADC code means "nothing on the scale", today.
 *
 * A zero is NOT a tare, and the whole reason this store exists beside LcTareStore is that the two
 * answer different questions and cannot substitute for each other:
 *
 *   - A TARE says "the load sitting on the cell right now is my new reference". It is subtracted
 *     AFTER the curve, in kilograms, and is correct for a cell holding a tank.
 *   - A ZERO says "the bridge's electrical zero has moved". It shifts the curve's INPUT, in ADC
 *     codes, and is the only thing that answers overnight drift.
 *
 * Subtracting in kilograms cannot fix a drifted zero, because the curve is a cubic fitted over a
 * narrow window of codes and evaluated in raw ADC space. Once the operating point walks outside
 * that window the reading is not merely offset — it is dominated by the cubic term. A real stored
 * curve, eight fit-windows below its domain, reads 10158 psi on a channel calibrated over 57-501.
 * Shifting the input puts the operating point back INSIDE the window, which is what actually fixes
 * the number; an offset in kilograms leaves it outside and wrong.
 *
 * Shifting the input is legitimate here because a load cell's nonlinearity is indexed by LOAD
 * (bridge geometry, flexure), not by absolute ADC code — sigma-delta INL is single-digit ppm. So
 * the honest model is kg = f(code - z) with f fixed and z drifting, and a re-zero re-estimates z.
 *
 * THE CALIBRATION IS NEVER EDITED.
 *
 * That is the design decision this store is built around, and it is not an implementation detail.
 * The alternative — translating the cubic's coefficients by the shift, which is exact and a
 * one-liner — was rejected because it compounds (ten re-zeros translate ten times), it leaves the
 * stored calibration points no longer lying on their own curve, and it destroys the accumulated
 * drift record. Here the shift is always measured against the STATIC calibration, so ten re-zeros
 * give exactly the same answer as one, and `adc_at_zero` logged over days against a fixed
 * `cal_zero_adc` IS the drift measurement.
 */
struct LcZero {
    uint16_t uid = 0;           // board_id*100 + connector
    std::string entity;         // publish-path identity, e.g. "LC2_Cal.CH1" — see lc_tare_entity
    double adc_at_zero = 0.0;   // the truth: the code read with the cell unloaded
    double cal_zero_adc = 0.0;  // derived: the code the STATIC calibration maps to 0 kg
    double shift_codes = 0.0;   // derived cache: adc_at_zero - cal_zero_adc
    double domain_min = 0.0;    // derived: the fit window, for the out-of-domain guard
    double domain_max = 0.0;
    double set_at_ms = 0.0;  // unix milliseconds, for "zeroed 14h ago"
    uint64_t basis_fp = 0;   // fingerprint of the basis shift_codes was derived against
};

/**
 * Where a channel's "0 kg code" came from, and whether it could be found at all.
 *
 * `how` is carried because the answer's provenance decides how much to trust it: a stored 0 kg
 * calibration point is an operator's measurement, while a bisected root is an inference from a
 * curve that may never have been evaluated near zero.
 */
struct ZeroBasis {
    bool ok = false;  // false -> refuse the re-zero; record nothing
    double cal_zero_adc = 0.0;
    double domain_min = 0.0;
    double domain_max = 0.0;
    const char* how = "none";  // "point" | "bisect" | "physics" | "none"
};

/**
 * Find the code the static calibration maps to 0 kg.
 *
 * Order matters and is not arbitrary:
 *
 *  1. The mean `adc` of the captured points whose reference value is 0. An operator calibrating a
 *     load cell starts from an empty scale, so this point normally exists, and it is a MEASUREMENT
 *     rather than an inference — strictly better than any root of the fitted curve.
 *  2. Failing that, a bisection of curve(x) = 0 restricted to the captured points' own span,
 *     widened by `kDomainMargin`. The restriction is the entire point: outside its fit window a
 *     cubic's roots are noise, and PTCalibrationCoeffs::invert_to_adc — which brackets the whole
 *     int32 range in two halves assuming monotonicity within each — will happily return one of
 *     them, hundreds of millions of codes away. Do not reuse it here.
 *  3. Failing that, refuse. A channel whose calibration never spanned 0 kg has nothing to anchor a
 *     zero to, and a channel with no points has no curve at all. Refusing is the correct answer;
 *     guessing produces a plausible wrong number on a pad display.
 *
 * `points` is (adc, reference_value) — CubicPoint's {adc, psi}, where psi carries kg for a load
 * cell. Taken as a plain vector rather than CubicChannel so this is testable without the store.
 */
ZeroBasis zero_basis_from_points(const std::vector<std::pair<double, double>>& points,
                                 const std::function<double(double)>& curve);

/** The physics-model basis: kg = (code/code_fs)*FS is zero only at code 0, exactly, and the
 *  datasheet conversion has no fit window, so the domain is the whole signed ADC range. */
ZeroBasis physics_zero_basis();

/** How far outside the captured points' span the bisection in zero_basis_from_points may look,
 *  as a fraction of that span. A little slack, because the empty-scale point is often at the very
 *  edge of the window; not enough to leave the region the fit was constrained over. */
constexpr double kDomainMargin = 0.25;

/**
 * Owns the per-channel zeros for the calibration service. Thread-safe, persisted atomically to one
 * JSON file (temp + rename), mirroring LcTareStore because the failure modes are the same ones.
 *
 * Unlike the tare file, this one is NOT removed at session start: a zero describes the hardware's
 * drift, not the run, so an operator zeroes an unloaded cell once and every session that day
 * inherits it. That makes a standing zero something nobody chose on the day it is used, so the
 * service logs every one it resumes, with its age.
 */
class LcZeroStore {
public:
    explicit LcZeroStore(std::string file_path);

    /** Supplies a uid's basis. Taken as a callable so this class never learns what a cubic is. */
    using BasisFn = std::function<ZeroBasis(uint16_t uid)>;

    /**
     * Record a zero for `uid` at `adc_at_zero` and derive its shift. `entity` is the publish-path
     * name computed by the caller with lc_tare_entity(); Node keys on that string and must never
     * re-derive it, because slot is board_id % 10 and two boards of different kinds share a slot.
     *
     * Returns false and records NOTHING when the basis is not ok or the derived shift is not
     * finite. A zero that cannot be substantiated is worse than no zero: it would shift every
     * sample on the channel for the rest of the run.
     */
    bool set(uint16_t uid, const std::string& entity, double adc_at_zero, const ZeroBasis& basis);

    void clear(uint16_t uid);
    void clear_all();

    /**
     * The shift to subtract from a live code before evaluating the curve. 0.0 when the uid has no
     * zero — which is what makes this feature additive: with an empty store every published value
     * is bit-identical to what it was before the store existed.
     */
    double shift_for(uint16_t uid) const;

    /** Re-derive one uid's shift against the current calibration. No-op when the uid has no zero.
     */
    void recompute(uint16_t uid, const ZeroBasis& basis);

    /** Re-derive every zero. Call after ANY change to an LC curve: a capture, a clear, a profile
     *  swap, or startup. A re-fit moves cal_zero_adc, and a frozen shift would then mis-zero the
     *  channel by exactly how much the fit improved. */
    void recompute_all(const BasisFn& basis_for);

    /**
     * Re-derive only the zeros whose recorded fingerprint disagrees with the calibration now live,
     * and return how many those were. Zero is the expected answer; a non-zero answer means some
     * path moved a curve without recomputing, and the caller should say so loudly rather than let
     * a stale shift be silently applied to every sample.
     */
    size_t recompute_stale(const BasisFn& basis_for);

    /** False while the curves cannot be trusted — set when the cubic store failed to load. A
     *  recompute then keeps the last good shift rather than replacing it with one derived from a
     *  zeroed curve, which would read as a confident wrong number. */
    void set_curves_trusted(bool trusted);
    bool curves_trusted() const;

    const LcZero* zero_for(uint16_t uid) const;
    std::vector<uint16_t> uids() const;
    size_t size() const;

    /** Atomically write the JSON record (temp + rename). Blocked while load_failed(). */
    bool save() const;

    /** Load the JSON record. Returns zeros loaded. */
    size_t load();

    /** Set when load() could not read an existing file; blocks save() so an unreadable store is
     *  never replaced by the empty one we fell back to. Mirrors LcTareStore. */
    bool load_failed() const;

    /**
     * A fingerprint of the BASIS, not of the curve: cal_zero_adc and the fit window, hashed.
     *
     * Deliberately not a fingerprint of the evaluator the way LcTareStore's is. The shift changes
     * what the evaluator does, so hashing the evaluator here would be self-referential — every
     * re-zero would move the fingerprint and every channel would read permanently stale. The basis
     * is derived from the static calibration and is untouched by the shift, so it moves when, and
     * only when, the calibration moves. Which is exactly the event a recompute must follow.
     */
    static uint64_t fingerprint(const ZeroBasis& basis);

private:
    mutable std::mutex mutex_;
    std::string file_path_;
    bool load_failed_ = false;
    bool curves_trusted_ = true;
    std::map<uint16_t, LcZero> zeros_;

    std::string serialize() const;  // caller holds mutex_
    /** Caller holds mutex_. Returns false when the basis is unusable or the shift is not finite. */
    bool recompute_locked(LcZero& z, const ZeroBasis& basis);
};

}  // namespace calibration
}  // namespace fsw

#endif  // LC_ZERO_STORE_HPP
