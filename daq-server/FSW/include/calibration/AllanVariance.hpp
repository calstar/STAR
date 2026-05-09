#ifndef ALLAN_VARIANCE_HPP
#define ALLAN_VARIANCE_HPP

#include <cmath>
#include <vector>

namespace fsw {
namespace calibration {

/**
 * Noise coefficients from Allan variance fit (scripts/calibration/allan_variance.py).
 * σ²_A(τ) = Q²/(2τ) + 2·ln(2)·B² + K²·τ/6 + R²·τ²/20
 */
struct NoiseCoefficients {
    double Q = 1e-3;
    double B = 1e-4;
    double K = 1e-5;
    double R = 1e-6;
    double tau_min = 1.0;
    double sigma_min = 1e-3;
};

/** Measurement σ from paper Section 7 (Python measurement_uncertainty). */
inline double measurement_uncertainty(double tau, const NoiseCoefficients& coeffs,
                                      double voltage = 0.0, double sigma_base = 1e-3) {
    double var = sigma_base * sigma_base;
    var += coeffs.Q * coeffs.Q / (2.0 * tau);
    var += 2.0 * std::log(2.0) * coeffs.B * coeffs.B;
    var += coeffs.K * coeffs.K * tau / 6.0;
    var += 1e-4 * voltage * voltage;
    return std::sqrt(std::max(var, 1e-12));
}

void compute_allan_variance(const std::vector<double>& timeseries, double tau0,
                            std::vector<double>& tau_out, std::vector<double>& sigma2_out);

NoiseCoefficients fit_noise_coefficients(const std::vector<double>& tau_arr,
                                         const std::vector<double>& sigma2_arr);

}  // namespace calibration
}  // namespace fsw

#endif
