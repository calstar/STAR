/**
 * LcTareStore — the guards that keep a load-cell tare from becoming a confident wrong number.
 *
 * The bug this whole store exists to prevent, in the operator's words: a 20 kg tank sits on a
 * scale whose calibration is a bad two-point fit reading it as 18. The operator tares and the
 * display reads 0. Later they add points, the fit improves, and the same tank evaluates to 20.
 * A tare persisted as "18 kg" then displays 2 kg for a tank that never moved — plausible enough
 * that nobody questions it. Persisting the ADC CODE instead and re-deriving through the current
 * curve gives 20 - 20 = 0. Case 1 pins exactly that.
 *
 *  1. recompute_carries_tare_across_a_better_fit  — the 2 kg bug
 *  2. untrusted_curves_keep_the_last_good_offset  — a failed cubic load must not zero a tare
 *  3. non_finite_offset_is_never_recorded         — a degenerate fit kills the series downstream
 *  4. entity_matches_the_publish_path             — Node keys on this string; slot != board_id
 *  5. loaded_tare_is_corrected_by_recompute       — startup ordering: stale offset must self-heal
 *  6. fingerprint_tracks_what_the_curve_does      — staleness is detectable, not assumed
 *  7. stale_audit_finds_a_missed_recompute       — a hook nobody added still gets caught
 */

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <limits>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>

#include "calibration/LcTareStore.hpp"

using fsw::calibration::lc_tare_entity;
using fsw::calibration::LcTare;
using fsw::calibration::LcTareStore;
using json = nlohmann::json;

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
             ("lc_tare_" + std::string(name) + "_" + std::to_string(++seq) + ".json");
    std::filesystem::remove(p);
    return p.string();
}

std::string read_text(const std::string& path) {
    std::ifstream f(path);
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

/** A linear adc->kg curve, standing in for select_lc_kg. */
LcTareStore::Evaluator linear(double kg_per_count) {
    return [kg_per_count](double adc) { return adc * kg_per_count; };
}

// ── 1. the 2 kg bug ─────────────────────────────────────────────────────────

void recompute_carries_tare_across_a_better_fit() {
    LcTareStore s(scratch("recal"));

    // Bad fit: the tank's true 20 kg reads as 18. adc 1000 -> 18 kg.
    const auto bad = linear(0.018);
    CHECK(s.set(4201, lc_tare_entity(42, 1), 1000.0, bad), "set should succeed");
    const LcTare* t = s.tare_for(4201);
    CHECK(t != nullptr, "tare should exist");
    CHECK(std::fabs(t->offset_kg - 18.0) < 1e-9, "offset under the bad fit should be 18, got %f",
          t->offset_kg);

    // The operator clears the scale, hangs a known mass, types its TRUE weight; the fit improves
    // so that the same code now evaluates to the tank's real 20 kg.
    const auto good = linear(0.020);
    s.recompute(4201, good);

    t = s.tare_for(4201);
    CHECK(std::fabs(t->offset_kg - 20.0) < 1e-9,
          "offset must re-derive to 20 under the better fit, got %f", t->offset_kg);
    CHECK(std::fabs(t->adc_at_tare - 1000.0) < 1e-9, "adc_at_tare is the truth and must not move");

    // What the operator sees with the tank back on the scale: good(1000) - offset == 0.
    const double displayed = good(1000.0) - t->offset_kg;
    CHECK(std::fabs(displayed) < 1e-9, "the tank must still read 0 after the re-cal, got %f kg",
          displayed);
}

// ── 2. an untrusted curve must not overwrite a good offset ──────────────────

void untrusted_curves_keep_the_last_good_offset() {
    LcTareStore s(scratch("untrusted"));
    CHECK(s.set(4201, lc_tare_entity(42, 1), 1000.0, linear(0.020)), "set should succeed");
    const double good_offset = s.tare_for(4201)->offset_kg;
    CHECK(std::fabs(good_offset - 20.0) < 1e-9, "baseline offset should be 20, got %f",
          good_offset);

    // The cubic store failed to load, so every curve currently evaluates to a flat zero. A
    // recompute through it would replace 20 kg with 0 and the tank would suddenly read its full
    // weight, with nothing on screen to say why.
    s.set_curves_trusted(false);
    s.recompute(4201, linear(0.0));

    CHECK(std::fabs(s.tare_for(4201)->offset_kg - good_offset) < 1e-9,
          "an untrusted recompute must keep the last good offset, got %f",
          s.tare_for(4201)->offset_kg);

    // And once the curves are trustworthy again it does update.
    s.set_curves_trusted(true);
    s.recompute(4201, linear(0.030));
    CHECK(std::fabs(s.tare_for(4201)->offset_kg - 30.0) < 1e-9,
          "a trusted recompute must update, got %f", s.tare_for(4201)->offset_kg);
}

// ── 3. non-finite offsets are never recorded ────────────────────────────────

void non_finite_offset_is_never_recorded() {
    LcTareStore s(scratch("nonfinite"));

    // A degenerate one-point fit can evaluate to inf/NaN. Node subtracts offset_kg from every
    // sample; a NaN there is dropped by the finite guard downstream and the whole series simply
    // vanishes from the plot with no error anywhere.
    const auto blown_up = [](double) { return std::numeric_limits<double>::quiet_NaN(); };
    CHECK(!s.set(4201, lc_tare_entity(42, 1), 1000.0, blown_up), "a NaN offset must be refused");
    CHECK(s.tare_for(4201) == nullptr, "nothing may be recorded for a refused tare");

    const auto inf_curve = [](double) { return std::numeric_limits<double>::infinity(); };
    CHECK(!s.set(4202, lc_tare_entity(42, 2), 1000.0, inf_curve), "an inf offset must be refused");
    CHECK(s.size() == 0, "store must still be empty, has %zu", s.size());

    // A good tare that later sees a blown-up curve keeps its offset rather than adopting NaN.
    CHECK(s.set(4203, lc_tare_entity(42, 3), 500.0, linear(0.02)), "good set should succeed");
    s.recompute(4203, blown_up);
    CHECK(std::isfinite(s.tare_for(4203)->offset_kg), "offset must stay finite after a bad curve");
    CHECK(std::fabs(s.tare_for(4203)->offset_kg - 10.0) < 1e-9, "offset must be unchanged, got %f",
          s.tare_for(4203)->offset_kg);
}

// ── 4. the entity string Node keys on ───────────────────────────────────────

void entity_matches_the_publish_path() {
    // DatabaseConfig names the calibrated LC VTable LC<board_number>_Cal.CH<ch>, where
    // board_number is board_id % 10 with 0 -> 10. Getting this wrong means C++ writes a key the
    // backend never looks up, and the tare silently never applies.
    CHECK(lc_tare_entity(42, 1) == "LC2_Cal.CH1", "board 42 ch 1 -> LC2_Cal.CH1, got %s",
          lc_tare_entity(42, 1).c_str());
    CHECK(lc_tare_entity(41, 6) == "LC1_Cal.CH6", "board 41 ch 6 -> LC1_Cal.CH6, got %s",
          lc_tare_entity(41, 6).c_str());
    // slot is NOT board_id: board 42 is slot 2, not 42.
    CHECK(lc_tare_entity(42, 1) != "LC42_Cal.CH1", "must use the slot, not the raw board id");
    // 0 -> 10, the documented edge (id 10, id 20).
    CHECK(lc_tare_entity(10, 3) == "LC10_Cal.CH3", "board 10 ch 3 -> LC10_Cal.CH3, got %s",
          lc_tare_entity(10, 3).c_str());
}

// ── 5. a stale offset from disk self-heals on recompute ─────────────────────

void loaded_tare_is_corrected_by_recompute() {
    const std::string path = scratch("startup");

    // Hand-write a record whose offset_kg belongs to a curve that is no longer live — exactly
    // what a profile swapped while the service was down leaves behind.
    json root;
    root["version"] = 1;
    json t;
    t["uid"] = 4201;
    t["entity"] = "LC2_Cal.CH1";
    t["adc_at_tare"] = 1000.0;
    t["offset_kg"] = 18.0;  // stale: computed against the old curve
    t["set_at_ms"] = 1757800000000.0;
    t["curve_fp"] = 12345;
    root["tares"] = json::array({t});
    {
        std::ofstream f(path);
        f << root.dump(2);
    }

    LcTareStore s(path);
    CHECK(s.load() == 1, "one tare should load");
    CHECK(std::fabs(s.tare_for(4201)->offset_kg - 18.0) < 1e-9, "loads the stale value verbatim");

    // The startup recompute is what corrects it. If the tare file is loaded AFTER the live store
    // reload instead of before, this never runs and the stand carries the stale offset all run.
    s.recompute_all([](uint16_t) { return linear(0.020); });
    CHECK(std::fabs(s.tare_for(4201)->offset_kg - 20.0) < 1e-9,
          "the startup recompute must correct a stale offset, got %f",
          s.tare_for(4201)->offset_kg);
}

// ── 6. the staleness fingerprint ────────────────────────────────────────────

void fingerprint_tracks_what_the_curve_does() {
    const auto a = linear(0.020);
    const auto b = linear(0.030);

    CHECK(LcTareStore::fingerprint(a) == LcTareStore::fingerprint(linear(0.020)),
          "the same curve must fingerprint the same — otherwise every read looks stale");
    CHECK(LcTareStore::fingerprint(a) != LcTareStore::fingerprint(b),
          "a changed curve must change the fingerprint");

    // The fingerprint follows the curve the offset was computed against.
    LcTareStore s(scratch("fp"));
    CHECK(s.set(4201, lc_tare_entity(42, 1), 1000.0, a), "set should succeed");
    CHECK(s.tare_for(4201)->curve_fp == LcTareStore::fingerprint(a), "fp must match the set curve");
    s.recompute(4201, b);
    CHECK(s.tare_for(4201)->curve_fp == LcTareStore::fingerprint(b),
          "fp must follow a recompute onto a new curve");
}

// ── 7. the audit that catches a missed recompute hook ───────────────────────

void stale_audit_finds_a_missed_recompute() {
    LcTareStore s(scratch("audit"));
    CHECK(s.set(4201, lc_tare_entity(42, 1), 1000.0, linear(0.020)), "set should succeed");

    // Nothing has changed: the audit must report zero, or it would cry wolf on every startup and
    // the warning would stop meaning anything.
    CHECK(s.recompute_stale([](uint16_t) { return linear(0.020); }) == 0,
          "an unchanged curve must not be reported stale");
    CHECK(std::fabs(s.tare_for(4201)->offset_kg - 20.0) < 1e-9, "and the offset is untouched");

    // Now the curve moves WITHOUT a recompute — the shape of a missed hook, and of reading the
    // tare file after the startup reload instead of before it.
    const size_t stale = s.recompute_stale([](uint16_t) { return linear(0.030); });
    CHECK(stale == 1, "a moved curve must be reported stale, got %zu", stale);
    CHECK(std::fabs(s.tare_for(4201)->offset_kg - 30.0) < 1e-9,
          "and must be re-derived, got %f", s.tare_for(4201)->offset_kg);

    // Having fixed it, a second audit is quiet.
    CHECK(s.recompute_stale([](uint16_t) { return linear(0.030); }) == 0,
          "the audit must be quiet once it has healed");
}

// ── round trip ──────────────────────────────────────────────────────────────

void save_load_round_trip() {
    const std::string path = scratch("roundtrip");
    {
        LcTareStore s(path);
        CHECK(s.set(4201, lc_tare_entity(42, 1), 1000.0, linear(0.020)), "set");
        CHECK(s.set(4206, lc_tare_entity(42, 6), -250.0, linear(0.020)), "set negative adc");
        CHECK(s.save(), "save");
    }
    LcTareStore s2(path);
    CHECK(s2.load() == 2, "two tares should load");
    CHECK(!s2.load_failed(), "a good file is not a failed load");
    CHECK(s2.tare_for(4201)->entity == "LC2_Cal.CH1", "entity round-trips");
    CHECK(std::fabs(s2.tare_for(4206)->offset_kg + 5.0) < 1e-9, "negative offset round-trips, got %f",
          s2.tare_for(4206)->offset_kg);

    // A missing file is the normal post-session-start state, not a failure — it must not block
    // the next save the way an unreadable file does.
    LcTareStore s3(scratch("absent"));
    CHECK(s3.load() == 0, "absent file loads nothing");
    CHECK(!s3.load_failed(), "an absent file is not a failed load");
}

void unreadable_file_is_not_overwritten() {
    const std::string path = scratch("corrupt");
    {
        std::ofstream f(path);
        f << "{ this is not json";
    }
    LcTareStore s(path);
    CHECK(s.load() == 0, "corrupt file loads nothing");
    CHECK(s.load_failed(), "corrupt file must set load_failed");
    CHECK(!s.save(), "save must be refused while load_failed");
    CHECK(read_text(path) == "{ this is not json", "the file must be left exactly as found");
}

}  // namespace

int main() {
    std::printf("LcTareStore tests\n");
    recompute_carries_tare_across_a_better_fit();
    untrusted_curves_keep_the_last_good_offset();
    non_finite_offset_is_never_recorded();
    entity_matches_the_publish_path();
    loaded_tare_is_corrected_by_recompute();
    fingerprint_tracks_what_the_curve_does();
    stale_audit_finds_a_missed_recompute();
    save_load_round_trip();
    unreadable_file_is_not_overwritten();

    if (g_failures == 0)
        std::printf("  ✅ all passed\n");
    else
        std::printf("  %d failure(s)\n", g_failures);
    return g_failures ? 1 : 0;
}
