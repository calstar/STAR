/**
 * PtSmoother: calibrated PT output smoothing. The first reading must come straight through —
 * the old map default-inserted 0.0 and every PT ramped up from 0 psi after a restart.
 */
#include <cmath>
#include <iostream>
#include <limits>
#include <string>

#include "calibration/PtSmoothing.hpp"

using fsw::calibration::PtSmoother;

static int g_failures = 0;
static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        ++g_failures;
}
static bool near(double a, double b) {
    return std::fabs(a - b) < 1e-9;
}

int main() {
    PtSmoother s;  // alpha 0.25

    check(near(s.step(1, 300.0), 300.0),
          "first reading passes through unsmoothed (not ramped from 0)");
    check(near(s.step(1, 300.0), 300.0), "a steady reading stays put");
    check(near(s.step(1, 340.0), 310.0), "then it smooths: 0.25*340 + 0.75*300 = 310");

    check(near(s.step(2, 50.0), 50.0), "each uid seeds independently");
    check(near(s.step(1, 310.0), 310.0), "another uid does not disturb this one");

    const double nan = std::numeric_limits<double>::quiet_NaN();
    check(std::isnan(s.step(3, nan)), "a non-finite reading is passed through");
    check(near(s.step(3, 120.0), 120.0),
          "and the next finite one re-seeds instead of averaging NaN");

    s.reset(1);
    check(near(s.step(1, 0.0), 0.0), "reset re-seeds from the next reading");

    // Several readings from cold: the archive's minimum is the first reading, not a ramp from 0.
    PtSmoother cold;
    double min_seen = 1e9;
    for (int i = 0; i < 10; ++i)
        min_seen = std::fmin(min_seen, cold.step(42, 300.0));
    check(near(min_seen, 300.0), "a 300 psi tank never reads below 300 psi from a cold start");

    std::cout << (g_failures ? "FAILED" : "PASSED") << std::endl;
    return g_failures ? 1 : 0;
}
