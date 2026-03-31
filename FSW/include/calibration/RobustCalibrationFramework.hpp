#ifndef ROBUST_CALIBRATION_FRAMEWORK_HPP
#define ROBUST_CALIBRATION_FRAMEWORK_HPP

#include <Eigen/Dense>
#include <chrono>
#include <cstdint>
#include <deque>
#include <optional>
#include <utility>
#include <vector>

#include "calibration/AllanVariance.hpp"

namespace fsw {
namespace calibration {

struct PTCalibrationCoeffs;

/** Environmental state [T, H, V, A, M] — scripts/calibration/robust_calibration.py */
struct EnvironmentalState {
    double temperature = 25.0;
    double humidity = 50.0;
    double vibration = 0.0;
    double aging_factor = 1.0;
    double mounting_torque = 1.0;
};

struct CalibrationPoint {
    double adc_code = 0;
    double pressure = 0;
    double timestamp = 0;
    EnvironmentalState env{};
    double uncertainty = 0.01;
};

/**
 * Port of scripts/calibration/robust_calibration.py RobustCalibrationFramework:
 * 9-parameter environmental basis, TLS, Bayesian update, RLS, GLR drift, Gauss–Markov bias,
 * optional Allan σ_meas (AllanVariance.hpp).
 */
class RobustCalibrationFramework {
public:
    static constexpr int N = 9;

    explicit RobustCalibrationFramework(int sensor_id);

    /** Seed θ from factory cubic P(adc); maps to linear-in-adc_norm prior like Python set_theta_from_polynomial fallback. */
    void seed_from_factory_cubic(const PTCalibrationCoeffs& c);

    void set_theta_from_polynomial(const std::vector<double>& poly_coeffs, double adc_norm_min, double adc_norm_scale);

    void set_noise_coeffs(const NoiseCoefficients& c, double tau0 = 0.01);

    /** Mean + σ; updates bias propagation clock. */
    std::pair<double, double> predict_pressure_with_uncertainty(double adc_code, const EnvironmentalState& env);

    /** Mean PSI for streaming (default env, used by calibration_service). */
    double predict_pressure_psi(double adc_code);

    /** Zero / capture / reference — full Python add_calibration_point logic. */
    void add_calibration_point(const CalibrationPoint& point);

    int sensor_id() const {
        return sensor_id_;
    }
    size_t calibration_points_count() const {
        return calibration_points_.size();
    }

    Eigen::VectorXd theta_mean() const {
        return theta_mean_;
    }
    Eigen::MatrixXd theta_cov() const {
        return theta_cov_;
    }
    void set_theta_mean_for_restore(const Eigen::VectorXd& t);
    void set_theta_cov_for_restore(const Eigen::MatrixXd& cov);
    Eigen::MatrixXd rls_P_matrix() const {
        return rls_P_;
    }
    void set_rls_P_for_restore(const Eigen::MatrixXd& p);

private:
    int sensor_id_;

    std::vector<CalibrationPoint> calibration_points_;
    static constexpr size_t kCalibrationPointsMax = 50;

    Eigen::VectorXd theta_mean_;
    Eigen::MatrixXd theta_cov_;
    Eigen::MatrixXd rls_P_;

    double forgetting_factor_;
    double glr_threshold_;
    int glr_window_size_;

    double env_variance_base_;
    double alpha_v_;
    double alpha_extrap_;

    Eigen::MatrixXd env_var_env_;         // 5x5
    Eigen::MatrixXd env_var_interaction_; // 5x5

    struct PhysicalParams {
        double alpha1 = 0.001, alpha2 = 0.0001;
        double beta1 = 0.0001, beta2 = 0.00001;
        double gamma1 = 0.0001;
        double delta1 = 0.001, delta2 = 0.0001;
    } physical_;

    // Gauss–Markov bias (3-state)
    Eigen::Vector3d bias_b_;
    Eigen::Matrix3d bias_P_;
    Eigen::Vector3d bias_tau_;
    double bias_process_noise_;

    std::chrono::steady_clock::time_point last_pred_time_;
    double last_bias_update_t_;
    double inflation_factor_;

    std::optional<NoiseCoefficients> noise_coeffs_;
    double allan_tau0_;

    std::deque<double> recent_residuals_;
    std::deque<double> recent_uncertainties_;
    double sigma_ref_;

    Eigen::VectorXd environmental_basis(double adc_code, const EnvironmentalState& env) const;

    std::pair<Eigen::VectorXd, Eigen::MatrixXd> total_least_squares_calibration(
        const std::vector<CalibrationPoint>& points) const;

    std::pair<Eigen::VectorXd, Eigen::MatrixXd> bayesian_update(const std::vector<CalibrationPoint>& new_points);

    std::pair<Eigen::VectorXd, Eigen::MatrixXd> recursive_least_squares_update(const CalibrationPoint& point);

    std::pair<double, bool> generalized_likelihood_ratio_test(const std::vector<CalibrationPoint>& points) const;

    double extrapolation_variance(double adc_code) const;

    double compute_measurement_variance(double adc_code, double tau) const;

    void bias_propagate(double dt);
    void bias_update(double residual, double sigma_meas, double dt);
    double bias_contribution() const;
    double bias_variance() const;
};

}  // namespace calibration
}  // namespace fsw

#endif
