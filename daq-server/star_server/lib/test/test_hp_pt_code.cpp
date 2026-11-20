/**
 * Unit tests for fsw::calibration::hp_pt_shunt_code (4-20 mA PT wire code coercion).
 * House style: plain main(), return 0 on pass / 1 on failure. Registered in lib/CMakeLists.txt.
 *
 * The headline case is the code captured live on 2026-11-07 from HPD-PT (PT board 2 ch3):
 * 0xFFFF0FB5, a small negative ADC reading that the old coercion clamped to full scale.
 */

#include <cstdint>
#include <cstdio>
#include <initializer_list>

#include "calibration/HpPtCode.hpp"

using fsw::calibration::hp_pt_shunt_code;

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

/** Shunt volts for a code, as calibration_main's convert_hp_pt_to_pressure computes it. */
static double volts(uint32_t code) {
    return static_cast<double>(code) / 2147483648.0 * 2.5;
}

static void live_negative_code_is_no_current() {
    // Captured from the live stream: HPD-PT raw_adc_counts 4294905781 = 0xFFFF0FB5 = -61515 signed.
    const uint32_t captured = 4294905781u;
    const uint32_t c = hp_pt_shunt_code(captured);
    CHECK(c == 0u, "captured negative code 0x%08x -> 0x%08x, want 0 (was clamped to full scale)",
          captured, c);
    // Full scale would have been 2.5 V: 20.8 mA across 120 Ohm, i.e. 5000 psi.
    CHECK(volts(c) < 0.01, "negative code reads %.3f V on the shunt, want ~0", volts(c));
}

static void every_negative_code_is_zero() {
    for (uint32_t w : {0x80000000u, 0x80000001u, 0xC0000000u, 0xFFFFFF00u, 0xFFFFFFFFu})
        CHECK(hp_pt_shunt_code(w) == 0u, "0x%08x -> 0x%08x, want 0", w, hp_pt_shunt_code(w));
}

static void live_loop_codes_pass_through() {
    // 4 mA and 20 mA across 120 Ohm against 2.5 V, plus the ends of the positive range.
    const uint32_t four_ma = static_cast<uint32_t>(0.48 / 2.5 * 2147483648.0);
    const uint32_t twenty_ma = static_cast<uint32_t>(2.40 / 2.5 * 2147483648.0);
    for (uint32_t w : {0u, 1u, 282305u, four_ma, twenty_ma, 0x7FFFFFFFu})
        CHECK(hp_pt_shunt_code(w) == w, "valid code 0x%08x changed to 0x%08x", w,
              hp_pt_shunt_code(w));
}

int main() {
    std::printf("test_hp_pt_code\n");
    live_negative_code_is_no_current();
    every_negative_code_is_zero();
    live_loop_codes_pass_through();
    if (g_failures) {
        std::printf("FAILED: %d check(s)\n", g_failures);
        return 1;
    }
    std::printf("all passed\n");
    return 0;
}
