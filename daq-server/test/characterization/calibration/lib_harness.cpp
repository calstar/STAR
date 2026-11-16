// Golden-master harness for lib/src/calibration and lib/src/t7 (test-only).
//
//   char_calibration_lib <fixtures dir>
//
// Prints what each conversion, fit and store computes for a fixed sweep of raw inputs, and the
// bytes each store writes. Fixtures are copied into a private temp dir before anything loads or
// saves them; nothing reads or writes the live scripts/calibration/calibrations files.
//
// Not covered, on purpose: IMUCalibration.cpp is commented out of fsw_daq_lib and does not compile
// on main (IMUCalibration.hpp:92 default-argument / :203 unqualified SensorType), so there is no
// behaviour to freeze; T7Stream.cpp is the LabJack socket layer, not a conversion.

#include <algorithm>
#include <array>
#include <cinttypes>
#include <climits>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "calibration/AllanVariance.hpp"
#include "calibration/CaptureWindow.hpp"
#include "calibration/CommandDedupe.hpp"
#include "calibration/CubicCalibrationStore.hpp"
#include "calibration/HpPtCode.hpp"
#include "calibration/LcTareStore.hpp"
#include "calibration/PTCalibration.hpp"
#include "calibration/PtSmoothing.hpp"
#include "calibration/RobustCalibrationFramework.hpp"
#include "calibration/RobustCalibrationManager.hpp"
#include "calibration/SensorCalibration.hpp"
#include "calibration/TypeK.hpp"
#include "calibration/ValvePosition.hpp"
#include "char_util.hpp"
#include "config/Config.hpp"
#include "t7/T7Calibration.hpp"
#include "t7/T7Convert.hpp"
#include "t7/T7Stream.hpp"

using namespace fsw::calibration;
using charcal::d;
using charcal::section;
namespace fs = std::filesystem;

namespace {

std::string g_fix;
std::string g_tmp;

std::string fix(const std::string& rel) {
    return g_fix + "/" + rel;
}

/** Copy a fixture into the temp dir (optionally renamed) and return the copy's path. */
std::string stage(const std::string& rel, const std::string& as = "") {
    const fs::path dst = fs::path(g_tmp) / (as.empty() ? fs::path(rel).filename().string() : as);
    fs::create_directories(dst.parent_path());
    fs::copy_file(fix(rel), dst, fs::copy_options::overwrite_existing);
    return dst.string();
}

const std::vector<int32_t> kI32 = {0,          1,          -1,         1000,
                                   -1000,      1 << 20,    1 << 24,    214748365,
                                   429496730,  858993460,  1073741824, 1717986918,
                                   1932735283, 2147483647, INT32_MIN,  INT32_MIN + 1,
                                   -214748365, 2126008811, 2145336164};

const std::vector<uint32_t> kU32 = {0u,          1u,          4095u,       0x7FFFFFFEu,
                                    0x7FFFFFFFu, 0x80000000u, 0x80000001u, 0xFFFF0FB5u,
                                    0xFFFFFFFFu, 412316860u,  2061584302u, 1236950581u};

const double kNaN = std::numeric_limits<double>::quiet_NaN();
const double kInf = std::numeric_limits<double>::infinity();

void pt_coeffs() {
    section("PTCalibrationCoeffs");
    const std::vector<PTCalibrationCoeffs> sets = {
        {0, 0, 0, 0},
        {0, 0, 1e-6, -214.75},
        {-1.3520622378148235e-36, 1.65948282813092e-28, 1.6294807229007227e-19,
         7.000013144506468e-11},
        {5.675824325232263e-25, -5.143032561886508e-16, 7.198658208894546e-07, -121.04762811402264},
        {-2e-27, 3e-18, 1.1e-6, -240.0},
        {1e-25, 0, -1e-6, 50.0},
    };
    for (size_t s = 0; s < sets.size(); ++s) {
        const auto& c = sets[s];
        std::printf("set %zu A=%s B=%s C=%s D=%s\n", s, d(c.A).c_str(), d(c.B).c_str(),
                    d(c.C).c_str(), d(c.D).c_str());
        for (int32_t a : kI32)
            std::printf("  psi(%d)=%s\n", a, d(c.calculate_pressure(a)).c_str());
        for (double psi : {-1e9, -100.0, 0.0, 0.25, 0.5, 100.0, 400.0, 1000.0, 5000.0, 1e9, kNaN}) {
            const auto inv = c.invert_to_adc(psi);
            std::printf("  inv(%s)=%s\n", d(psi).c_str(),
                        inv ? std::to_string(*inv).c_str() : "nullopt");
        }
    }
    section("pt_logical_calibration_channel");
    for (int slot = 0; slot <= 11; ++slot) {
        std::printf("slot %d:", slot);
        for (int c = 0; c <= 11; ++c)
            std::printf(" %d", pt_logical_calibration_channel(static_cast<uint8_t>(slot),
                                                              static_cast<uint8_t>(c)));
        std::printf("\n");
    }
    for (int slot : {26, 27, 200, 255})
        std::printf("slot %d c10 -> %d\n", slot,
                    pt_logical_calibration_channel(static_cast<uint8_t>(slot), 10));
}

void dump_ptm(const char* label, const PTCalibrationManager& m) {
    std::printf("%s: count=%zu\n", label, m.get_calibrated_count());
    for (int ch = 0; ch <= 255; ++ch) {
        const auto* c = m.get_calibration(static_cast<uint8_t>(ch));
        if (!c)
            continue;
        std::printf("  ch %d A=%s B=%s C=%s D=%s\n", ch, d(c->A).c_str(), d(c->B).c_str(),
                    d(c->C).c_str(), d(c->D).c_str());
        for (int32_t a : {0, 214748365, 245238771, 1073741824, 2147483647, INT32_MIN})
            std::printf("    p(%d)=%s\n", a,
                        d(m.calculate_pressure(static_cast<uint8_t>(ch), a)).c_str());
    }
    std::printf("  uncal ch 250 p=%s is=%d\n", d(m.calculate_pressure(250, 12345)).c_str(),
                m.is_calibrated(250) ? 1 : 0);
}

void pt_manager() {
    section("PTCalibrationManager");
    {
        PTCalibrationManager m(false);
        dump_ptm("empty", m);
        std::printf("csv ok=%d\n", m.load_from_csv(stage("pt_factory.csv")) ? 1 : 0);
        dump_ptm("csv", m);
        std::printf("json merge_missing_only ok=%d\n",
                    m.load_from_json(stage("gui_pt_calibration.json"), true) ? 1 : 0);
        dump_ptm("csv+json(missing)", m);
        std::printf("json overwrite ok=%d\n",
                    m.load_from_json(stage("gui_pt_calibration.json"), false) ? 1 : 0);
        dump_ptm("csv+json(overwrite)", m);
        m.set_calibration(7, PTCalibrationCoeffs(0, 0, 2e-6, -10));
        m.clear_calibration(1);
        dump_ptm("set7 clear1", m);
    }
    {
        // load_from_json of a cubic store (the overlay format): its calibration_polynomials map.
        PTCalibrationManager m(false);
        std::printf("store json ok=%d\n",
                    m.load_from_json(stage("profiles/restored-sep05.json", "rs.json")) ? 1 : 0);
        dump_ptm("restored-sep05", m);
        std::printf("missing file ok=%d\n", m.load_from_json(g_tmp + "/nope.json") ? 1 : 0);
        std::printf("csv missing ok=%d\n", m.load_from_csv(g_tmp + "/nope.csv") ? 1 : 0);
    }
    {
        // load_calibration(): factory CSV then the one non-skipped JSON in the dir (a single
        // candidate, so the mtime choice cannot depend on checkout order).
        const std::string dir = g_tmp + "/ptdir";
        fs::create_directories(dir);
        fs::copy_file(fix("gui_pt_calibration.json"), dir + "/calibration_gui.json");
        fs::copy_file(fix("store_mixed.json"), dir + "/cubic_calibration.json");  // skipped
        fs::copy_file(fix("store_mixed.json"), dir + "/adjustments.json");        // skipped
        PTCalibrationManager::set_default_paths(dir, stage("pt_factory.csv", "factory2.csv"));
        PTCalibrationManager m1(true);
        dump_ptm("auto_load default", m1);
        ::setenv("CAL_PT_JSON_FIRST", "1", 1);
        PTCalibrationManager m2(true);
        dump_ptm("auto_load CAL_PT_JSON_FIRST", m2);
        ::unsetenv("CAL_PT_JSON_FIRST");
        ::setenv("CAL_PT_JSON_MISSING_ONLY", "1", 1);
        PTCalibrationManager m3(true);
        dump_ptm("auto_load CAL_PT_JSON_MISSING_ONLY", m3);
        ::unsetenv("CAL_PT_JSON_MISSING_ONLY");
        PTCalibrationManager::set_default_paths(g_tmp + "/none", g_tmp + "/none.csv");
        PTCalibrationManager m4(true);
        dump_ptm("auto_load nothing", m4);
    }
}

void dump_scm(const char* label, const SensorCalibrationManager& m) {
    std::printf("%s [%s]: count=%zu\n", label, m.sensor_type().c_str(), m.calibrated_count());
    for (int ch = 0; ch <= 255; ++ch) {
        const auto* c = m.get(static_cast<uint8_t>(ch));
        if (!c)
            continue;
        std::printf("  ch %d order=%d unit=%s coeffs=", ch, c->order, c->unit.c_str());
        for (double x : c->coeffs)
            std::printf("%s ", d(x).c_str());
        std::printf("\n");
        for (int32_t a : {0, 1, -1, 120000, 2000000, 2147483647, INT32_MIN})
            std::printf("    calc(%d)=%s\n", a,
                        d(m.calculate(static_cast<uint8_t>(ch), a)).c_str());
    }
}

void sensor_cal() {
    section("PolynomialCalibration");
    const std::vector<PolynomialCalibration> polys = {
        PolynomialCalibration(),
        PolynomialCalibration(std::vector<double>{3.5}, "x"),
        PolynomialCalibration(std::vector<double>{2.0, -1.0}, "x"),
        PolynomialCalibration(1e-27, -2e-18, 1.2e-6, -200.0),
        PolynomialCalibration(std::vector<double>{1e-30, -1e-21, 1e-13, 2e-6, -1.0, 7.0}, "x"),
    };
    for (size_t i = 0; i < polys.size(); ++i) {
        const auto& p = polys[i];
        std::printf("poly %zu order=%d valid=%d unit=%s\n", i, p.order, p.is_valid() ? 1 : 0,
                    p.unit.c_str());
        for (double x : {0.0, 1.0, -1.0, 0.5, 1e6, -1e6, 2147483647.0, kNaN, kInf})
            std::printf("  ev(%s)=%s\n", d(x).c_str(), d(p.evaluate(x)).c_str());
        for (int32_t a : {12345, INT32_MIN})
            std::printf("  ev_i32(%d)=%s\n", a, d(p.evaluate(a)).c_str());
    }

    section("SensorCalibrationManager");
    {
        SensorCalibrationManager tc("TC", "degC", 3);
        std::printf("tc json ok=%d\n", tc.load_from_json(stage("tc/tc_poly.json")) ? 1 : 0);
        dump_scm("tc", tc);
    }
    {
        SensorCalibrationManager lc("LC", "kg", 3);
        std::printf("lc json ok=%d\n", lc.load_from_json(stage("lc/lc_poly.json")) ? 1 : 0);
        dump_scm("lc (own key preferred)", lc);
        SensorCalibrationManager pt_like("PT", "PSI", 3);
        std::printf("pt json ok=%d\n", pt_like.load_from_json(stage("lc/lc_poly.json")) ? 1 : 0);
        dump_scm("pt reading lc file", pt_like);
    }
    {
        SensorCalibrationManager rtd("RTD", "degC", 3);
        std::printf("rtd csv ok=%d\n", rtd.load_from_csv(stage("rtd/rtd_cal.csv")) ? 1 : 0);
        dump_scm("rtd csv", rtd);
        SensorCalibrationManager rtd2("RTD", "degC", 3);
        std::printf("rtd root json ok=%d\n",
                    rtd2.load_from_json(stage("rtd/root_poly.json")) ? 1 : 0);
        dump_scm("rtd root json", rtd2);
        rtd2.set_calibration(9, PolynomialCalibration(std::vector<double>{1.0, 2.0}, "u"));
        rtd2.clear_calibration(1);
        dump_scm("rtd root json set9 clear1", rtd2);
        // load_calibration: dir with a single json; then csv fallback; then nothing.
        const std::string dir = g_tmp + "/rtddir";
        fs::create_directories(dir);
        fs::copy_file(fix("rtd/root_poly.json"), dir + "/one.json");
        SensorCalibrationManager a("RTD", "degC", 3), b("RTD", "degC", 3), c("RTD", "degC", 3);
        std::printf("lc(dir)=%d\n", a.load_calibration(dir, "") ? 1 : 0);
        dump_scm("load_calibration dir", a);
        std::printf("lc(csv)=%d\n", b.load_calibration(g_tmp + "/nodir", fix("rtd/rtd_cal.csv")));
        dump_scm("load_calibration csv", b);
        std::printf("lc(none)=%d\n", c.load_calibration(g_tmp + "/nodir", "") ? 1 : 0);
    }
}

void rtd_tc() {
    section("rtd CVD");
    const rtd::CVDCoeffs pt100{};
    rtd::CVDCoeffs pt1000;
    pt1000.R0 = 1000.0;
    for (double t : {-273.15, -250.0, -200.0, -196.0, -183.0, -100.0, -0.5, 0.0, 0.5, 25.0, 100.0,
                     400.0, 850.0, 900.0})
        std::printf("R(%s): pt100=%s pt1000=%s\n", d(t).c_str(),
                    d(rtd::temp_to_resistance_cvd(t, pt100)).c_str(),
                    d(rtd::temp_to_resistance_cvd(t, pt1000)).c_str());
    for (double r :
         {-1.0,   0.0,    1.0,    10.0,   18.52, 20.0,  31.0,   60.26, 99.99, 100.0, 100.01,
          109.73, 138.51, 247.09, 390.48, 395.0, 400.0, 2000.0, 1e9,   kNaN,  kInf})
        std::printf("T(%s): full100=%s full1000=%s quad100=%s\n", d(r).c_str(),
                    d(rtd::resistance_to_temp_cvd_full(r, pt100)).c_str(),
                    d(rtd::resistance_to_temp_cvd_full(r * 10.0, pt1000)).c_str(),
                    d(rtd::resistance_to_temp_cvd(r, pt100)).c_str());
    rtd::CVDCoeffs bad;
    bad.R0 = 0.0;
    std::printf("T(r0=0)=%s\n", d(rtd::resistance_to_temp_cvd_full(100.0, bad)).c_str());
    for (int32_t a : kI32) {
        std::printf("board(%d): 2.5V/1mA/1000=%s 2.5V/500uA/100=%s 1.25V/0uA=%s\n", a,
                    d(rtd::rtd_board_adc_to_temp_c(a, 2.5, 1000.0, 1000.0)).c_str(),
                    d(rtd::rtd_board_adc_to_temp_c(a, 2.5, 500.0, 100.0)).c_str(),
                    d(rtd::rtd_board_adc_to_temp_c(a, 1.25, 0.0, 1000.0)).c_str());
    }
    for (int32_t a : {85899346, 2145336164, 2145336165, -2145336164, -2145336165})
        std::printf("board edge(%d)=%s\n", a,
                    d(rtd::rtd_board_adc_to_temp_c(a, 2.5, 1000.0, 1000.0)).c_str());
    std::printf("counts_to_resistance(1000,0.01,5)=%s (-7,2.5,-1)=%s\n",
                d(rtd::counts_to_resistance(1000, 0.01, 5)).c_str(),
                d(rtd::counts_to_resistance(-7, 2.5, -1)).c_str());
    section("tc nist_type_k_mv_to_c");
    for (double c : tc::nist_type_k_mv_to_c())
        std::printf("%s\n", d(c).c_str());
    tc::ColdJunctionConfig cj;
    std::printf("cjc default enabled=%d fixed=%s ch=%d\n", cj.enabled ? 1 : 0,
                d(cj.fixed_temp_c).c_str(), cj.cjc_channel_id);
}

void type_k() {
    section("TypeK");
    std::printf("min=%s max=%s\n", d(kTypeKMinMv).c_str(), d(kTypeKMaxMv).c_str());
    std::vector<double> mvs = {-7.0,
                               kTypeKMinMv,
                               std::nextafter(kTypeKMinMv, -100.0),
                               std::nextafter(kTypeKMinMv, 100.0),
                               -5.891,
                               -3.0,
                               -1e-9,
                               0.0,
                               1e-9,
                               0.5,
                               1.0,
                               4.096,
                               10.0,
                               20.644,
                               20.645,
                               30.0,
                               41.276,
                               54.886,
                               60.0,
                               kTypeKMaxMv,
                               std::nextafter(kTypeKMaxMv, 100.0),
                               std::nextafter(kTypeKMaxMv, -100.0),
                               70.0,
                               kNaN,
                               kInf};
    for (double mv : mvs)
        std::printf("c(%s)=%s\n", d(mv).c_str(), d(type_k_c_from_mv(mv)).c_str());
    for (double c : {-300.0, -250.0, -250.0001, -200.0, -100.0, -0.001, 0.0, 22.0, 25.0, 100.0,
                     500.0, 1000.0, 1372.0, 1372.01, 1400.0, kNaN})
        std::printf("mv(%s)=%s\n", d(c).c_str(), d(type_k_mv_from_c(c)).c_str());
}

void small_pure() {
    section("hp_pt_shunt_code");
    for (uint32_t w : kU32)
        std::printf("%" PRIu32 " -> %" PRIu32 "\n", w, hp_pt_shunt_code(w));

    section("PtSmoother");
    {
        PtSmoother s;
        const std::vector<std::pair<uint16_t, double>> seq = {
            {2101, 300.0}, {2101, 310.0}, {2102, -5.0}, {2101, 290.0}, {2101, kNaN},
            {2101, 100.0}, {2101, 200.0}, {2102, 0.0},  {2101, kInf},  {2101, 50.0},
            {2101, 60.0},  {2102, 1e9},   {2102, -1e9}, {2102, 3.25},  {65535, 1.0}};
        for (const auto& [uid, v] : seq)
            std::printf("step(%u,%s)=%s\n", uid, d(v).c_str(), d(s.step(uid, v)).c_str());
        s.reset(2101);
        std::printf("after reset step(2101,7)=%s\n", d(s.step(2101, 7.0)).c_str());
        std::printf("step(2101,8)=%s\n", d(s.step(2101, 8.0)).c_str());
        PtSmoother s2(0.5), s3(1.0), s4(0.0);
        for (double v : {10.0, 20.0, 30.0})
            std::printf("a.5 %s a1 %s a0 %s\n", d(s2.step(1, v)).c_str(), d(s3.step(1, v)).c_str(),
                        d(s4.step(1, v)).c_str());
    }

    section("valve_position");
    std::printf("consts %s %s %s %s %s %s %d %d\n", d(valve_position::kAdcMaxCounts).c_str(),
                d(valve_position::kAdcRefVolts).c_str(), d(valve_position::kShuntOhms).c_str(),
                d(valve_position::kLoopMinMa).c_str(), d(valve_position::kLoopMaxMa).c_str(),
                d(valve_position::kNoSignalMa).c_str(), valve_position::kStatusOk,
                valve_position::kStatusNoSignal);
    for (uint32_t c :
         {0u,    1u,    100u,  247u,  248u,  249u,  353u,  356u,  495u,  496u,   497u,
          1000u, 1489u, 2048u, 2481u, 2482u, 2483u, 3000u, 4095u, 4096u, 65535u, 0xFFFFFFFFu}) {
        const auto r = valve_position::from_counts(c);
        std::printf("counts %u: ma=%s pct=%s reading=%s/%d\n", c,
                    d(valve_position::counts_to_ma(c)).c_str(),
                    d(valve_position::ma_to_percent_open(valve_position::counts_to_ma(c))).c_str(),
                    charcal::f32(r.percent_open).c_str(), r.status);
    }
    for (double ma : {kNaN, kInf, -kInf, 3.99, 12.0})
        std::printf("pct(%s)=%s\n", d(ma).c_str(),
                    d(valve_position::ma_to_percent_open(ma)).c_str());

    section("CommandDedupe");
    {
        CommandDedupe dd;
        auto cmd = [](int k) {
            std::array<uint8_t, CommandDedupe::kBytes> a{};
            for (size_t i = 0; i < a.size(); ++i)
                a[i] = static_cast<uint8_t>(k * 7 + i);
            return a;
        };
        std::string out;
        for (int k : {1, 2, 1, 3, 2})
            out += dd.seen(cmd(k).data()) ? "D" : "n";
        for (int k = 10; k < 50; ++k)
            out += dd.seen(cmd(k).data()) ? "D" : "n";
        for (int k : {1, 2, 3, 17, 18, 49})  // 1,2,3 evicted after 32 more; 17,18,49 still held
            out += dd.seen(cmd(k).data()) ? "D" : "n";
        std::printf("%s\n", out.c_str());
    }
}

void print_capture(const char* label, const CaptureResult& r) {
    std::printf("%s: ok=%d avg=%s n=%zu span=%" PRIu64 " age=%" PRIu64 " win=%" PRIu64
                " maxage=%" PRIu64 " spread=%s drift=%s z=%s settled=%d reason='%s'\n",
                label, r.ok ? 1 : 0, d(r.adc_avg).c_str(), r.n, r.span_ms, r.age_ms, r.window_ms,
                r.max_age_ms, d(r.spread).c_str(), d(r.drift).c_str(), d(r.drift_z).c_str(),
                r.settled ? 1 : 0, r.reason);
}

void capture_window() {
    section("CaptureWindow");
    constexpr uint64_t ms = 1000000ull;
    CaptureWindow w;
    print_capture("empty", w.capture(2101, 0));
    // 60 Hz steady with a little deterministic noise.
    const uint64_t t0 = 5000 * ms;
    for (int i = 0; i < 180; ++i) {
        const int32_t adc = 500000000 + ((i * 7919) % 13) * 1000 - 6000;
        w.push(2101, adc, t0 + static_cast<uint64_t>(i) * 16666667ull,
               t0 + static_cast<uint64_t>(i) * 16666667ull + 3 * ms);
    }
    const uint64_t last_rx = t0 + 179ull * 16666667ull + 3 * ms;
    print_capture("60Hz now", w.capture(2101, last_rx + 10 * ms));
    print_capture("60Hz stale", w.capture(2101, last_rx + 1600 * ms));
    // A step inside the window: unsettled.
    for (int i = 0; i < 60; ++i) {
        const uint64_t ts = t0 + 3000 * ms + static_cast<uint64_t>(i) * 16666667ull;
        w.push(2102, i < 30 ? 1000000 + (i % 3) : 1060000 + (i % 3), ts, ts);
    }
    print_capture("step", w.capture(2102, t0 + 3000 * ms + 59ull * 16666667ull + 1 * ms));
    // 1 Hz load cell: adaptive window.
    for (int i = 0; i < 8; ++i)
        w.push(4201, 52000 + i, 20000 * ms + static_cast<uint64_t>(i) * 1000 * ms,
               20000 * ms + static_cast<uint64_t>(i) * 1000 * ms);
    print_capture("1Hz", w.capture(4201, 27000 * ms + 500 * ms));
    // Two samples only.
    w.push(4202, 10, 1 * ms, 1 * ms);
    w.push(4202, 20, 2 * ms, 2 * ms);
    print_capture("too_few", w.capture(4202, 3 * ms));
    // Very slow sensor: beyond the max window.
    for (int i = 0; i < 5; ++i)
        w.push(4206, 7, static_cast<uint64_t>(i) * 6000 * ms, static_cast<uint64_t>(i) * 6000 * ms);
    print_capture("slow", w.capture(4206, 24000 * ms + 1 * ms));
    std::printf("sizes 2101=%zu 2102=%zu 4201=%zu 4202=%zu 4206=%zu 9=%zu\n", w.size(2101),
                w.size(2102), w.size(4201), w.size(4202), w.size(4206), w.size(9));
    auto u = w.uids();
    std::sort(u.begin(), u.end());
    std::printf("uids:");
    for (auto x : u)
        std::printf(" %u", x);
    std::printf("\n");
    // Count eviction.
    for (int i = 0; i < 1500; ++i)
        w.push(7, i, static_cast<uint64_t>(i) * 1000ull, static_cast<uint64_t>(i) * 1000ull);
    std::printf("fast ring size=%zu\n", w.size(7));
    print_capture("fast", w.capture(7, 1499ull * 1000ull));
    w.clear(2101);
    std::printf("after clear(2101) size=%zu\n", w.size(2101));
    w.clear();
    std::printf("after clear() uids=%zu\n", w.uids().size());
}

void print_fit(const char* label, const CubicFit& f) {
    std::printf("%s: valid=%d deg=%d A=%s B=%s C=%s D=%s min=%s scale=%s rmse=%s poly=", label,
                f.valid ? 1 : 0, f.degree, d(f.A).c_str(), d(f.B).c_str(), d(f.C).c_str(),
                d(f.D).c_str(), d(f.norm_min).c_str(), d(f.norm_scale).c_str(), d(f.rmse).c_str());
    for (double p : f.poly)
        std::printf("%s ", d(p).c_str());
    std::printf("\n");
    // What the fit DOES: psi at five codes across the fitted span, through both representations.
    // The coefficients themselves are an ill-conditioned least-squares solve (they differ between
    // compilers and platforms well past 4 ULP); these values are what a reader evaluates.
    if (!f.valid)
        return;
    std::printf("%s eval:", label);
    for (double u : {-0.5, -0.25, 0.0, 0.25, 0.5}) {
        const double adc = f.norm_min + u * f.norm_scale;
        const double raw = ((f.A * adc + f.B) * adc + f.C) * adc + f.D;
        double norm = 0.0;
        for (size_t i = f.poly.size(); i-- > 0;)
            norm = norm * u + f.poly[i];
        std::printf(" raw=%s norm=%s", d(raw).c_str(), d(norm).c_str());
    }
    std::printf("\n");
}

void print_channel(const CubicCalibrationStore& s, uint16_t uid) {
    const CubicChannel* c = s.channel(uid);
    if (!c) {
        std::printf("uid %u: <none>\n", uid);
        return;
    }
    std::printf(
        "uid %u: board=%d conn=%d log=%d role='%s' model=%s kind=%s live=%d unit=%s "
        "status=%s err='%s' npts=%zu target=%d curve=%zu cap=%d\n",
        uid, c->board_id, c->connector, c->logical_ch, c->role.c_str(), c->active_model.c_str(),
        c->kind == SensorKind::LC ? "LC" : "PT", c->live ? 1 : 0, c->raw_unit.c_str(),
        c->status.c_str(), c->last_error.c_str(), c->points.size(),
        static_cast<int>(cal_target(*c)), c->fit_curve.size(), c->last_capture.valid ? 1 : 0);
    for (const auto& p : c->points)
        std::printf("    pt adc=%s psi=%s\n", d(p.adc).c_str(), d(p.psi).c_str());
    print_fit("    fit", c->fit);
    print_fit("    cubic", c->fit_cubic);
    print_fit("    linear", c->fit_linear);
    std::printf("    fit_for=%s\n", s.fit_for(uid) ? "yes" : "null");
}

void cubic_store() {
    section("CubicCalibrationStore::compute_fit");
    const std::vector<std::vector<CubicPoint>> sets = {
        {},
        {{215000000, 0, 0}},
        {{215000000, 0, 0}, {1074000000, 1000, 0}},
        {{215000000, 0, 0}, {430000000, 251.5, 0}, {645000000, 498, 0}},
        {{215000000, 0, 0}, {430000000, 251.5, 0}, {645000000, 498, 0}, {1074000000, 1003.2, 0}},
        {{1, 1, 0}, {1, 2, 0}, {1, 3, 0}},
        {{0, 0, 0}, {1e6, 20, 0}, {2e6, 41, 0}, {3e6, 63, 0}, {4e6, 84.5, 0}, {5e6, 106, 0}},
        {{-5e8, -10, 0}, {0, 0, 0}, {5e8, 10, 0}, {1e9, 25, 0}},
        {{100, kNaN, 0}, {200, 1, 0}},
    };
    for (size_t i = 0; i < sets.size(); ++i)
        for (int deg : {0, 1, 2, 3, 5}) {
            const std::string label = "set " + std::to_string(i) + " deg " + std::to_string(deg);
            print_fit(label.c_str(), CubicCalibrationStore::compute_fit(sets[i], deg));
        }

    section("CubicCalibrationStore live");
    {
        const std::string path = g_tmp + "/live/cubic_calibration.json";
        CubicCalibrationStore s(path);
        s.register_channel(2101, 21, 1, 1, "Fuel Upstream", "cubic");
        s.register_channel(2102, 21, 2, 2, "GSE Low", "physics");
        s.register_channel(2105, 21, 5, 5, "Ox Upstream", "robust");
        s.register_channel(4201, 42, 1, 11, "LC Ox", "linear", SensorKind::LC);
        s.register_channel(4202, 42, 2, 12, "LC Fuel", "cubic", SensorKind::LC);
        s.register_channel(8104, 81, 4, 132, "T7 LC", "linear", SensorKind::LC, kRawUnitMicrovolts);
        print_fit("add unknown", s.add_point(9999, 1, 1));
        print_fit("2101 a", s.add_point(2101, 215000000, 0));
        print_fit("2101 b", s.add_point(2101, 645000000, 500));
        print_fit("2101 c", s.add_point(2101, 1074000000, 1001));
        print_fit("2102 a", s.add_point(2102, 300000000, 100));
        print_fit("2105 a", s.add_point(2105, 300000000, 0));
        print_fit("2105 b", s.add_point(2105, 900000000, 700));
        print_fit("4201 a", s.add_point(4201, 100000, 0));
        print_fit("4201 b", s.add_point(4201, 2100000, 50));
        print_fit("4202 a", s.add_point(4202, 0, 0));
        print_fit("8104 a", s.add_point(8104, 0, 0));
        print_fit("8104 b", s.add_point(8104, 20000, 500));
        for (int i = 0; i < 23; ++i)
            s.add_point(4202, 1000.0 * i, 0.02 * i + (i % 2 ? 0.001 : -0.001));
        s.note_capture(2101, CaptureQuality{true, 1757000099.0, 645000000.0, 61, 1000, 1234.0, 56.0,
                                            1.5, true});
        s.note_capture(9999, CaptureQuality{});
        s.set_fit_curve(2105, {{300000000, 0.5}, {900000000, 699.5}});
        // A config change of model refits from the points already held.
        s.register_channel(2101, 21, 1, 1, "Fuel Upstream", "linear");
        print_channel(s, 2101);
        s.register_channel(2101, 21, 1, 1, "", "cubic");
        for (uint16_t u : s.uids())
            print_channel(s, u);
        // Each call sequenced on its own: printf's argument evaluation order is unspecified
        // (gcc on x86_64 evaluates right to left).
        const bool saved = s.save();
        std::printf("save=%d load_failed=%d\n", saved ? 1 : 0, s.load_failed() ? 1 : 0);
        charcal::dump_file("live-save", path);
        s.clear_channel(2101);
        s.clear_channel(9999);
        print_channel(s, 2101);
        std::printf("save2=%d\n", s.save() ? 1 : 0);
        charcal::dump_file("live-save-after-clear", path);

        // Round trip: a fresh store with the same registrations reloads what was written.
        CubicCalibrationStore r(path);
        r.register_channel(2101, 21, 1, 1, "Fuel Upstream", "cubic");
        r.register_channel(4201, 42, 1, 11, "LC Ox", "linear", SensorKind::LC);
        const size_t reloaded = r.load();
        std::printf("reload n=%zu failed=%d\n", reloaded, r.load_failed() ? 1 : 0);
        for (uint16_t u : r.uids())
            print_channel(r, u);
        std::printf("resave=%d\n", r.save() ? 1 : 0);
        charcal::dump_file("roundtrip", path);
    }

    section("CubicCalibrationStore fixtures");
    struct Reg {
        uint16_t uid;
        uint8_t board, conn, log;
        const char* role;
        const char* model;
        SensorKind kind;
        const char* unit;
    };
    // The stack fixture's config: PT 21 (0-5 V), PT 22 (4-20 mA), LC 42, T7 81.
    const std::vector<Reg> regs = {
        {2101, 21, 1, 1, "Fuel Upstream", "cubic", SensorKind::PT, kRawUnitAdc},
        {2102, 21, 2, 2, "GSE Low", "physics", SensorKind::PT, kRawUnitAdc},
        {2103, 21, 3, 3, "Fuel Downstream", "cubic", SensorKind::PT, kRawUnitAdc},
        {2104, 21, 4, 4, "Moved Role", "cubic", SensorKind::PT, kRawUnitAdc},
        {2105, 21, 5, 5, "Chamber Mid PT 1", "physics", SensorKind::PT, kRawUnitAdc},
        {2201, 22, 1, 11, "GSE High", "physics", SensorKind::PT, kRawUnitAdc},
        {2203, 22, 3, 13, "GSE Mid", "cubic", SensorKind::PT, kRawUnitAdc},
        {4201, 42, 1, 11, "LC Ox", "linear", SensorKind::LC, kRawUnitAdc},
        {4202, 42, 2, 12, "LC Fuel", "cubic", SensorKind::LC, kRawUnitAdc},
        {4206, 42, 6, 16, "LC Thrust", "physics", SensorKind::LC, kRawUnitAdc},
        {8101, 81, 1, 129, "T7 PT", "physics", SensorKind::PT, kRawUnitMicrovolts},
        {8104, 81, 4, 132, "T7 LC", "linear", SensorKind::LC, kRawUnitMicrovolts},
        {8106, 81, 6, 134, "T7 PT Cubic", "cubic", SensorKind::PT, kRawUnitMicrovolts},
    };
    for (const char* f : {"store_mixed.json", "cubic_calibration.default.json",
                          "profiles/default.json", "profiles/restored-sep05.json"}) {
        for (bool registered : {true, false}) {
            const std::string path = stage(f, "fx/cubic_calibration.json");
            CubicCalibrationStore s(path);
            if (registered)
                for (const auto& r : regs)
                    s.register_channel(r.uid, r.board, r.conn, r.log, r.role, r.model, r.kind,
                                       r.unit);
            const size_t n = s.load();
            std::printf("[%s registered=%d] load n=%zu failed=%d\n", f, registered ? 1 : 0, n,
                        s.load_failed() ? 1 : 0);
            for (uint16_t u : s.uids())
                print_channel(s, u);
            std::printf("save=%d\n", s.save() ? 1 : 0);
            charcal::dump_file(std::string(f) + (registered ? " registered" : " blind"), path);
        }
    }
    {
        const std::string path = g_tmp + "/bad/cubic_calibration.json";
        fs::create_directories(g_tmp + "/bad");
        for (const char* text : {"{ not json", "{\"no_state\": 1}", "{\"cubic_state\": []}"}) {
            charcal::write_file(path, text);
            CubicCalibrationStore s(path);
            s.register_channel(2101, 21, 1, 1, "Fuel Upstream", "cubic");
            const size_t n = s.load();
            const bool failed = s.load_failed();
            const bool saved = s.save();
            std::printf("bad '%s': n=%zu failed=%d save=%d file='%s'\n", text, n, failed ? 1 : 0,
                        saved ? 1 : 0, charcal::read_file(path).c_str());
        }
        CubicCalibrationStore none(g_tmp + "/absent/cubic_calibration.json");
        const size_t n = none.load();
        std::printf("absent: n=%zu failed=%d\n", n, none.load_failed() ? 1 : 0);
    }
}

LcTareStore::Evaluator linear(double slope, double icpt) {
    return [slope, icpt](double adc) {
        return slope * adc + icpt;
    };
}

void dump_tares(const char* label, const LcTareStore& s) {
    std::printf("%s: size=%zu trusted=%d failed=%d\n", label, s.size(), s.curves_trusted() ? 1 : 0,
                s.load_failed() ? 1 : 0);
    for (uint16_t u : s.uids()) {
        const LcTare* t = s.tare_for(u);
        std::printf("  uid %u entity=%s adc=%s offset=%s fp=%" PRIu64 "\n", t->uid,
                    t->entity.c_str(), d(t->adc_at_tare).c_str(), d(t->offset_kg).c_str(),
                    t->curve_fp);
    }
}

void lc_tare() {
    section("lc_tare_entity");
    for (int b : {0, 1, 10, 20, 21, 41, 42, 49, 50, 99, 100, 255})
        for (int c : {0, 1, 10, 11})
            std::printf("(%d,%d)=%s ", b, c,
                        lc_tare_entity(static_cast<uint8_t>(b), static_cast<uint8_t>(c)).c_str());
    std::printf("\n");

    section("LcTareStore::fingerprint");
    std::printf("zero=%" PRIu64 " id=%" PRIu64 " lin=%" PRIu64 " lin2=%" PRIu64 " nan=%" PRIu64
                " empty=%" PRIu64 "\n",
                LcTareStore::fingerprint(linear(0, 0)), LcTareStore::fingerprint(linear(1, 0)),
                LcTareStore::fingerprint(linear(2.5e-5, -2.5)),
                LcTareStore::fingerprint(linear(2.5e-5, -2.5000000000000004)),
                LcTareStore::fingerprint([](double) {
                    return std::numeric_limits<double>::quiet_NaN();
                }),
                LcTareStore::fingerprint(LcTareStore::Evaluator{}));

    section("LcTareStore");
    const std::string path = g_tmp + "/tare/lc_tare.json";
    LcTareStore s(path);
    std::printf("load absent n=%zu\n", s.load());
    std::printf("set 4201=%d\n", s.set(4201, "LC2_Cal.CH1", 1100000, linear(2.5e-5, -2.5)) ? 1 : 0);
    std::printf("set 4202 nan=%d\n", s.set(4202, "LC2_Cal.CH2", 5,
                                           [](double) {
                                               return std::numeric_limits<double>::quiet_NaN();
                                           })
                                         ? 1
                                         : 0);
    std::printf("set 4203 nan adc=%d\n", s.set(4203, "LC2_Cal.CH3", kNaN, linear(1, 0)) ? 1 : 0);
    std::printf("set 4206=%d\n", s.set(4206, "LC2_Cal.CH6", -4000000, linear(-1e-6, 0.5)) ? 1 : 0);
    dump_tares("after set", s);
    // offset_kg is derived from adc_at_tare through the curve now live.
    s.recompute(4201, linear(2.6e-5, -2.5));
    s.recompute(4299, linear(1, 1));
    s.recompute(4206, [](double) {
        return std::numeric_limits<double>::infinity();
    });
    dump_tares("after recompute", s);
    std::printf("stale=%zu\n", s.recompute_stale([](uint16_t u) {
        return u == 4201 ? linear(2.6e-5, -2.5) : linear(3e-6, 1.0);
    }));
    dump_tares("after recompute_stale", s);
    s.set_curves_trusted(false);
    s.recompute(4201, linear(1, 0));
    s.recompute_all([](uint16_t) {
        return linear(1, 0);
    });
    std::printf("stale(untrusted)=%zu\n", s.recompute_stale([](uint16_t) {
        return linear(1, 0);
    }));
    dump_tares("untrusted", s);
    s.set_curves_trusted(true);
    s.recompute_all([](uint16_t u) {
        return linear(1e-5 * u, -0.5);
    });
    dump_tares("recompute_all", s);
    std::printf("save=%d\n", s.save() ? 1 : 0);
    charcal::dump_file("tare-save", path);
    LcTareStore r(path);
    std::printf("reload n=%zu\n", r.load());
    dump_tares("reloaded", r);
    r.clear(4206);
    r.clear(1);
    dump_tares("clear 4206", r);
    r.clear_all();
    dump_tares("clear_all", r);

    const std::string fx = stage("lc_tare.json", "tare_fx/lc_tare.json");
    LcTareStore f(fx);
    std::printf("fixture n=%zu\n", f.load());
    dump_tares("fixture", f);
    std::printf("fixture stale=%zu\n", f.recompute_stale([](uint16_t u) {
        return u == 4206 ? LcTareStore::Evaluator{} : linear(2.5e-5, -2.5);
    }));
    dump_tares("fixture recomputed", f);
    std::printf("fixture save=%d\n", f.save() ? 1 : 0);
    charcal::dump_file("tare-fixture-save", fx);
    for (const char* text : {"{", "{\"version\": 1}", "{\"tares\": {}}"}) {
        charcal::write_file(fx, text);
        LcTareStore b(fx);
        const size_t n = b.load();
        const bool failed = b.load_failed();
        const bool saved = b.save();
        std::printf("bad '%s': n=%zu failed=%d save=%d\n", text, n, failed ? 1 : 0, saved ? 1 : 0);
    }
}

void print_vec(const char* label, const Eigen::VectorXd& v) {
    std::printf("%s:", label);
    for (int i = 0; i < v.size(); ++i)
        std::printf(" %s", d(v(i)).c_str());
    std::printf("\n");
}

void print_mat(const char* label, const Eigen::MatrixXd& m) {
    std::printf("%s:\n", label);
    for (int r = 0; r < m.rows(); ++r) {
        std::printf("   ");
        for (int c = 0; c < m.cols(); ++c)
            std::printf(" %s", d(m(r, c)).c_str());
        std::printf("\n");
    }
}

const std::vector<double> kRobustGrid = {0,          1e6,   214748365,  5e8,
                                         1073741824, 1.5e9, 2147483647, -1e8};

void robust() {
    section("AllanVariance");
    {
        std::vector<double> series;
        uint64_t x = 88172645463325252ull;
        double walk = 0;
        for (int i = 0; i < 512; ++i) {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            const double u = static_cast<double>(x % 1000003) / 1000003.0 - 0.5;
            walk += 1e-3 * u;
            series.push_back(0.01 * u + walk + 1e-5 * i);
        }
        std::vector<double> tau, s2;
        compute_allan_variance(series, 0.01, tau, s2);
        for (size_t i = 0; i < tau.size(); ++i)
            std::printf("tau=%s s2=%s\n", d(tau[i]).c_str(), d(s2[i]).c_str());
        const NoiseCoefficients nc = fit_noise_coefficients(tau, s2);
        std::printf("fit Q=%s B=%s K=%s R=%s tau_min=%s sigma_min=%s\n", d(nc.Q).c_str(),
                    d(nc.B).c_str(), d(nc.K).c_str(), d(nc.R).c_str(), d(nc.tau_min).c_str(),
                    d(nc.sigma_min).c_str());
        const NoiseCoefficients def{};
        for (double tau0 : {0.01, 0.1, 1.0, 10.0})
            std::printf("mu(%s)=%s v=2.5:%s\n", d(tau0).c_str(),
                        d(measurement_uncertainty(tau0, def)).c_str(),
                        d(measurement_uncertainty(tau0, def, 2.5, 0.01)).c_str());
        std::vector<double> t2, s22;
        compute_allan_variance({1.0, 2.0}, 0.1, t2, s22);
        std::printf("short series -> %zu taus\n", t2.size());
        const NoiseCoefficients e = fit_noise_coefficients({}, {});
        std::printf("empty fit Q=%s B=%s K=%s R=%s\n", d(e.Q).c_str(), d(e.B).c_str(),
                    d(e.K).c_str(), d(e.R).c_str());
    }

    section("RobustCalibrationFramework");
    // predict_pressure_* adds a Gauss-Markov bias propagated by WALL-CLOCK dt. The bias is zero
    // after construction/seed and is reset to zero by a first point at 0 psi, so predictions are
    // frozen only in those states; after a non-zero point only theta/cov/P are frozen (they do
    // not read the clock when the caller supplies the timestamps).
    const PTCalibrationCoeffs factory(-2e-27, 3e-18, 1.1e-6, -240.0);
    for (const PTCalibrationCoeffs& seed : {factory, PTCalibrationCoeffs(0, 0, 0, 0),
                                            PTCalibrationCoeffs(0, 0, 4.656612873e-7, -100)}) {
        RobustCalibrationFramework fw(2101);
        print_vec("theta initial", fw.theta_mean());
        fw.seed_from_factory_cubic(seed);
        print_vec("theta seeded", fw.theta_mean());
        print_mat("cov seeded", fw.theta_cov());
        print_mat("P seeded", fw.rls_P_matrix());
        std::printf("max_abs_error_vs_factory(seed)=%s (factory)=%s\n",
                    d(fw.max_abs_error_vs_factory(seed)).c_str(),
                    d(fw.max_abs_error_vs_factory(factory)).c_str());
        for (double a : kRobustGrid)
            std::printf("  pred(%s)=%s\n", d(a).c_str(), d(fw.predict_pressure_psi(a)).c_str());
        CalibrationPoint z;
        z.adc_code = 214748365;
        z.pressure = 0.0;
        z.timestamp = 100.0;
        fw.add_calibration_point(z);
        std::printf("points=%zu\n", fw.calibration_points_count());
        print_vec("theta after zero", fw.theta_mean());
        for (double a : kRobustGrid)
            std::printf("  pred0(%s)=%s\n", d(a).c_str(), d(fw.predict_pressure_psi(a)).c_str());
        const std::vector<std::pair<double, double>> pts = {
            {644245094, 505.0}, {1073741824, 1010.0}, {1503238553, 1490.0}, {858993459, 760.0}};
        double ts = 101.0;
        for (const auto& [a, p] : pts) {
            CalibrationPoint c;
            c.adc_code = a;
            c.pressure = p;
            c.timestamp = ts;
            ts += 2.5;
            fw.add_calibration_point(c);
            print_vec("  theta", fw.theta_mean());
        }
        print_mat("cov learned", fw.theta_cov());
        print_mat("P learned", fw.rls_P_matrix());
        std::printf("max_abs_error_vs_factory(learned)=%s\n",
                    d(fw.max_abs_error_vs_factory(seed)).c_str());
    }
    {
        RobustCalibrationFramework fw(7);
        fw.set_theta_from_polynomial({-120.0, 1100.0, 30.0, -5.0}, 2e8, 9e8);
        print_vec("theta from polynomial", fw.theta_mean());
        fw.set_theta_from_polynomial({3.0}, 0, 1);
        print_vec("theta from short polynomial", fw.theta_mean());
    }

    section("RobustCalibrationManager");
    {
        RobustCalibrationManager m;
        std::printf("has(2101)=%d pred(uninit)=%s\n", m.has_sensor(2101) ? 1 : 0,
                    d(m.predict_pressure_psi(2101, 5)).c_str());
        m.initialize_sensor(2101, factory);
        m.reseed_sensor(2103, PTCalibrationCoeffs(0, 0, 1e-6, -50));
        m.reseed_sensor(2105, PTCalibrationCoeffs(0, 0, 0, 0));
        for (int32_t a : {0, 214748365, 1073741824, 2147483647, INT32_MIN})
            std::printf("  pred 2101(%d)=%s 2103=%s 2105=%s\n", a,
                        d(m.predict_pressure_psi(2101, a)).c_str(),
                        d(m.predict_pressure_psi(2103, a)).c_str(),
                        d(m.predict_pressure_psi(2105, a)).c_str());
        m.zero_sensor(2103, 50000000);
        for (int32_t a : {0, 50000000, 1073741824})
            std::printf("  pred 2103 after zero(%d)=%s\n", a,
                        d(m.predict_pressure_psi(2103, a)).c_str());
        m.update_calibration(2101, 644245094, 470.0);
        m.update_calibration(2101, 1073741824, 940.0);
        m.update_calibration(9999, 1, 1);
        m.reset_adjustment(2105);
        m.reset_adjustment(9999);
        const std::map<uint16_t, std::string> roles = {{2101, "Fuel Upstream"},
                                                       {2103, "Fuel Downstream"}};
        const std::string adj = g_tmp + "/adj/adjustments.json";
        fs::create_directories(g_tmp + "/adj");
        std::printf("save=%d\n", m.save_adjustments(adj, &roles) ? 1 : 0);
        charcal::dump_file("adjustments", adj);
        // Restore by role into a moved sensor id, and by id for untagged entries.
        RobustCalibrationManager r;
        const std::map<uint16_t, std::string> moved = {{2104, "Fuel Upstream"},
                                                       {2103, "Fuel Downstream"}};
        std::printf("load=%d\n", r.load_adjustments(adj, &moved) ? 1 : 0);
        r.initialize_sensor(2104, factory);
        r.initialize_sensor(2103, PTCalibrationCoeffs(0, 0, 1e-6, -50));
        r.initialize_sensor(2105, PTCalibrationCoeffs(0, 0, 0, 0));
        const std::string adj2 = g_tmp + "/adj/adjustments2.json";
        std::printf("resave=%d\n", r.save_adjustments(adj2, &moved) ? 1 : 0);
        charcal::dump_file("adjustments-restored", adj2);
        std::printf("load missing=%d\n", r.load_adjustments(g_tmp + "/adj/none.json") ? 1 : 0);
    }
}

void t7() {
    section("T7Calibration");
    for (int slot : {1, 2, 8})
        for (int ain : {0, 1, 13, 15})
            std::printf(
                "logical(%d,%d)=%d ", slot, ain,
                fsw::t7::t7_logical_channel(static_cast<uint8_t>(slot), static_cast<uint8_t>(ain)));
    std::printf("\nuid(81,4)=%u uid(0,0)=%u uid(655,99)=%u\n", fsw::t7::t7_uid(81, 4),
                fsw::t7::t7_uid(0, 0), fsw::t7::t7_uid(655, 99));
    for (double v :
         {0.0, 1e-6, 4.9999e-7, 5e-7, -5e-7, 1.0000005, -1.0000005, 2.5, -10.0, 10.0, 2147.483647,
          2147.4836475, 2147.5, -2147.483648, -2147.5, 1e9, kNaN, kInf, -kInf})
        std::printf("counts(%s)=%d\n", d(v).c_str(), fsw::t7::t7_counts(v));
    for (double c : {0.0, 1.0, -1.0, 2500000.0, 2147483647.0})
        std::printf("volts(%s)=%s\n", d(c).c_str(), d(fsw::t7::t7_volts(c)).c_str());
    for (int s : {1, 2, 8}) {
        const auto id = fsw::t7::cjc_table_id(static_cast<uint8_t>(s));
        const auto cal = fsw::t7::calibrated_table_id(static_cast<uint8_t>(s), 4);
        std::printf("cjc(%d)=%02x%02x cal(%d,4)=%02x%02x entity=%s\n", s, id[0], id[1], s, cal[0],
                    cal[1], fsw::t7::calibrated_entity_name(static_cast<uint8_t>(s), 4).c_str());
    }

    section("T7Convert");
    std::printf("slope=%s nominal=%s\n", d(fsw::t7::kAin14SlopeKPerV).c_str(),
                d(fsw::t7::kAin14NominalOffsetK).c_str());
    for (double ain14 : {0.0, 1.8, 1.9, 2.0})
        for (double dev : {295.15, 300.0}) {
            const double off = fsw::t7::cjc_device_offset_k(dev, ain14);
            std::printf("cjc dev=%s ain14=%s off=%s temp=%s temp(-3)=%s\n", d(dev).c_str(),
                        d(ain14).c_str(), d(off).c_str(),
                        d(fsw::t7::cjc_temp_c(ain14, off, 0.0)).c_str(),
                        d(fsw::t7::cjc_temp_c(ain14 + 0.01, off, -3.0)).c_str());
        }
    fsw::config::T7Channel ch;
    ch.full_scale = 1000.0;
    ch.shunt_ohms = 250.0;
    for (const char* sig : {"0-5V", "0.5-4.5V", "1-5V", "0-10V", "4-20mA", "bogus", ""}) {
        ch.signal = sig;
        std::printf("pt %s:", sig);
        for (double v : {-0.5, 0.0, 0.5, 1.0, 2.5, 4.5, 5.0, 10.0, kNaN})
            std::printf(" %s", d(fsw::t7::pt_psi(v, ch)).c_str());
        std::printf("\n");
    }
    ch.signal = "4-20mA";
    ch.shunt_ohms = 0.0;
    std::printf("pt 4-20 no shunt: %s\n", d(fsw::t7::pt_psi(1.0, ch)).c_str());
    ch.shunt_ohms = 250.0;
    ch.full_scale = 0.0;
    std::printf("pt fs=0: %s\n", d(fsw::t7::pt_psi(1.0, ch)).c_str());
    fsw::config::T7Channel lc;
    lc.full_scale = 500.0;
    lc.sensitivity_mv_per_v = 2.0;
    lc.excitation_v = 10.0;
    for (double v : {-0.02, 0.0, 0.0025, 0.01, 0.02, 0.03})
        std::printf("lc(%s)=%s\n", d(v).c_str(), d(fsw::t7::lc_kg(v, lc)).c_str());
    lc.excitation_v = 0.0;
    std::printf("lc no excitation=%s\n", d(fsw::t7::lc_kg(0.01, lc)).c_str());
    for (double v : {-0.007, -0.001, 0.0, 0.001, 0.004096, 0.005259, 0.02, 0.07})
        for (double cj : {0.0, 22.0, -40.0})
            std::printf("tc(%s,%s)=%s\n", d(v).c_str(), d(cj).c_str(),
                        d(fsw::t7::tc_c(v, cj)).c_str());
    fsw::config::T7Channel rtd;
    rtd.r0_ohms = 1000.0;
    rtd.ljtr_ohms = 1000.0;
    for (double v : {-0.1, 0.0, 0.5, 1.0, 1.25, 1.3, 1.5, 2.0, 2.4999, 2.5, 3.0, kNaN})
        std::printf("rtd(%s): ohms=%s c=%s\n", d(v).c_str(), d(fsw::t7::rtd_ohms(v, rtd)).c_str(),
                    d(fsw::t7::rtd_c(v, rtd)).c_str());
    rtd.r0_ohms = 100.0;
    rtd.ljtr_ohms = 100.0;
    rtd.vref_v = 2.49;
    std::printf("rtd pt100 1.2V: ohms=%s c=%s\n", d(fsw::t7::rtd_ohms(1.2, rtd)).c_str(),
                d(fsw::t7::rtd_c(1.2, rtd)).c_str());
    for (const char* k : {"PT", "LC", "TC", "RTD", "VOLTAGE", "x"})
        std::printf("field(%s)='%s'\n", k, fsw::t7::calibrated_field(k));

    section("T7CalibrationMap");
    const fsw::config::Config cfg = fsw::config::load(fix("stack_config.toml"));
    std::printf("t7_errors=%zu t7_boards=%zu\n", cfg.t7_errors.size(), cfg.t7_boards.size());
    for (const auto& e : cfg.t7_errors)
        std::printf("  err: %s\n", e.c_str());
    const fsw::t7::T7CalibrationMap m(cfg);
    for (const auto& c : m.all())
        std::printf("  %s id=%d slot=%d ain=%d kind=%s role=%s uid=%u log=%d\n",
                    c.board_key.c_str(), c.board_id, c.slot, c.channel.ain, c.channel.kind.c_str(),
                    c.channel.role.c_str(), c.uid, c.logical_ch);
    std::printf("tc_slots:");
    for (auto s : m.tc_slots())
        std::printf(" %d", s);
    std::printf("\nraw_tables:");
    for (const auto& [hi, lo] : m.raw_tables())
        std::printf(" %02x%02x", hi, lo);
    std::printf("\nby_uid(8104)=%s by_uid(8105)=%s by_table(1,3)=%s by_table(1,15)=%s\n",
                m.by_uid(8104) ? m.by_uid(8104)->channel.role.c_str() : "null",
                m.by_uid(8105) ? "found" : "null",
                m.by_table(1, 3) ? m.by_table(1, 3)->channel.role.c_str() : "null",
                m.by_table(1, 15) ? "found" : "null");
    std::printf("default-map empty=%d\n", fsw::t7::T7CalibrationMap().empty() ? 1 : 0);
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <fixtures dir>\n", argv[0]);
        return 2;
    }
    charcal::pin_env();
    g_fix = argv[1];
    g_tmp = charcal::make_tmp_dir("char_cal_lib");
    // Library diagnostics go to stdout via std::cout; keep them out of the golden.
    std::cout.setstate(std::ios::failbit);
    std::setvbuf(stdout, nullptr, _IOFBF, 1 << 16);

    pt_coeffs();
    pt_manager();
    sensor_cal();
    rtd_tc();
    type_k();
    small_pure();
    capture_window();
    cubic_store();
    lc_tare();
    robust();
    t7();

    std::fflush(stdout);
    std::error_code ec;
    fs::remove_all(g_tmp, ec);
    return 0;
}
