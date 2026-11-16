// Golden-master harness for the file-static transforms in services/calibration/calibration_main.cpp
// (test-only).
//
//   char_calibration_service_fns <fixtures dir>
//
// calibration_main.cpp keeps its conversions (ratiometric / 4-20 mA PT, TC, RTD, actuator current,
// LC force), its model-selection rules (select_pt_psi, select_lc_kg), the uid resolution and the
// abort-threshold inverter as `static` functions next to main(). This translation unit includes
// the service source with its main() renamed, so the very same definitions are driven directly.
// The refactor that splits the file must keep every line of the golden.

#define main calibration_service_main_unused
#include "calibration_main.cpp"
#undef main

#include <cinttypes>
#include <climits>
#include <cstdio>
#include <limits>

#include "char_util.hpp"

using charcal::d;
using charcal::section;

namespace {

const double kNaN = std::numeric_limits<double>::quiet_NaN();
const double kInf = std::numeric_limits<double>::infinity();

const std::vector<int32_t> kI32 = {0,          1,          -1,           1000,       -214748365,
                                   1 << 20,    107374182,  214748365,    429496730,  644245094,
                                   858993460,  1073741824, 1717986918,   1932735283, 2040109466,
                                   2147483647, INT32_MIN,  INT32_MIN + 1};

const std::vector<uint32_t> kU32 = {0u,          1u,          4095u,       4096u,
                                    343597384u,  412316860u,  419188768u,  425201762u,
                                    1236950581u, 2061584302u, 2147483646u, 2147483647u,
                                    0x80000000u, 0xFFFF0FB5u, 0xFFFFFFFFu};

fsw::config::PtBoardConfig loop_board(double ref) {
    fsw::config::PtBoardConfig b;
    b.board_id = 22;
    b.board_number = 2;
    b.interface = fsw::config::PtInterface::CURRENT_LOOP_4_20MA;
    b.adc_ref_voltage = ref;
    return b;
}

void models() {
    section("model names");
    for (const char* s : {"cubic", "robust", "physics", "blend", "linear", "", "Robust", "x"})
        std::printf("pt('%s')=%s lc('%s')=%s\n", s, pt_model_name(parse_pt_model(s)), s,
                    lc_model_name(parse_lc_model(s)));
    std::printf("constants: kMinAbortCalPoints=%d zero=%s span=%s\n", kMinAbortCalPoints,
                d(kRatiometricPtZeroFrac).c_str(), d(kRatiometricPtSpanFrac).c_str());
}

void ratiometric() {
    section("convert_ratiometric_pt_to_pressure");
    for (double fs : {1000.0, 1500.0, 5000.0, 0.0, -5.0, kNaN, kInf}) {
        std::printf("fs=%s\n", d(fs).c_str());
        for (int32_t a : kI32)
            std::printf("  %d -> %s\n", a, d(convert_ratiometric_pt_to_pressure(a, fs)).c_str());
    }
}

void hp_pt() {
    section("convert_hp_pt_to_pressure static");
    const auto b25 = loop_board(2.5);
    for (double fs : {5000.0, 3000.0})
        for (double rs : {120.0, 100.0, 0.0, -1.0}) {
            std::printf("fs=%s rs=%s\n", d(fs).c_str(), d(rs).c_str());
            for (uint32_t a : kU32) {
                std::array<uint8_t, 11> fresh{};
                std::array<uint8_t, 11> live{};
                live.fill(1);
                const double p_fresh = convert_hp_pt_to_pressure(3, a, b25, fs, rs, fresh);
                const double p_live = convert_hp_pt_to_pressure(3, a, b25, fs, rs, live);
                std::printf("  %" PRIu32 " -> fresh %s latch=%d | live %s latch=%d\n", a,
                            d(p_fresh).c_str(), fresh[3], d(p_live).c_str(), live[3]);
            }
        }
    for (uint8_t ch : {0, 1, 10, 11}) {
        std::array<uint8_t, 11> st{};
        std::printf("ch %d -> %s\n", ch,
                    d(convert_hp_pt_to_pressure(ch, 1236950581u, b25, 5000, 120, st)).c_str());
    }
    for (double ref : {kNaN, 3.3, 0.0}) {
        std::array<uint8_t, 11> st{};
        std::printf(
            "ref %s -> %s\n", d(ref).c_str(),
            d(convert_hp_pt_to_pressure(2, 1236950581u, loop_board(ref), 5000, 120, st)).c_str());
    }

    section("convert_hp_pt_to_pressure hysteresis");
    // mA -> code at 2.5 V / 120 ohm: code = mA * 120 / 1000 / 2.5 * 2^31.
    auto code = [](double ma) {
        return static_cast<uint32_t>(std::llround(ma * 120.0 / 1000.0 / 2.5 * 2147483648.0));
    };
    const std::vector<double> mas = {0.0,  3.0,   3.99, 4.0,  4.05, 4.07, 4.08, 4.09,
                                     4.5,  4.05,  4.0,  3.96, 3.95, 3.94, 3.93, 4.06,
                                     4.08, 4.081, 12.0, 20.0, 21.0, 3.0,  4.2};
    for (const char* hyst : {"", "0", "00", "1"}) {
        if (hyst[0] == '\0')
            ::unsetenv("CAL_HP_MA_HYST");
        else
            ::setenv("CAL_HP_MA_HYST", hyst, 1);
        std::array<uint8_t, 11> st{};
        std::printf("CAL_HP_MA_HYST='%s':", hyst);
        for (double ma : mas) {
            const double p = convert_hp_pt_to_pressure(5, code(ma), b25, 5000, 120, st);
            std::printf(" %s:%s/%d", d(ma).c_str(), d(p).c_str(), st[5]);
        }
        std::printf("\n");
    }
    ::unsetenv("CAL_HP_MA_HYST");
    // The service keeps a separate latch array per board slot in g_hp_ma_live.
    g_hp_ma_live.clear();
    const double a = convert_hp_pt_to_pressure(1, code(4.5), b25, 5000, 120, g_hp_ma_live[2]);
    const double b = convert_hp_pt_to_pressure(1, code(4.05), b25, 5000, 120, g_hp_ma_live[3]);
    const double c = convert_hp_pt_to_pressure(1, code(4.05), b25, 5000, 120, g_hp_ma_live[2]);
    std::printf("per-slot latch: slot2 4.5=%s slot3 4.05=%s slot2 4.05=%s\n", d(a).c_str(),
                d(b).c_str(), d(c).c_str());
    g_hp_ma_live.clear();
}

void tc_rtd_act_lc() {
    section("convert_tc_adc_to_temp_c");
    for (double ref : {2.5, 1.25, 0.0}) {
        std::printf("ref=%s\n", d(ref).c_str());
        for (int32_t a : {0, 1, -1, 3518437, 7036874, 35184372, 88583218, 177166437, 59750000,
                          -5500000, -5600000, 2147483647, INT32_MIN, 1000000, 59747000, 59748000})
            std::printf("  %d -> %s\n", a, d(convert_tc_adc_to_temp_c(a, ref)).c_str());
    }
    section("clamp_tc_rtd_temp_publish_c");
    for (double t : {kNaN, kInf, -kInf, -300.0, -300.1, -1e9, 0.0, 2200.0, 2200.5, 1e12, -0.0})
        std::printf("%s -> %s\n", d(t).c_str(), d(clamp_tc_rtd_temp_publish_c(t)).c_str());
    section("convert_rtd_adc_to_temp_c");
    for (int32_t a : kI32)
        std::printf("%d -> %s | 100ohm/500uA %s\n", a,
                    d(convert_rtd_adc_to_temp_c(a, 2.5, 1000.0, 1000.0)).c_str(),
                    d(convert_rtd_adc_to_temp_c(a, 2.5, 500.0, 100.0)).c_str());
    section("convert_act_adc_to_current");
    for (uint32_t a : {0u, 1u, 1000u, 2047u, 4095u, 4096u, 65535u, 0xFFFFFFFFu})
        std::printf("%" PRIu32 " -> %s\n", a, d(convert_act_adc_to_current(a)).c_str());
    section("convert_lc_adc_to_force");
    struct P {
        double sens, pga, fs;
    };
    for (const P& p : {P{2, 32, 300}, P{3, 64, 500}, P{2, 1, 50}, P{0, 32, 300}, P{2, 0, 300},
                       P{-2, 32, 300}, P{2, 32, 0}, P{2, 32, kNaN}})
        for (int32_t a : {0, 1, -1, 100000, 2100000, 137438953, -137438953, 2147483647, INT32_MIN})
            std::printf("sens=%s pga=%s fs=%s %d -> %s\n", d(p.sens).c_str(), d(p.pga).c_str(),
                        d(p.fs).c_str(), a,
                        d(convert_lc_adc_to_force(a, p.sens, p.pga, p.fs)).c_str());
}

void selection() {
    section("select_pt_psi");
    g_pt_model.clear();
    g_pt_model[1] = PtModel::Robust;
    g_pt_model[2] = PtModel::Physics;
    g_pt_model[3] = PtModel::Blend;
    g_pt_model[4] = PtModel::Cubic;
    // uid 5 is absent from the map: cubic by default.
    const double fac = 101.25, rob = 98.5, phys = 120.75;
    for (int ov = -1; ov < 4; ++ov) {
        if (ov < 0)
            g_env_override.reset();
        else
            g_env_override = static_cast<PtModel>(ov);
        for (uint16_t uid : {1, 2, 3, 4, 5}) {
            std::printf("ov=%d uid=%u model=%s:", ov, uid, pt_model_name(pt_model_for(uid)));
            for (bool fac_ok : {false, true})
                for (bool has_rob : {false, true})
                    std::printf(" [%d%d]=%s", fac_ok, has_rob,
                                d(select_pt_psi(uid, fac, rob, phys, fac_ok, has_rob)).c_str());
            std::printf("\n");
        }
    }
    g_env_override.reset();
    std::printf("nan passthrough cubic=%s physics=%s\n",
                d(select_pt_psi(5, kNaN, 0, 0, true, false)).c_str(),
                d(select_pt_psi(2, 0, 0, kNaN, false, false)).c_str());

    section("select_lc_kg / lc_streams_physics");
    g_lc_model.clear();
    g_lc_model[1] = LcModel::Linear;
    g_lc_model[2] = LcModel::Cubic;
    g_lc_model[3] = LcModel::Physics;
    for (uint16_t uid : {1, 2, 3, 4})
        for (bool ok : {false, true})
            std::printf("uid=%u model=%s ok=%d -> %s streams_physics=%d\n", uid,
                        lc_model_name(lc_model_for(uid)), ok,
                        d(select_lc_kg(uid, 12.5, 13.75, ok)).c_str(),
                        lc_streams_physics(uid, ok) ? 1 : 0);

    section("per-sensor parameter fallbacks");
    g_pt_full_scale.clear();
    g_pt_sense_resistor.clear();
    g_lc_full_scale.clear();
    g_lc_sensitivity.clear();
    g_lc_pga_gain.clear();
    g_pt_full_scale[7] = 1500;
    g_pt_sense_resistor[7] = 100;
    g_lc_full_scale[7] = 500;
    g_lc_sensitivity[7] = 3;
    g_lc_pga_gain[7] = 64;
    for (uint16_t uid : {7, 8})
        std::printf("uid %u: pt_fs=%s pt_rs=%s lc_fs=%s lc_sens=%s lc_pga=%s\n", uid,
                    d(pt_full_scale_for(uid)).c_str(), d(pt_sense_resistor_for(uid)).c_str(),
                    d(lc_full_scale_for(uid, 300)).c_str(), d(lc_sensitivity_for(uid, 2)).c_str(),
                    d(lc_pga_gain_for(uid, 32)).c_str());
}

void uid_resolution() {
    section("resolve_pt_sensor_uid / resolve_lc_sensor_uid");
    const std::vector<fsw::elodin::BoardChannels> pts = {
        {21, 1, {1, 2, 3}}, {22, 2, {1, 2}}, {30, 10, {1}}, {45, 5, {4}}};
    const std::vector<fsw::elodin::BoardChannels> lcs = {{42, 2, {1, 2, 6}}, {41, 1, {1}}};
    const std::vector<fsw::elodin::BoardChannels> none;
    for (int lo :
         {0x00, 0x01, 0x03, 0x0A, 0x0B, 0x21, 0x26, 0x2A, 0x41, 0x81, 0x84, 0xE1, 0x121 & 0xFF})
        for (int ch : {0, 1, 3, 6, 10, 11}) {
            std::printf(
                "lo=%02x ch=%d pt=%u lc=%u none=%u\n", lo, ch,
                resolve_pt_sensor_uid(static_cast<uint8_t>(lo), static_cast<uint8_t>(ch), pts),
                resolve_lc_sensor_uid(static_cast<uint8_t>(lo), static_cast<uint8_t>(ch), lcs),
                resolve_pt_sensor_uid(static_cast<uint8_t>(lo), static_cast<uint8_t>(ch), none));
        }
}

void abort_inverter() {
    section("invert_abort_psi_to_adc");
    fsw::calibration::PTCalibrationManager ptm(false);
    fsw::calibration::RobustCalibrationManager rob;
    // Ratiometric cubic: ~1000 psi over 0.1..0.9 of 2^31.
    ptm.set_calibration(1, fsw::calibration::PTCalibrationCoeffs(1e-27, -5e-19, 5.82e-7, -125.0));
    // A non-monotonic / unreachable fit.
    ptm.set_calibration(3, fsw::calibration::PTCalibrationCoeffs(0, 0, -1e-7, 10.0));
    // A 4-20 mA board's cubic over shunt codes.
    ptm.set_calibration(13, fsw::calibration::PTCalibrationCoeffs(0, 0, 3.0316e-6, -1250.0));
    rob.reseed_sensor(2105, fsw::calibration::PTCalibrationCoeffs(0, 0, 5.82e-7, -125.0));
    rob.reseed_sensor(2106, fsw::calibration::PTCalibrationCoeffs(0, 0, 5.82e-7, -125.0));
    ptm.set_calibration(6, fsw::calibration::PTCalibrationCoeffs(0, 0, 6e-7, -128.0));

    g_pt_model.clear();
    g_pt_full_scale.clear();
    g_pt_sense_resistor.clear();
    g_env_override.reset();
    g_pt_model[2102] = PtModel::Physics;
    g_pt_model[2105] = PtModel::Robust;
    g_pt_model[2106] = PtModel::Blend;
    g_pt_model[2201] = PtModel::Physics;
    g_pt_full_scale[2102] = 1500;
    g_pt_full_scale[2201] = 5000;
    g_pt_full_scale[2203] = 5000;
    g_pt_sense_resistor[2201] = 120;
    g_pt_sense_resistor[2203] = 100;
    const auto b = loop_board(2.5);
    struct Case {
        uint16_t uid;
        uint8_t log;
        bool loop;
    };
    for (const Case& c :
         {Case{2101, 1, false}, Case{2102, 2, false}, Case{2103, 3, false}, Case{2104, 4, false},
          Case{2105, 5, false}, Case{2106, 6, false}, Case{2201, 11, true}, Case{2203, 13, true}})
        for (double target :
             {-5.0, 0.0, 0.5, 50.0, 300.0, 400.0, 999.0, 1049.0, 1600.0, 4000.0, 6000.0, kNaN})
            for (bool force : {false, true}) {
                const auto r = invert_abort_psi_to_adc(c.uid, c.log, c.loop, c.loop ? &b : nullptr,
                                                       target, force, ptm, rob);
                std::printf("uid=%u target=%s force=%d -> %s\n", c.uid, d(target).c_str(), force,
                            r ? std::to_string(*r).c_str() : "nullopt");
            }
    // A loop sensor whose board config is missing falls back to the ratiometric mapping.
    const auto r = invert_abort_psi_to_adc(2201, 11, true, nullptr, 400, true, ptm, rob);
    std::printf("loop without board -> %s\n", r ? std::to_string(*r).c_str() : "nullopt");
    g_env_override = PtModel::Cubic;
    const auto r2 = invert_abort_psi_to_adc(2102, 2, false, nullptr, 400, false, ptm, rob);
    std::printf("env override cubic on physics uid -> %s\n",
                r2 ? std::to_string(*r2).c_str() : "nullopt");
    g_env_override.reset();
}

}  // namespace

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;
    charcal::pin_env();
    std::cout.setstate(std::ios::failbit);
    std::setvbuf(stdout, nullptr, _IOFBF, 1 << 16);
    models();
    ratiometric();
    hp_pt();
    tc_rtd_act_lc();
    selection();
    uid_resolution();
    abort_inverter();
    std::fflush(stdout);
    // Keep the renamed service entry point referenced, so the TU compiles exactly as it ships.
    return &calibration_service_main_unused == nullptr ? 1 : 0;
}
