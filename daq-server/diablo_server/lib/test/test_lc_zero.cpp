/**
 * LcZeroStore — re-establishing which ADC code means "nothing on the scale".
 *
 * The bug this store exists to fix, in the operator's words: on one day an empty load cell reads
 * ADC code 500k, on the next it reads -300k, in a wet outdoor environment. The calibration was
 * captured over codes 500k-600k. A cubic fitted over a 100k-wide window and then evaluated eight
 * windows outside it does not return a slightly-offset answer — it returns one dominated by the
 * cubic term. Case 1 pins exactly that: an EMPTY cell reading -656 kg, and reading 0 again after
 * a re-zero, with the calibration untouched.
 *
 * Case 2 is the one that fails under the design this one was chosen over. Translating the cubic's
 * coefficients by the shift is exact and a one-liner, and it compounds: ten re-zeros translate ten
 * times. Measuring every shift against the STATIC calibration instead makes ten re-zeros give the
 * same answer as one, and leaves adc_at_zero over days as a drift record rather than a lost one.
 *
 *   1. a_drifted_zero_reads_garbage_until_it_is_rezeroed  — the reported bug
 *   2. rezeroing_ten_times_does_not_accumulate            — why the calibration is not edited
 *   3. cal_zero_adc_comes_from_the_operators_empty_point  — a measurement beats a root
 *   4. bisection_is_the_fallback_when_there_is_no_point
 *   5. a_calibration_that_never_spanned_zero_is_refused   — refusing beats guessing
 *   6. no_points_is_refused
 *   7. physics_basis_is_code_zero
 *   8. shift_re_derives_when_the_calibration_is_refitted
 *   9. untrusted_curves_keep_the_last_good_shift
 *  10. an_unzeroed_channel_shifts_by_nothing              — the feature is additive by default
 *  11. fingerprint_tracks_the_basis_not_the_shift         — the self-reference trap
 *  12. stale_audit_finds_a_missed_recompute
 *  13. save_load_round_trip
 *  14. unreadable_file_is_not_overwritten
 */

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

#include "calibration/LcTareStore.hpp"
#include "calibration/LcZeroStore.hpp"

using fsw::calibration::lc_tare_entity;
using fsw::calibration::LcZero;
using fsw::calibration::LcZeroStore;
using fsw::calibration::physics_zero_basis;
using fsw::calibration::zero_basis_from_points;
using fsw::calibration::ZeroBasis;

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

/** A unique scratch path per test — hermetic, no committed fixtures, parallel-safe. */
std::string scratch(const char* name) {
    static int seq = 0;
    auto p = std::filesystem::temp_directory_path() /
             ("lc_zero_" + std::string(name) + "_" + std::to_string(++seq) + ".json");
    std::filesystem::remove(p);
    return p.string();
}

std::string read_text(const std::string& path) {
    std::ifstream f(path);
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

// ── the stand-in for a real calibration ─────────────────────────────────────
//
// A cubic fitted over codes 500k-600k mapping to 0-50 kg. The cubic term is deliberately the size
// a least-squares fit over a narrow window picks up from noise: 0.5 kg at the far edge of the
// window, 1% of reading — invisible in the calibration report, and the entire answer eight windows
// away, because its contribution grows as the cube of the distance while the linear term grows
// linearly. That asymmetry is the mechanism, not the magnitude of any one coefficient.

constexpr double kCalZeroCode = 500000.0;  // the code the operator captured with an empty scale
constexpr double kKgPerCount = 5.0e-4;     // 100k codes = 50 kg
constexpr double kCubic = 5.0e-16;

double curve(double adc) {
    const double d = adc - kCalZeroCode;
    return d * kKgPerCount + kCubic * d * d * d;
}

/** The operator's captured points: an empty scale, then four known masses. */
std::vector<std::pair<double, double>> points_with_empty_scale() {
    std::vector<std::pair<double, double>> pts;
    for (int i = 0; i <= 4; ++i) {
        const double adc = kCalZeroCode + 25000.0 * i;
        pts.emplace_back(adc, curve(adc));
    }
    return pts;
}

ZeroBasis basis_with_empty_scale() {
    return zero_basis_from_points(points_with_empty_scale(), curve);
}

// ── 1. the reported bug ─────────────────────────────────────────────────────

void a_drifted_zero_reads_garbage_until_it_is_rezeroed() {
    LcZeroStore s(scratch("drift"));

    // Overnight the bridge's electrical zero moves: the EMPTY cell now sits at -300k, not 500k.
    constexpr double kDriftedZeroCode = -300000.0;

    // Before re-zeroing, the curve is asked for a code eight fit-windows below anything it was
    // ever constrained over. This is the number on the operator's screen for an empty scale.
    const double garbage = curve(kDriftedZeroCode);
    CHECK(garbage < -100.0, "an empty cell should read wildly wrong before a re-zero, got %f kg",
          garbage);

    CHECK(s.set(4201, lc_tare_entity(42, 1), kDriftedZeroCode, basis_with_empty_scale()),
          "the re-zero should be accepted — the calibration has an empty-scale point");
    const double shift = s.shift_for(4201);
    CHECK(std::fabs(shift - (kDriftedZeroCode - kCalZeroCode)) < 1e-9,
          "shift should be adc_at_zero - cal_zero_adc = -800000, got %f", shift);

    // The same empty cell, read through the same untouched curve, now that its input is shifted.
    const double zeroed = curve(kDriftedZeroCode - shift);
    CHECK(std::fabs(zeroed) < 1e-6, "an empty cell must read 0 after a re-zero, got %f kg", zeroed);

    // And a real load still weighs what it weighs: 20000 codes above the new zero is 10 kg.
    const double loaded = curve((kDriftedZeroCode + 20000.0) - shift);
    CHECK(std::fabs(loaded - 10.0) < 0.01, "10 kg should read 10 after a re-zero, got %f kg",
          loaded);
}

// ── 2. why the calibration is not edited ────────────────────────────────────

void rezeroing_ten_times_does_not_accumulate() {
    LcZeroStore s(scratch("accum"));
    const ZeroBasis basis = basis_with_empty_scale();

    for (int i = 0; i < 10; ++i)
        CHECK(s.set(4201, lc_tare_entity(42, 1), -300000.0, basis), "re-zero %d should succeed", i);

    // Translating the curve's coefficients on each press would have compounded to -8e6 by now.
    CHECK(std::fabs(s.shift_for(4201) - (-800000.0)) < 1e-9,
          "ten re-zeros at the same code must give the same shift as one, got %f",
          s.shift_for(4201));

    const LcZero* z = s.zero_for(4201);
    CHECK(z != nullptr && std::fabs(z->cal_zero_adc - kCalZeroCode) < 1e-9,
          "cal_zero_adc must still be the calibration's own 0 kg code");

    // The path accumulation actually creeps in on. set() builds a fresh record every call, so the
    // loop above cannot catch a shift that compounds — it took a mutant to notice that. recompute
    // mutates a record in place and runs on EVERY curve change, at startup, and from the stale
    // audit, so it is the one that has to be idempotent against an unchanged calibration.
    for (int i = 0; i < 10; ++i)
        s.recompute(4201, basis);
    CHECK(std::fabs(s.shift_for(4201) - (-800000.0)) < 1e-9,
          "ten recomputes against an unchanged calibration must not move the shift, got %f",
          s.shift_for(4201));

    for (int i = 0; i < 10; ++i)
        s.recompute_all([&](uint16_t) {
            return basis;
        });
    CHECK(std::fabs(s.shift_for(4201) - (-800000.0)) < 1e-9,
          "…and neither must recompute_all, got %f", s.shift_for(4201));
}

// ── 3-6. where the 0 kg code comes from ─────────────────────────────────────

void cal_zero_adc_comes_from_the_operators_empty_point() {
    const ZeroBasis b = basis_with_empty_scale();
    CHECK(b.ok, "a calibration with an empty-scale point must yield a basis");
    CHECK(std::string(b.how) == "point", "expected the point path, got %s", b.how);
    CHECK(std::fabs(b.cal_zero_adc - kCalZeroCode) < 1e-9, "cal_zero_adc should be 500000, got %f",
          b.cal_zero_adc);
    CHECK(std::fabs(b.domain_min - 500000.0) < 1e-9 && std::fabs(b.domain_max - 600000.0) < 1e-9,
          "the domain should be the captured points' own span, got [%f, %f]", b.domain_min,
          b.domain_max);
}

void bisection_is_the_fallback_when_there_is_no_point() {
    // The operator never captured an empty scale — the lightest mass they had was 5 kg. The zero
    // crossing sits just below the captured span, inside the margin, so a bracketed search finds
    // it.
    std::vector<std::pair<double, double>> pts;
    for (int i = 0; i <= 4; ++i) {
        const double adc = 510000.0 + 22500.0 * i;
        pts.emplace_back(adc, curve(adc));
    }
    const ZeroBasis b = zero_basis_from_points(pts, curve);
    CHECK(b.ok, "a curve that crosses zero inside the widened window must yield a basis");
    CHECK(std::string(b.how) == "bisect", "expected the bisect path, got %s", b.how);
    CHECK(std::fabs(b.cal_zero_adc - kCalZeroCode) < 1.0, "bisection should land on 500000, got %f",
          b.cal_zero_adc);
}

void a_calibration_that_never_spanned_zero_is_refused() {
    // Lightest captured mass is 12.5 kg, and 0 kg lies further below the window than the margin
    // reaches. There is no honest answer here, and inventing one by extrapolating the cubic is the
    // failure this whole change exists to stop.
    std::vector<std::pair<double, double>> pts;
    for (int i = 0; i <= 3; ++i) {
        const double adc = 525000.0 + 25000.0 * i;
        pts.emplace_back(adc, curve(adc));
    }
    const ZeroBasis b = zero_basis_from_points(pts, curve);
    CHECK(!b.ok, "a calibration that never spanned 0 kg must be refused, got cal_zero_adc %f",
          b.cal_zero_adc);

    LcZeroStore s(scratch("refuse"));
    CHECK(!s.set(4201, lc_tare_entity(42, 1), -300000.0, b), "set must refuse an unusable basis");
    CHECK(s.size() == 0, "nothing may be recorded when the basis is refused");
    CHECK(s.shift_for(4201) == 0.0, "a refused channel must not shift");
}

void no_points_is_refused() {
    const ZeroBasis b = zero_basis_from_points({}, curve);
    CHECK(!b.ok, "a channel with no captured points has no curve to anchor to");
}

void physics_basis_is_code_zero() {
    const ZeroBasis b = physics_zero_basis();
    CHECK(b.ok, "the datasheet conversion always has a basis");
    CHECK(b.cal_zero_adc == 0.0, "kg = (code/code_fs)*FS is zero only at code 0, got %f",
          b.cal_zero_adc);

    LcZeroStore s(scratch("phys"));
    CHECK(s.set(4202, lc_tare_entity(42, 2), 12345.0, b), "a physics channel can be zeroed");
    CHECK(std::fabs(s.shift_for(4202) - 12345.0) < 1e-9,
          "the whole code is the shift on a physics channel, got %f", s.shift_for(4202));
}

// ── 8-9. keeping the shift honest as the calibration moves ──────────────────

void shift_re_derives_when_the_calibration_is_refitted() {
    LcZeroStore s(scratch("refit"));
    CHECK(s.set(4201, lc_tare_entity(42, 1), -300000.0, basis_with_empty_scale()), "set");
    CHECK(std::fabs(s.shift_for(4201) - (-800000.0)) < 1e-9, "initial shift");

    // The operator re-captures the empty scale during a later calibration and it lands 2000 codes
    // higher. A frozen shift would now mis-zero the channel by exactly that much.
    std::vector<std::pair<double, double>> pts = points_with_empty_scale();
    for (auto& p : pts)
        p.first += 2000.0;
    ZeroBasis moved = zero_basis_from_points(pts, [](double adc) {
        return curve(adc - 2000.0);
    });
    s.recompute(4201, moved);

    CHECK(std::fabs(s.shift_for(4201) - (-802000.0)) < 1e-9,
          "the shift must re-derive against the new calibration, got %f", s.shift_for(4201));
    const LcZero* z = s.zero_for(4201);
    CHECK(z != nullptr && std::fabs(z->adc_at_zero - (-300000.0)) < 1e-9,
          "adc_at_zero is the truth and must not move");
}

void untrusted_curves_keep_the_last_good_shift() {
    LcZeroStore s(scratch("untrusted"));
    CHECK(s.set(4201, lc_tare_entity(42, 1), -300000.0, basis_with_empty_scale()), "set");

    s.set_curves_trusted(false);
    ZeroBasis nonsense;
    nonsense.ok = true;
    nonsense.cal_zero_adc = 0.0;
    s.recompute(4201, nonsense);

    CHECK(std::fabs(s.shift_for(4201) - (-800000.0)) < 1e-9,
          "an untrusted calibration must not replace a good shift, got %f", s.shift_for(4201));
}

// ── 10. additive by default ─────────────────────────────────────────────────

void an_unzeroed_channel_shifts_by_nothing() {
    LcZeroStore s(scratch("empty"));
    CHECK(s.shift_for(4201) == 0.0, "an unzeroed channel must shift by exactly 0");
    CHECK(s.zero_for(4201) == nullptr, "an unzeroed channel has no record");

    // With an empty store every published value is bit-identical to what it was before this
    // feature existed. That is what makes the whole change opt-in.
    CHECK(curve(550000.0 - s.shift_for(4201)) == curve(550000.0),
          "an unzeroed channel must evaluate exactly as it did before");
}

// ── 11. the self-reference trap ─────────────────────────────────────────────

void fingerprint_tracks_the_basis_not_the_shift() {
    const ZeroBasis basis = basis_with_empty_scale();
    LcZeroStore s(scratch("fp"));

    CHECK(s.set(4201, lc_tare_entity(42, 1), -300000.0, basis), "set");
    const uint64_t fp_a = s.zero_for(4201)->basis_fp;

    // A completely different zero against the SAME calibration. If the fingerprint hashed what the
    // evaluator does — the way LcTareStore's correctly does — the shift would change it, every
    // channel would read permanently stale, and recompute_stale would cry wolf forever.
    CHECK(s.set(4201, lc_tare_entity(42, 1), 900000.0, basis), "re-zero elsewhere");
    CHECK(s.zero_for(4201)->basis_fp == fp_a,
          "a new zero against the same calibration must not move the fingerprint");
    CHECK(std::fabs(s.shift_for(4201) - 400000.0) < 1e-9, "…but the shift must move");

    // Moving the calibration, on the other hand, must move it.
    ZeroBasis moved = basis;
    moved.cal_zero_adc += 2000.0;
    CHECK(LcZeroStore::fingerprint(moved) != fp_a, "a moved calibration must move the fingerprint");
}

void stale_audit_finds_a_missed_recompute() {
    LcZeroStore s(scratch("stale"));
    const ZeroBasis basis = basis_with_empty_scale();
    CHECK(s.set(4201, lc_tare_entity(42, 1), -300000.0, basis), "set");

    // Nothing is stale while the calibration stands still.
    CHECK(s.recompute_stale([&](uint16_t) {
        return basis;
    }) == 0,
          "an unchanged calibration must report nothing stale");

    // Now a curve moves through some path that forgot to call recompute.
    ZeroBasis moved = basis;
    moved.cal_zero_adc += 2000.0;
    CHECK(s.recompute_stale([&](uint16_t) {
        return moved;
    }) == 1,
          "a moved calibration must be caught by the audit");
    CHECK(std::fabs(s.shift_for(4201) - (-802000.0)) < 1e-9,
          "the audit must also fix what it found, got %f", s.shift_for(4201));
    CHECK(s.recompute_stale([&](uint16_t) {
        return moved;
    }) == 0,
          "the audit must settle after it has corrected");
}

// ── 13-14. persistence ──────────────────────────────────────────────────────

void save_load_round_trip() {
    const std::string path = scratch("roundtrip");
    {
        LcZeroStore s(path);
        CHECK(s.set(4201, lc_tare_entity(42, 1), -300000.0, basis_with_empty_scale()), "set");
        CHECK(s.set(4202, lc_tare_entity(42, 2), 12345.0, physics_zero_basis()), "set physics");
        CHECK(s.save(), "save should succeed");
    }
    LcZeroStore s2(path);
    CHECK(s2.load() == 2, "both zeros should come back");
    CHECK(!s2.load_failed(), "a good file must not set load_failed");
    CHECK(std::fabs(s2.shift_for(4201) - (-800000.0)) < 1e-9, "shift survives the round trip");
    const LcZero* z = s2.zero_for(4201);
    CHECK(z != nullptr && z->entity == "LC2_Cal.CH1",
          "the entity string must survive verbatim — Node keys on it");
    CHECK(z != nullptr && std::fabs(z->domain_max - 600000.0) < 1e-9,
          "the fit window must survive, it drives the out-of-domain guard");
}

void unreadable_file_is_not_overwritten() {
    const std::string path = scratch("corrupt");
    {
        std::ofstream f(path);
        f << "{ this is not json";
    }
    LcZeroStore s(path);
    CHECK(s.load() == 0, "corrupt file loads nothing");
    CHECK(s.load_failed(), "corrupt file must set load_failed");
    CHECK(!s.save(), "save must be refused while load_failed");
    CHECK(read_text(path) == "{ this is not json", "the file must be left exactly as found");
}

}  // namespace

int main() {
    std::printf("LcZeroStore tests\n");
    a_drifted_zero_reads_garbage_until_it_is_rezeroed();
    rezeroing_ten_times_does_not_accumulate();
    cal_zero_adc_comes_from_the_operators_empty_point();
    bisection_is_the_fallback_when_there_is_no_point();
    a_calibration_that_never_spanned_zero_is_refused();
    no_points_is_refused();
    physics_basis_is_code_zero();
    shift_re_derives_when_the_calibration_is_refitted();
    untrusted_curves_keep_the_last_good_shift();
    an_unzeroed_channel_shifts_by_nothing();
    fingerprint_tracks_the_basis_not_the_shift();
    stale_audit_finds_a_missed_recompute();
    save_load_round_trip();
    unreadable_file_is_not_overwritten();

    if (g_failures == 0)
        std::printf("  ✅ all passed\n");
    else
        std::printf("  %d failure(s)\n", g_failures);
    return g_failures ? 1 : 0;
}
