// ESP32 RTD board conversion (fsw::calibration::rtd::rtd_board_adc_to_temp_c), as
// calibration_service publishes it when a channel has no per-sensor calibration.
//
// The board drives excitation_ua through a Pt1000 and reads the voltage across it on a 32-bit ADC
// (2^31 = adc_ref_voltage). The shipped settings ([calibration.rtd]) are 2.5 V, 1000 uA, R0 1000.
//
// Expected values come from the IEC 60751 curve evaluated here (temp_to_resistance_cvd, itself
// pinned to the standard's Pt100 table in test_t7), never from the inverse under test.

#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>

#include "calibration/SensorCalibration.hpp"

using namespace fsw::calibration::rtd;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

constexpr double kRef = 2.5, kUa = 1000.0, kR0 = 1000.0;

/** The ADC code the board reports for an element at t_c. */
static int32_t code_at(double t_c) {
    CVDCoeffs c;
    c.R0 = kR0;
    const double volts = temp_to_resistance_cvd(t_c, c) * kUa * 1e-6;
    return static_cast<int32_t>(std::llround(volts / kRef * 2147483648.0));
}

static double read(int32_t code) {
    return rtd_board_adc_to_temp_c(code, kRef, kUa, kR0);
}

int main() {
    std::cout << "=== ESP32 RTD board ===" << std::endl;

    bool all_ok = true;
    for (double t : {-196.0, -183.0, -150.0, -100.0, -40.0, 0.0, 25.0, 100.0, 300.0})
        all_ok = all_ok && std::fabs(read(code_at(t)) - t) < 0.01;
    check(all_ok, "reads the element's temperature from -196 C to 300 C within 0.01 C");

    // The bug this replaces: the quadratic-only inverse dropped the C term below 0 C.
    CVDCoeffs c;
    c.R0 = kR0;
    const double r_lox = temp_to_resistance_cvd(-183.0, c);
    check(resistance_to_temp_cvd(r_lox, c) < -184.5,
          "the old quadratic-only inverse read LOX about 1.8 C cold");
    check(std::fabs(read(code_at(-183.0)) - -183.0) < 0.01, "the board now reads it at -183 C");
    bool same = true;
    for (double t : {0.5, 25.0, 300.0}) {
        const int32_t code = code_at(t);
        const double ohms = code / 2147483648.0 * kRef * 1e6 / kUa;
        same = same && std::fabs(read(code) - resistance_to_temp_cvd(ohms, c)) < 1e-9;
    }
    check(same, "above 0 C the reading is unchanged (the quadratic is exact there)");

    // Faults publish nothing.
    check(std::isnan(read(2147483647)) && std::isnan(read(2147000000)),
          "a saturated ADC (open element, ~395 C on the curve) is no reading");
    check(std::isnan(read(0)) && std::isnan(read(1000)),
          "a shorted element (~0 ohm, below -200 C) is no reading");
    check(std::isnan(rtd_board_adc_to_temp_c(code_at(25.0), kRef, 0.0, kR0)),
          "no excitation configured is no reading");
    check(std::isnan(resistance_to_temp_cvd_full(temp_to_resistance_cvd(900.0, c), c)),
          "above the standard's 850 C is no reading");

    std::cout << (g_failures == 0 ? "PASSED" : "FAILED: " + std::to_string(g_failures))
              << std::endl;
    return g_failures == 0 ? 0 : 1;
}
