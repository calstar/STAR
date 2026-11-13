#include "calibration/AllanVariance.hpp"

#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <numeric>

namespace fsw {
namespace calibration {

void compute_allan_variance(const std::vector<double>& timeseries, double tau0,
                            std::vector<double>& tau_out, std::vector<double>& sigma2_out) {
    tau_out.clear();
    sigma2_out.clear();
    const size_t n = timeseries.size();
    if (n < 10) {
        if (n > 0) {
            double mean = 0;
            for (double x : timeseries)
                mean += x;
            mean /= static_cast<double>(n);
            double v = 0;
            for (double x : timeseries) {
                double d = x - mean;
                v += d * d;
            }
            v /= static_cast<double>(n);
            tau_out.push_back(tau0);
            sigma2_out.push_back(v);
        }
        return;
    }

    size_t max_m = std::max<size_t>(2, n / 4);
    size_t m = 1;
    while (m <= max_m && n >= 3 * m) {
        size_t num_triplets = (n - 2 * m) / m;
        if (num_triplets < 1)
            break;

        std::vector<double> clusters;
        clusters.reserve(num_triplets + 3);
        for (size_t i = 0; i < num_triplets + 2 && (i + 1) * m <= n; ++i) {
            double sum = 0;
            for (size_t k = 0; k < m; ++k)
                sum += timeseries[i * m + k];
            clusters.push_back(sum / static_cast<double>(m));
        }
        if (clusters.size() < 3)
            break;
        double acc = 0;
        size_t cnt = 0;
        for (size_t i = 0; i + 2 < clusters.size(); ++i) {
            double d = clusters[i + 2] - 2.0 * clusters[i + 1] + clusters[i];
            acc += d * d;
            ++cnt;
        }
        if (cnt == 0)
            break;
        double sigma2 = 0.5 * (acc / static_cast<double>(cnt));
        tau_out.push_back(static_cast<double>(m) * tau0);
        sigma2_out.push_back(sigma2);
        m = (m >= 2) ? m * 2 : m + 1;
    }
}

NoiseCoefficients fit_noise_coefficients(const std::vector<double>& tau_arr,
                                         const std::vector<double>& sigma2_arr) {
    NoiseCoefficients c;
    if (tau_arr.size() < 3 || sigma2_arr.size() != tau_arr.size()) {
        return c;
    }

    const size_t n = tau_arr.size();
    Eigen::MatrixXd X(static_cast<Eigen::Index>(n), 4);
    Eigen::VectorXd y(static_cast<Eigen::Index>(n));
    for (size_t i = 0; i < n; ++i) {
        double t = tau_arr[i];
        X(static_cast<Eigen::Index>(i), 0) = 1.0 / (2.0 * t);
        X(static_cast<Eigen::Index>(i), 1) = 2.0 * std::log(2.0);
        X(static_cast<Eigen::Index>(i), 2) = t / 6.0;
        X(static_cast<Eigen::Index>(i), 3) = t * t / 20.0;
        y(static_cast<Eigen::Index>(i)) = sigma2_arr[i];
    }

    Eigen::VectorXd beta = X.colPivHouseholderQr().solve(y);
    c.Q = std::sqrt(std::max(beta(0), 1e-12));
    c.B = std::sqrt(std::max(beta(1), 1e-12));
    c.K = std::sqrt(std::max(beta(2), 1e-12));
    c.R = std::sqrt(std::max(beta(3), 1e-12));

    c.tau_min = std::sqrt(3.0 * c.Q * c.Q / (c.K * c.K + 1e-20));
    if (c.K <= 1e-10)
        c.tau_min = tau_arr[n / 2];
    c.tau_min = std::clamp(c.tau_min, tau_arr.front(), tau_arr.back());
    double tm = c.tau_min;
    c.sigma_min = std::sqrt(c.Q * c.Q / (2.0 * tm) + 2.0 * std::log(2.0) * c.B * c.B +
                            c.K * c.K * tm / 6.0 + c.R * c.R * tm * tm / 20.0);
    return c;
}

}  // namespace calibration
}  // namespace fsw
