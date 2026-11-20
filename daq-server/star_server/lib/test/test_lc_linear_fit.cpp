/**
 * The load-cell "linear" calibration model, and why it is a load cell's default.
 *
 * The problem, in the operator's words: calibrate a scale with its readings in the 400-500k ADC
 * range; the next day its zero has drifted to 200k; press Tare. The tare is an ADC code that is
 * evaluated through the live curve (LcTareStore), so what the display shows is
 * curve(live) - curve(tare code). On a straight line that difference depends only on how far the
 * code moved, so a pure zero shift cancels exactly. A cubic fitted over 400-500k is evaluated two
 * spans below its data there, where the curvature it picked up from capture noise has grown, and
 * the tared reading is off by a load-dependent amount.
 *
 *  1. linear_model_fits_a_line                  — degree 1 whatever the point count
 *  2. linear_needs_two_points                   — a one-point "line" is a constant; none is kept
 *  3. cubic_model_is_unchanged                  — the default PT path fits exactly as before
 *  4. a_model_change_refits_without_a_capture   — config cubic -> linear moves the live curve
 *  5. tare_cancels_zero_drift_on_linear_not_cubic — the operator's scenario, through LcTareStore
 *  6. both_fits_are_serialized                  — the page draws linear beside cubic
 *  7. raw_coefficients_match_the_normalized_form — the service streams A..D, the browser poly
 */

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include "calibration/CubicCalibrationStore.hpp"
#include "calibration/LcTareStore.hpp"

using fsw::calibration::CubicCalibrationStore;
using fsw::calibration::CubicChannel;
using fsw::calibration::CubicFit;
using fsw::calibration::CubicPoint;
using fsw::calibration::lc_tare_entity;
using fsw::calibration::LcTareStore;
using fsw::calibration::SensorKind;

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

constexpr uint16_t kUid = 4201;  // LC board 42, connector 1

std::string scratch(const char* name) {
    static int seq = 0;
    auto p = std::filesystem::temp_directory_path() /
             ("lc_linear_" + std::string(name) + "_" + std::to_string(++seq) + ".json");
    std::filesystem::remove(p);
    return p.string();
}

/** Evaluate a fit the way the browser does (normalized form). */
double eval_norm(const CubicFit& f, double adc) {
    const double x = (adc - f.norm_min) / (f.norm_scale != 0.0 ? f.norm_scale : 1.0);
    double y = 0.0, xp = 1.0;
    for (double c : f.poly) {
        y += c * xp;
        xp *= x;
    }
    return y;
}

/** Evaluate a fit the way calibration_service does (raw A..D, PolynomialCalibration). */
double eval_raw(const CubicFit& f, double adc) {
    return ((f.A * adc + f.B) * adc + f.C) * adc + f.D;
}

/**
 * A real load cell over 400-500k: 100 kg across 100k counts, linear, with the few-tenths-of-a-kg
 * scatter an operator's captures carry (a settling load, a mass placed slightly off-centre).
 */
std::vector<CubicPoint> drifting_scale_points() {
    const double codes[] = {400e3, 425e3, 450e3, 475e3, 500e3};
    const double noise_kg[] = {0.3, -0.2, 0.25, -0.3, 0.2};
    std::vector<CubicPoint> pts;
    for (int i = 0; i < 5; ++i)
        pts.push_back({codes[i], (codes[i] - 400e3) * 0.001 + noise_kg[i], 0.0});
    return pts;
}

void fill(CubicCalibrationStore& s, const std::string& model, const std::vector<CubicPoint>& pts) {
    s.register_channel(kUid, 42, 1, 11, "LOX Scale", model, SensorKind::LC);
    for (const auto& p : pts)
        s.add_point(kUid, p.adc, p.psi);
}

// ── 1 ──────────────────────────────────────────────────────────────────────
void linear_model_fits_a_line() {
    CubicCalibrationStore s(scratch("line"));
    fill(s, "linear", drifting_scale_points());
    const CubicFit* f = s.fit_for(kUid);
    CHECK(f != nullptr, "a linear channel with 5 points must have a fit");
    if (f == nullptr)
        return;
    CHECK(f->degree == 1, "linear must fit degree 1, got %d", f->degree);
    CHECK(f->A == 0.0 && f->B == 0.0, "a line has no cubic or square term (A=%g B=%g)", f->A, f->B);
    CHECK(std::fabs(f->C - 0.001) < 2e-5, "slope should be ~0.001 kg/count, got %g", f->C);
    CHECK(s.channel(kUid)->status == "OK", "status should be OK, got %s",
          s.channel(kUid)->status.c_str());
}

// ── 2 ──────────────────────────────────────────────────────────────────────
void linear_needs_two_points() {
    CubicCalibrationStore s(scratch("one"));
    s.register_channel(kUid, 42, 1, 11, "LOX Scale", "linear", SensorKind::LC);
    s.add_point(kUid, 400e3, 0.0);
    CHECK(s.fit_for(kUid) == nullptr,
          "one point is not a line: no fit, so the service streams physics instead");
    CHECK(s.channel(kUid)->status == "PENDING", "one point should be PENDING, got %s",
          s.channel(kUid)->status.c_str());
    s.add_point(kUid, 500e3, 100.0);
    const CubicFit* f = s.fit_for(kUid);
    CHECK(f != nullptr && f->degree == 1, "two points make a line");
}

// ── 3 ──────────────────────────────────────────────────────────────────────
void cubic_model_is_unchanged() {
    const auto pts = drifting_scale_points();
    CubicCalibrationStore s(scratch("cubic"));
    fill(s, "cubic", pts);
    const CubicFit* f = s.fit_for(kUid);
    const CubicFit ref = CubicCalibrationStore::compute_fit(pts);  // the old one-argument call
    CHECK(f != nullptr && f->degree == 3, "cubic with 5 points stays degree 3");
    if (f != nullptr)
        CHECK(f->A == ref.A && f->B == ref.B && f->C == ref.C && f->D == ref.D,
              "the cubic fit must be bit-identical to the pre-linear fit");
    // A PT channel registered the old way (no model argument) is a cubic, as it always was.
    CubicCalibrationStore pt(scratch("pt"));
    pt.register_channel(2201, 22, 1, 11, "Fuel Upstream");
    for (const auto& p : pts)
        pt.add_point(2201, p.adc, p.psi);
    CHECK(pt.fit_for(2201) != nullptr && pt.fit_for(2201)->degree == 3,
          "a PT with the default model must still fit a cubic");
}

// ── 4 ──────────────────────────────────────────────────────────────────────
void a_model_change_refits_without_a_capture() {
    CubicCalibrationStore s(scratch("swap"));
    fill(s, "cubic", drifting_scale_points());
    CHECK(s.fit_for(kUid)->degree == 3, "starts cubic");
    s.register_channel(kUid, 42, 1, 11, "LOX Scale", "linear", SensorKind::LC);
    CHECK(s.fit_for(kUid) != nullptr && s.fit_for(kUid)->degree == 1,
          "switching the config to linear must refit the points as a line");
    s.register_channel(kUid, 42, 1, 11, "LOX Scale", "cubic", SensorKind::LC);
    CHECK(s.fit_for(kUid) != nullptr && s.fit_for(kUid)->degree == 3, "and back to cubic");
}

// ── 5 ──────────────────────────────────────────────────────────────────────
/**
 * The scenario. A tank is on the scale; the scale's zero has drifted from 400k to 200k overnight
 * (the whole curve slid 200k counts down; the sensitivity did not change). The operator tares
 * with nothing on it, then puts the tank on. What reads?
 */
double tared_reading(const CubicFit& f, double zero_code, double tank_kg) {
    LcTareStore tares(scratch("tare"));
    const auto eval = [&](double adc) {
        return eval_raw(f, adc);
    };
    tares.set(kUid, lc_tare_entity(42, 1), zero_code, eval);
    const double live_code = zero_code + tank_kg / 0.001;  // 0.001 kg/count, the true slope
    return eval(live_code) - tares.tare_for(kUid)->offset_kg;
}

void tare_cancels_zero_drift_on_linear_not_cubic() {
    const auto pts = drifting_scale_points();
    CubicCalibrationStore lin(scratch("tl"));
    fill(lin, "linear", pts);
    CubicCalibrationStore cub(scratch("tc"));
    fill(cub, "cubic", pts);
    const CubicFit lf = *lin.fit_for(kUid);
    const CubicFit cf = *cub.fit_for(kUid);

    for (double tank : {25.0, 50.0, 100.0}) {
        // In range (zero where it was calibrated), both are fine.
        const double lin_home = tared_reading(lf, 400e3, tank);
        const double cub_home = tared_reading(cf, 400e3, tank);
        // Drifted to 200k: two spans below every captured point.
        const double lin_drift = tared_reading(lf, 200e3, tank);
        const double cub_drift = tared_reading(cf, 200e3, tank);
        std::printf(
            "    tank %5.1f kg | at home: linear %7.2f cubic %7.2f | zero at 200k: "
            "linear %7.2f cubic %9.2f\n",
            tank, lin_home, cub_home, lin_drift, cub_drift);

        CHECK(std::fabs(lin_drift - lin_home) < 1e-6,
              "on a line a zero shift must cancel exactly: %f at home vs %f drifted", lin_home,
              lin_drift);
        CHECK(std::fabs(lin_drift - tank) < 0.5, "linear tared reading %f for a %f kg tank",
              lin_drift, tank);
        // The defect is not that the cubic is wrong — at home it is as good as the line — but
        // that what it reads after a tare depends on where the zero has drifted to. With this
        // fixture's +/-0.3 kg capture scatter that is ~1-2 kg at 200k, growing with the cube of
        // the distance; a scatterier capture set or a farther drift is worse.
        CHECK(std::fabs(cub_drift - cub_home) > 0.5,
              "expected the cubic's tared reading to move with the drift (%f at home, %f at 200k)"
              " — if this fails the fixture no longer demonstrates the problem",
              cub_home, cub_drift);
    }
}

// ── 6 ──────────────────────────────────────────────────────────────────────
void both_fits_are_serialized() {
    const std::string path = scratch("ser");
    {
        CubicCalibrationStore s(path);
        fill(s, "linear", drifting_scale_points());
        CHECK(s.save(), "save");
    }
    std::ifstream in(path);
    const auto root = nlohmann::json::parse(in);
    const auto& ch = root["cubic_state"][std::to_string(kUid)];
    CHECK(ch["active_model"] == "linear", "active_model should say linear");
    CHECK(ch["degree"] == 1, "the active fit is the line");
    CHECK(ch["fits"]["linear"]["valid"] == true && ch["fits"]["linear"]["degree"] == 1,
          "fits.linear present");
    CHECK(ch["fits"]["cubic"]["valid"] == true && ch["fits"]["cubic"]["degree"] == 3,
          "fits.cubic present, for the comparison overlay");
    // The logical-channel map the service loads at startup carries the ACTIVE fit: the line.
    const auto& raw = root["lc_calibration_polynomials"]["11"];
    CHECK(raw.is_array() && raw[0] == 0.0 && raw[1] == 0.0,
          "lc_calibration_polynomials must carry the line (A = B = 0)");

    // And it survives a restart: load re-fits from the points per the model.
    CubicCalibrationStore again(path);
    again.register_channel(kUid, 42, 1, 11, "LOX Scale", "linear", SensorKind::LC);
    CHECK(again.load() == 1, "reload one channel");
    CHECK(again.fit_for(kUid) != nullptr && again.fit_for(kUid)->degree == 1, "reloaded as a line");
    std::filesystem::remove(path);
}

// ── 7 ──────────────────────────────────────────────────────────────────────
void raw_coefficients_match_the_normalized_form() {
    CubicCalibrationStore s(scratch("raw"));
    fill(s, "linear", drifting_scale_points());
    const CubicFit& f = *s.fit_for(kUid);
    for (double adc : {0.0, 200e3, 450e3, 1e6}) {
        CHECK(std::fabs(eval_raw(f, adc) - eval_norm(f, adc)) < 1e-6,
              "raw and normalized disagree at %g: %f vs %f", adc, eval_raw(f, adc),
              eval_norm(f, adc));
    }
}

}  // namespace

int main() {
    std::printf("LC linear fit\n");
    linear_model_fits_a_line();
    linear_needs_two_points();
    cubic_model_is_unchanged();
    a_model_change_refits_without_a_capture();
    tare_cancels_zero_drift_on_linear_not_cubic();
    both_fits_are_serialized();
    raw_coefficients_match_the_normalized_form();
    if (g_failures == 0) {
        std::printf("  ✅ all passed\n");
        return 0;
    }
    std::printf("  %d failure(s)\n", g_failures);
    return 1;
}
