#include "calibration/TypeK.hpp"

#include <cmath>
#include <limits>

namespace fsw {
namespace calibration {

double type_k_c_from_mv(double v_mv) {
    // ITS-90 Type K inverse, rational form in 5 sub-ranges:
    // (v_min_mV, v_max_mV, T0, V0, p1, p2, p3, p4, q1, q2, q3); T = T0 + x*num/den, x = V - V0.
    // Moved verbatim from calibration_main.cpp convert_tc_adc_to_temp_c().
    static const double ranges[5][11] = {
        {-6.404, -3.554, -121.47164, -4.1790858, 36.069513, 30.722076, 7.791386, 0.52593997,
         0.93939547, 0.2779128, 0.02516334},
        {-3.554, 4.096, -8.7935962, -0.34489914, 25.678719, -0.49887904, -0.44705222, -0.044869202,
         0.00023893439, -0.02039775, -0.0018424107},
        {4.096, 16.397, 310.18976, 12.631386, 24.061949, 4.0158622, 0.26853917, -0.0097188544,
         0.16995872, 0.011413069, -0.00039275155},
        {16.397, 33.275, 605.72562, 25.148718, 23.539401, 0.046547228, 0.0134444, 0.0005923685,
         0.00083445513, 0.0004612144, 0.00002548812},
        {33.275, 69.553, 1018.4705, 41.99385, 25.783239, -1.8363403, 0.05617666, 0.000185324,
         -0.074803355, 0.002384186, 0.0},
    };
    for (const auto& r : ranges) {
        if (v_mv >= r[0] && v_mv <= r[1]) {
            const double x = v_mv - r[3];
            const double num = r[4] + x * (r[5] + x * (r[6] + x * r[7]));
            const double den = 1.0 + x * (r[8] + x * (r[9] + x * r[10]));
            if (std::abs(den) < 1e-20)
                return std::numeric_limits<double>::quiet_NaN();
            return r[2] + (x * num) / den;
        }
    }
    return std::numeric_limits<double>::quiet_NaN();
}

double type_k_mv_from_c(double c) {
    // The inverse is increasing across its whole span, so bisection on it converges to the EMF
    // whose temperature is `c`. 60 halvings of a 76 mV interval is far below a nanovolt.
    double lo = kTypeKMinMv, hi = kTypeKMaxMv;
    const double t_lo = type_k_c_from_mv(lo), t_hi = type_k_c_from_mv(hi);
    if (!std::isfinite(c) || c < t_lo || c > t_hi)
        return std::numeric_limits<double>::quiet_NaN();
    for (int i = 0; i < 60; ++i) {
        const double mid = 0.5 * (lo + hi);
        if (type_k_c_from_mv(mid) < c)
            lo = mid;
        else
            hi = mid;
    }
    return 0.5 * (lo + hi);
}

}  // namespace calibration
}  // namespace fsw
