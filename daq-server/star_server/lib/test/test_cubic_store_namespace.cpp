/**
 * Unit tests for the PT/LC split in fsw::calibration::CubicCalibrationStore.
 *
 * logical_ch is (slot - 1) * 10 + connector with slot = board_id % 10, and check_board_slots
 * only stops two boards of the SAME kind sharing a slot. So PT board 22 and LC board 42 are
 * both slot 2, and PT uid 2201 and LC uid 4201 both land on logical channel 11. The
 * logical-keyed maps were written from a uid-ordered map, so the higher uid silently won: on
 * 2026-09-13 the LOX Scale's curve replaced GN2 High's (a 5000 psi transducer) on disk, and
 * evaluating GN2 High's ADCs against it gave 1.2e10 psi.
 *
 * These tests pin the split and the recovery. Recovery needs no migration: load() reads only
 * cubic_state and recomputes every fit from the points, which survived.
 *
 *  1. the field collision at logical 11        4. legacy file without "kind"
 *  2. the second live collision at logical 1   5. add_point refuses an unknown uid
 *  3. kind round-trips through the file        6. recovery regenerates the PT curve
 */

#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>

#include "calibration/CubicCalibrationStore.hpp"

using fsw::calibration::CubicCalibrationStore;
using fsw::calibration::SensorKind;
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
             ("cubic_ns_" + std::string(name) + "_" + std::to_string(++seq) + ".json");
    std::filesystem::remove(p);
    return p.string();
}

json read_json(const std::string& path) {
    std::ifstream f(path);
    json j;
    f >> j;
    return j;
}

double eval_abcd(const json& arr, double x) {
    const double A = arr[0], B = arr[1], C = arr[2], D = arr[3];
    return A * x * x * x + B * x * x + C * x + D;
}

/** GN2 High's real captured shape: a 5000 psi PT, ADC codes in the hundreds of millions. */
void add_pt_points(CubicCalibrationStore& s, uint16_t uid) {
    s.add_point(uid, 413578828.0, 0.0);
    s.add_point(uid, 488735724.0, 225.0);
    s.add_point(uid, 546113706.0, 400.0);
    s.add_point(uid, 579791093.0, 501.0);
}

/** The LOX Scale's real captured shape: a load cell, codes in the hundreds of thousands. */
void add_lc_points(CubicCalibrationStore& s, uint16_t uid) {
    s.add_point(uid, 598340.0, 0.0);
    s.add_point(uid, 802135.0, 4.536);
    s.add_point(uid, 1013776.0, 9.072);
    s.add_point(uid, 1114800.0, 11.34);
}

// ── 1. The collision that actually happened ──────────────────────────────────────────
void pt_lc_logical_collision() {
    const std::string path = scratch("collision11");
    CubicCalibrationStore s(path);
    // PT board 22 → slot 2, connector 1 → logical 11.  LC board 42 → the same logical 11.
    s.register_channel(2201, 22, 1, 11, "GN2 High", "cubic", SensorKind::PT);
    s.register_channel(4201, 42, 1, 11, "LOX Scale", "cubic", SensorKind::LC);
    add_pt_points(s, 2201);
    add_lc_points(s, 4201);
    CHECK(s.save(), "save should succeed");

    const json j = read_json(path);
    CHECK(j.contains("calibration_polynomials") && j["calibration_polynomials"].contains("11"),
          "PT map should hold logical 11");
    CHECK(j.contains("lc_calibration_polynomials") &&
              j["lc_calibration_polynomials"].contains("11"),
          "LC map should hold logical 11");

    // The PT map must evaluate the PT's own points — this is what used to give ~1e10.
    const double psi = eval_abcd(j["calibration_polynomials"]["11"], 579791093.0);
    CHECK(std::fabs(psi - 501.0) < 5.0, "PT logical 11 should give ~501 psi, got %.4g", psi);

    // And the LC map the load cell's.
    const double kg = eval_abcd(j["lc_calibration_polynomials"]["11"], 1114800.0);
    CHECK(std::fabs(kg - 11.34) < 0.1, "LC logical 11 should give ~11.34 kg, got %.4g", kg);
}

// ── 2. The other live collision ──────────────────────────────────────────────────────
void logical_1_collision() {
    const std::string path = scratch("collision1");
    CubicCalibrationStore s(path);
    s.register_channel(2101, 21, 1, 1, "Fuel Fill Vent", "cubic", SensorKind::PT);
    s.register_channel(4101, 41, 1, 1, "Fuel Scale", "cubic", SensorKind::LC);
    add_pt_points(s, 2101);
    add_lc_points(s, 4101);
    CHECK(s.save(), "save should succeed");

    const json j = read_json(path);
    const double psi = eval_abcd(j["calibration_polynomials"]["1"], 579791093.0);
    const double kg = eval_abcd(j["lc_calibration_polynomials"]["1"], 1114800.0);
    CHECK(std::fabs(psi - 501.0) < 5.0, "PT logical 1 should give ~501 psi, got %.4g", psi);
    CHECK(std::fabs(kg - 11.34) < 0.1, "LC logical 1 should give ~11.34 kg, got %.4g", kg);
}

// ── 3. kind survives the file, on the orphan path ────────────────────────────────────
void kind_round_trip() {
    const std::string path = scratch("roundtrip");
    {
        CubicCalibrationStore s(path);
        s.register_channel(2201, 22, 1, 11, "GN2 High", "cubic", SensorKind::PT);
        s.register_channel(4201, 42, 1, 11, "LOX Scale", "cubic", SensorKind::LC);
        add_pt_points(s, 2201);
        add_lc_points(s, 4201);
        s.save();
    }
    // Fresh store, NO register_channel: every entry takes the orphan path and must get its
    // kind from the file, or the two would collapse back into one map.
    CubicCalibrationStore s2(path);
    CHECK(s2.load() == 2, "both channels should load");
    CHECK(s2.save(), "re-save should succeed");

    const json j = read_json(path);
    CHECK(j["calibration_polynomials"].contains("11"), "PT map should survive a blind reload");
    CHECK(j["lc_calibration_polynomials"].contains("11"), "LC map should survive a blind reload");
    const double psi = eval_abcd(j["calibration_polynomials"]["11"], 579791093.0);
    CHECK(std::fabs(psi - 501.0) < 5.0, "PT curve should still be the PT's, got %.4g", psi);
}

// ── 4. A file written before the split ───────────────────────────────────────────────
void legacy_file_without_kind() {
    const std::string path = scratch("legacy");
    {  // hand-build a cubic_state with no "kind" anywhere
        json j;
        j["cubic_state"] = json::object();
        for (const auto& [uid, role] : {std::pair<const char*, const char*>{"2201", "GN2 High"},
                                        std::pair<const char*, const char*>{"4201", "LOX Scale"}}) {
            json cj;
            cj["boardId"] = std::string(uid).substr(0, 2) == "22" ? 22 : 42;
            cj["connector"] = 1;
            cj["logicalCh"] = 11;
            cj["role"] = role;
            cj["active_model"] = "cubic";
            cj["points"] = json::array();
            j["cubic_state"][uid] = cj;
        }
        std::ofstream f(path);
        f << j.dump(2);
    }
    CubicCalibrationStore s(path);
    // Config registers both, with their true kinds — config wins over the file, as for
    // active_model. A legacy file therefore comes out right for every configured channel.
    s.register_channel(2201, 22, 1, 11, "GN2 High", "cubic", SensorKind::PT);
    s.register_channel(4201, 42, 1, 11, "LOX Scale", "cubic", SensorKind::LC);
    CHECK(s.load() == 2, "legacy entries should load");
    add_pt_points(s, 2201);
    add_lc_points(s, 4201);
    CHECK(s.save(), "save should succeed");

    const json j = read_json(path);
    const double psi = eval_abcd(j["calibration_polynomials"]["11"], 579791093.0);
    const double kg = eval_abcd(j["lc_calibration_polynomials"]["11"], 1114800.0);
    CHECK(std::fabs(psi - 501.0) < 5.0, "legacy PT should land in the PT map, got %.4g", psi);
    CHECK(std::fabs(kg - 11.34) < 0.1, "legacy LC should land in the LC map, got %.4g", kg);
}

// ── 5. An unknown uid is refused, not invented ───────────────────────────────────────
void add_point_rejects_unknown_uid() {
    const std::string path = scratch("unknown");
    CubicCalibrationStore s(path);
    s.register_channel(2201, 22, 1, 11, "GN2 High", "cubic", SensorKind::PT);

    const auto fit = s.add_point(9999, 123456.0, 10.0);
    CHECK(!fit.valid, "an unregistered uid must not produce a fit");
    CHECK(s.channel(9999) == nullptr, "an unregistered uid must not create a channel");
    CHECK(s.uids().size() == 1, "uids() should still hold just the registered one, got %zu",
          s.uids().size());
}

// ── 6. Recovery: the overwritten PT curve comes back from its surviving points ───────
void recovery_regenerates_overwritten_pt_curve() {
    const std::string path = scratch("recovery");
    {  // Reproduce the corrupted file: both kinds present, one shared logical map, LC winning.
        CubicCalibrationStore s(path);
        s.register_channel(2201, 22, 1, 11, "GN2 High", "cubic", SensorKind::PT);
        s.register_channel(4201, 42, 1, 11, "LOX Scale", "cubic", SensorKind::LC);
        add_pt_points(s, 2201);
        add_lc_points(s, 4201);
        s.save();

        json j = read_json(path);
        j["calibration_polynomials"]["11"] = j["lc_calibration_polynomials"]["11"];  // the damage
        j.erase("lc_calibration_polynomials");
        {
            std::ofstream f(path);
            f << j.dump(2);
        }

        const double bad = eval_abcd(read_json(path)["calibration_polynomials"]["11"], 579791093.0);
        CHECK(std::fabs(bad - 501.0) > 1000.0,
              "sanity: the corrupted curve should be absurd (%.4g)", bad);
    }

    // Load + save is the whole recovery. No migration, no hand-editing.
    CubicCalibrationStore s(path);
    s.register_channel(2201, 22, 1, 11, "GN2 High", "cubic", SensorKind::PT);
    s.register_channel(4201, 42, 1, 11, "LOX Scale", "cubic", SensorKind::LC);
    CHECK(s.load() == 2, "both channels should load from cubic_state");
    CHECK(s.save(), "save should succeed");

    const json j = read_json(path);
    const double psi = eval_abcd(j["calibration_polynomials"]["11"], 579791093.0);
    CHECK(std::fabs(psi - 501.0) < 5.0, "PT curve should be restored to ~501 psi, got %.4g", psi);
}

// ── 7. An unreadable store is never replaced by an empty one ─────────────────────────
void unreadable_file_is_not_overwritten() {
    const std::string path = scratch("corrupt");
    {
        std::ofstream f(path);
        f << "{ this is not json";
    }
    CubicCalibrationStore s(path);
    CHECK(s.load() == 0, "a corrupt file loads nothing");
    CHECK(!s.save(), "save must refuse after a failed load — the file is the only copy");

    std::ifstream f(path);
    std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    CHECK(content == "{ this is not json", "the original bytes must be untouched, got '%s'",
          content.c_str());
}

}  // namespace

// ── 8. A role that moves between an ESP32 board and a LabJack T7 ─────────────────────
// Calibration is filed by role, so "LOX Tank" moving from PT board 21 to T7 board 81 would carry
// a fit in ADC codes (hundreds of millions per volt-ish) onto a channel that reads microvolts.
void role_moved_to_t7_keeps_its_unit() {
    const std::string path = scratch("t7move");
    {
        CubicCalibrationStore s(path);
        s.register_channel(2101, 21, 1, 1, "LOX Tank", "cubic", SensorKind::PT);
        add_pt_points(s, 2101);
        CHECK(s.save(), "save should succeed");
        CHECK(read_json(path)["cubic_state"]["2101"]["rawUnit"] == "adc",
              "an ESP32 channel is saved with rawUnit adc");
    }
    {
        // Now the role lives on a T7: uid 8101, logical channel 129, readings in uV.
        CubicCalibrationStore s(path);
        s.register_channel(8101, 81, 1, 129, "LOX Tank", "cubic", SensorKind::PT, "uV");
        s.load();
        const auto* t7 = s.channel(8101);
        CHECK(t7 != nullptr && t7->points.empty() && !t7->fit.valid,
              "the ADC-code fit must NOT attach to the T7 channel");
        const auto* old = s.channel(2101);
        CHECK(old != nullptr && old->points.size() == 4 && old->raw_unit == "adc",
              "the ESP32 points stay, as an orphan at their own uid");
        CHECK(s.save(), "save should succeed");
        const json j = read_json(path);
        CHECK(j["cubic_state"].contains("2101") && j["cubic_state"]["2101"]["numPoints"] == 4,
              "and survive the next save instead of being dropped");
        CHECK(j["cubic_state"]["8101"]["rawUnit"] == "uV", "the T7 channel is saved as uV");
    }
}

// ── 9. Same unit still follows the role, and a T7 orphan keeps its logical channel ────
void t7_role_follows_within_t7() {
    const std::string path = scratch("t7follow");
    {
        CubicCalibrationStore s(path);
        s.register_channel(8101, 81, 1, 129, "LOX Tank", "cubic", SensorKind::PT, "uV");
        s.add_point(8101, 0.0, 0.0);
        s.add_point(8101, 2500000.0, 500.0);
        s.add_point(8101, 5000000.0, 1000.0);
        CHECK(s.save(), "save should succeed");
    }
    {
        // Rewired from AIN1 to AIN3 on the same T7.
        CubicCalibrationStore s(path);
        s.register_channel(8103, 81, 3, 131, "LOX Tank", "cubic", SensorKind::PT, "uV");
        s.load();
        const auto* moved = s.channel(8103);
        CHECK(moved != nullptr && moved->points.size() == 3 && moved->fit.valid,
              "a uV fit follows its role to another T7 input");
        CHECK(s.save(), "save should succeed");
    }
    {
        // The T7 is gone from config: its entry is an orphan, and must keep logical channel 129
        // rather than be re-derived as ESP32 slot 1 connector 1 (logical 1, a live PT's).
        CubicCalibrationStore s(path);
        s.register_channel(2101, 21, 1, 1, "Fuel Upstream", "cubic", SensorKind::PT);
        s.load();
        const auto* orphan = s.channel(8103);
        CHECK(orphan != nullptr && orphan->logical_ch == 131 && orphan->raw_unit == "uV",
              "a T7 orphan keeps its own logical channel and unit");
        CHECK(s.save(), "save should succeed");
        const json j = read_json(path);
        CHECK(!j["calibration_polynomials"].contains("1"),
              "nothing lands on ESP32 logical channel 1");
    }
}

// ── 10. A DISABLED board's entry must not reach a live sensor's logical channel ───────
// 2026-11-09, the stand: LC board 41 was set enabled = false. Its three saved entries
// (connectors 1, 6, 7 — one point each, so no valid fit) resumed as orphans, and the service's
// LC/PT discriminant was built from ENABLED boards, so it took them for PTs. Iterating uids in
// order, it set PT logical 1/6/7 from 2101/2106/2107 and then CLEARED them from 4101/4106/4107.
// FT-PT-R, FF-PT and DR-PT-G streamed 0 psi with healthy raw ADC and a good cubic on disk.
// cal_target() is what the service now asks, and an orphan answers None.
void disabled_board_orphan_is_not_applied() {
    const std::string path = scratch("disabledlc");
    {  // Both boards enabled: the PT is calibrated, the load cell has a single point.
        CubicCalibrationStore s(path);
        s.register_channel(2101, 21, 1, 1, "FT-PT-R", "cubic", SensorKind::PT);
        s.register_channel(4101, 41, 1, 1, "LC-1", "linear", SensorKind::LC);
        add_pt_points(s, 2101);
        s.add_point(4101, 598340.0, 0.0);
        CHECK(s.save(), "save should succeed");
    }
    // LC board 41 is now disabled: only the PT board registers.
    CubicCalibrationStore s(path);
    s.register_channel(2101, 21, 1, 1, "FT-PT-R", "cubic", SensorKind::PT);
    CHECK(s.load() == 2, "both entries should still load — an orphan's points are kept");

    const auto* pt = s.channel(2101);
    const auto* orphan = s.channel(4101);
    CHECK(pt != nullptr && orphan != nullptr, "both channels should be present");
    if (pt == nullptr || orphan == nullptr)
        return;

    // The collision is the premise: if these ever stop sharing a logical channel the test below
    // would pass for the wrong reason.
    CHECK(pt->logical_ch == 1 && orphan->logical_ch == 1,
          "premise: PT 2101 and LC 4101 share logical channel 1 (got %u and %u)",
          static_cast<unsigned>(pt->logical_ch), static_cast<unsigned>(orphan->logical_ch));
    // And so is the invalid fit: one point under a linear model is what made the service clear.
    CHECK(!orphan->fit.valid, "premise: a one-point linear fit is invalid");
    CHECK(pt->fit.valid, "premise: the PT's own cubic is good");

    CHECK(fsw::calibration::cal_target(*pt) == fsw::calibration::CalTarget::PT,
          "a live PT applies to the PT manager");
    CHECK(fsw::calibration::cal_target(*orphan) == fsw::calibration::CalTarget::None,
          "a disabled board's entry must reach NEITHER manager — it would clear logical 1");

    // It must also not be mistaken for the LC it is: were it applied as an LC it would clear
    // LC logical 1, and a live LC board in slot 1 would lose its curve the same way.
    CHECK(orphan->kind == SensorKind::LC, "the orphan still knows it is a load cell");
}

// ── 11. A removed board's still-good curve must not win the logical-channel map ───────
// The same collision one step out, and inside a single kind where the SensorKind split cannot
// help: `calibration_polynomials` is keyed by logical channel and written in uid order, and the
// Node backend's loadCalibrationJSON keys its own CalibrationMap from it. A PT board in slot 1
// that is dropped from config keeps a VALID fit, and its uid sorts after the live board's — so it
// used to overwrite the live sensor's curve on disk, in the file that is the only record of it.
void removed_board_does_not_win_the_logical_map() {
    const std::string path = scratch("removedpt");
    {  // Two PT boards, both slot 1 (board 21 and board 91) → both logical channel 1.
        CubicCalibrationStore s(path);
        s.register_channel(2101, 21, 1, 1, "FT-PT-R", "cubic", SensorKind::PT);
        s.register_channel(9101, 91, 1, 1, "Spare PT", "cubic", SensorKind::PT);
        add_pt_points(s, 2101);
        // The spare's own curve: same shape, deliberately offset so the two are told apart.
        s.add_point(9101, 413578828.0, 1000.0);
        s.add_point(9101, 488735724.0, 1225.0);
        s.add_point(9101, 546113706.0, 1400.0);
        s.add_point(9101, 579791093.0, 1501.0);
        CHECK(s.save(), "save should succeed");
    }
    // Board 91 is gone from config. Only board 21 registers.
    CubicCalibrationStore s(path);
    s.register_channel(2101, 21, 1, 1, "FT-PT-R", "cubic", SensorKind::PT);
    CHECK(s.load() == 2, "both entries load");

    const auto* orphan = s.channel(9101);
    CHECK(orphan != nullptr && orphan->logical_ch == 1 && orphan->fit.valid,
          "premise: the orphan shares logical channel 1 AND still has a valid fit");
    CHECK(s.save(), "save should succeed");

    const json j = read_json(path);
    CHECK(j["calibration_polynomials"].contains("1"), "the live PT keeps its map entry");
    const double psi = eval_abcd(j["calibration_polynomials"]["1"], 579791093.0);
    CHECK(std::fabs(psi - 501.0) < 5.0,
          "logical 1 must be the LIVE sensor's curve (~501 psi), got %.4g", psi);
    // And the orphan's points survive for when its board comes back.
    CHECK(j["cubic_state"].contains("9101") && j["cubic_state"]["9101"]["numPoints"] == 4,
          "the orphan's points are kept in cubic_state");
}

int main() {
    std::printf("CubicCalibrationStore PT/LC namespace tests\n");
    pt_lc_logical_collision();
    logical_1_collision();
    kind_round_trip();
    legacy_file_without_kind();
    add_point_rejects_unknown_uid();
    recovery_regenerates_overwritten_pt_curve();
    unreadable_file_is_not_overwritten();
    role_moved_to_t7_keeps_its_unit();
    t7_role_follows_within_t7();
    disabled_board_orphan_is_not_applied();
    removed_board_does_not_win_the_logical_map();

    if (g_failures == 0)
        std::printf("  ✅ all passed\n");
    else
        std::printf("  %d failure(s)\n", g_failures);
    return g_failures ? 1 : 0;
}
