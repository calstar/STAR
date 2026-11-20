#include "t7/T7Convert.hpp"

#include <cmath>
#include <limits>

#include "calibration/SensorCalibration.hpp"
#include "calibration/TypeK.hpp"

namespace fsw {
namespace t7 {

namespace {
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kZeroC = 273.15;
}  // namespace

double cjc_device_offset_k(double device_temp_k, double ain14_v) {
    return device_temp_k - kAin14SlopeKPerV * ain14_v;
}

double cjc_temp_c(double ain14_v, double device_offset_k, double cjc_offset_k) {
    return kAin14SlopeKPerV * ain14_v + device_offset_k + cjc_offset_k - kZeroC;
}

double pt_psi(double volts, const config::T7Channel& ch) {
    double lo = 0, hi = 0;
    if (ch.signal == "0-5V") {
        lo = 0.0, hi = 5.0;
    } else if (ch.signal == "0.5-4.5V") {
        lo = 0.5, hi = 4.5;
    } else if (ch.signal == "1-5V") {
        lo = 1.0, hi = 5.0;
    } else if (ch.signal == "0-10V") {
        lo = 0.0, hi = 10.0;
    } else if (ch.signal == "4-20mA") {
        // The T7 measures the loop current as the voltage it develops across the shunt.
        lo = 0.004 * ch.shunt_ohms, hi = 0.020 * ch.shunt_ohms;
    } else {
        return kNaN;
    }
    if (!(hi > lo) || !(ch.full_scale > 0))
        return kNaN;
    return (volts - lo) / (hi - lo) * ch.full_scale;
}

double lc_kg(double volts, const config::T7Channel& ch) {
    const double rated_v = ch.sensitivity_mv_per_v / 1000.0 * ch.excitation_v;
    if (!(rated_v > 0) || !(ch.full_scale > 0))
        return kNaN;
    return volts / rated_v * ch.full_scale;
}

double tc_c(double volts, double cold_junction_c) {
    const double cj_mv = calibration::type_k_mv_from_c(cold_junction_c);
    return calibration::type_k_c_from_mv(volts * 1000.0 + cj_mv);  // NaN propagates
}

double rtd_ohms(double volts, const config::T7Channel& ch) {
    if (!(ch.ljtr_ohms > 0) || !(volts > 0) || !(volts < ch.vref_v))
        return kNaN;
    return ch.ljtr_ohms * (ch.vref_v - volts) / volts;
}

double rtd_c(double volts, const config::T7Channel& ch) {
    calibration::rtd::CVDCoeffs cvd;
    cvd.R0 = ch.r0_ohms;
    return calibration::rtd::resistance_to_temp_cvd_full(rtd_ohms(volts, ch), cvd);
}

const char* calibrated_field(const std::string& kind) {
    if (kind == "PT")
        return "pressure_psi";
    if (kind == "TC" || kind == "RTD")
        return "temperature_c";
    if (kind == "LC")
        return "force_kg";
    return "";
}

}  // namespace t7
}  // namespace fsw
