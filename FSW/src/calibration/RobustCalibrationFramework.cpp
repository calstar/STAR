#include "calibration/RobustCalibrationFramework.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>

#include "calibration/PTCalibration.hpp"

namespace fsw {
namespace calibration {

namespace {
constexpr double kLog2 = 0.69314718055994530942;

double steady_secs(std::chrono::steady_clock::time_point t0,
                   std::chrono::steady_clock::time_point t1) {
    return std::chrono::duration<double>(t1 - t0).count();
}
}  // namespace

RobustCalibrationFramework::RobustCalibrationFramework(int sensor_id)
    : sensor_id_(sensor_id),
      theta_mean_(Eigen::VectorXd::Zero(N)),
      theta_cov_(Eigen::MatrixXd::Identity(N, N) * 0.05),
      rls_P_(Eigen::MatrixXd::Identity(N, N) * 100.0),
      forgetting_factor_(0.95),
      glr_threshold_(2.0),
      glr_window_size_(10),
      env_variance_base_(1e-3),
      alpha_v_(1e-4),
      alpha_extrap_(100.0),
      bias_b_(Eigen::Vector3d::Zero()),
      bias_P_(Eigen::Matrix3d::Identity() * 0.01),
      bias_tau_(1.0, 100.0, 1e4),
      bias_process_noise_(1e-4),
      last_pred_time_(std::chrono::steady_clock::now()),
      last_bias_update_t_(0.0),
      inflation_factor_(1.0),
      allan_tau0_(0.01),
      sigma_ref_(10.0) {
    theta_mean_ << 0.0, 200.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0;
    env_var_env_ = Eigen::MatrixXd::Identity(5, 5) * 0.0001;
    env_var_interaction_ = Eigen::MatrixXd::Identity(5, 5) * 0.00001;
}

void RobustCalibrationFramework::seed_from_factory_cubic(const PTCalibrationCoeffs& c) {
    static const double adcs[] = {-2e8, 0.0, 5e8, 1e9, 1.8e9};
    Eigen::MatrixXd A(5, 2);
    Eigen::VectorXd y(5);
    for (int i = 0; i < 5; ++i) {
        double adc_d = adcs[i];
        int32_t adc = static_cast<int32_t>(std::clamp(adc_d, -2.147e9, 2.147e9));
        A(i, 0) = 1.0;
        A(i, 1) = adc_d / 1e9;
        y(i) = c.calculate_pressure(adc);
    }
    Eigen::Vector2d t = A.colPivHouseholderQr().solve(y);
    theta_mean_.setZero();
    theta_mean_(0) = t(0);
    theta_mean_(1) = t(1);
    theta_cov_ = Eigen::MatrixXd::Identity(N, N) * 0.05;
    rls_P_ = Eigen::MatrixXd::Identity(N, N) * 100.0;
}

void RobustCalibrationFramework::set_theta_from_polynomial(const std::vector<double>& poly_coeffs,
                                                           double adc_norm_min,
                                                           double adc_norm_scale) {
    if (poly_coeffs.size() < 2 || adc_norm_scale <= 0)
        return;
    double c0 = poly_coeffs[0];
    double c1 = poly_coeffs[1];
    double theta1 = c1 * 1e9 / adc_norm_scale;
    double theta0 = c0 - theta1 * adc_norm_min / 1e9;
    theta_mean_.setZero();
    theta_mean_(0) = theta0;
    theta_mean_(1) = theta1;
}

void RobustCalibrationFramework::set_noise_coeffs(const NoiseCoefficients& c, double tau0) {
    noise_coeffs_ = c;
    allan_tau0_ = tau0;
}

void RobustCalibrationFramework::bias_propagate(double dt) {
    if (dt <= 0)
        return;
    Eigen::Vector3d phi_b = (-dt * bias_tau_.array().inverse()).array().exp();
    Eigen::Matrix3d Phi = phi_b.asDiagonal();
    Eigen::Vector3d q =
        bias_process_noise_ * (1.0 - (-2.0 * dt * bias_tau_.array().inverse()).array().exp());
    Eigen::Matrix3d Q = q.asDiagonal();
    bias_b_ = Phi * bias_b_;
    bias_P_ = Phi * bias_P_ * Phi.transpose() + Q;
}

void RobustCalibrationFramework::bias_update(double residual, double sigma_meas, double dt) {
    bias_propagate(dt);
    Eigen::Vector3d h = Eigen::Vector3d::Ones();
    double S = (h.transpose() * bias_P_ * h)(0, 0) + sigma_meas * sigma_meas;
    S = std::max(S, 1e-12);
    Eigen::Vector3d K = bias_P_ * h / S;
    bias_b_ = bias_b_ + K * residual;
    bias_P_ = (Eigen::Matrix3d::Identity() - K * h.transpose()) * bias_P_;
}

double RobustCalibrationFramework::bias_contribution() const {
    return bias_b_.sum();
}

double RobustCalibrationFramework::bias_variance() const {
    Eigen::Vector3d h = Eigen::Vector3d::Ones();
    return (h.transpose() * bias_P_ * h)(0, 0);
}

Eigen::VectorXd RobustCalibrationFramework::environmental_basis(
    double adc_code, const EnvironmentalState& env) const {
    const double T = env.temperature;
    const double H = env.humidity;
    const double V = env.vibration;
    const double A = env.aging_factor;
    const double M = env.mounting_torque;
    const double adc_norm = adc_code / 1e9;
    const double v = std::max(adc_norm, 1e-6);

    Eigen::VectorXd phi(N);
    phi(0) = 1.0;
    phi(1) = adc_norm;
    phi(2) =
        adc_norm * adc_norm + physical_.alpha1 * T * adc_norm + physical_.alpha2 * H * adc_norm;
    phi(3) = adc_norm * adc_norm * adc_norm + physical_.beta1 * T * adc_norm * adc_norm +
             physical_.beta2 * V * adc_norm;
    phi(4) = std::sqrt(v) + physical_.gamma1 * A * std::log(v);
    phi(5) = std::log1p(adc_norm) + physical_.delta1 * T + physical_.delta2 * H;
    phi(6) = adc_norm * T * H;
    phi(7) = adc_norm * adc_norm * V * M;
    phi(8) = A * adc_norm * adc_norm * adc_norm;
    return phi;
}

std::pair<Eigen::VectorXd, Eigen::MatrixXd>
RobustCalibrationFramework::total_least_squares_calibration(
    const std::vector<CalibrationPoint>& points) const {
    if (points.size() < 3)
        return {theta_mean_, theta_cov_};

    const int n = static_cast<int>(points.size());
    Eigen::MatrixXd Phi(n, N);
    Eigen::VectorXd p_obs(n);
    Eigen::VectorXd weights(n);
    for (int i = 0; i < n; ++i) {
        Phi.row(i) = environmental_basis(points[static_cast<size_t>(i)].adc_code,
                                         points[static_cast<size_t>(i)].env)
                         .transpose();
        p_obs(i) = points[static_cast<size_t>(i)].pressure;
        double u = points[static_cast<size_t>(i)].uncertainty;
        weights(i) = 1.0 / (u * u + env_variance_base_);
    }

    Eigen::MatrixXd Phi_T_W = Phi.transpose() * weights.asDiagonal();
    Eigen::MatrixXd cov_inv = Phi_T_W * Phi + Eigen::MatrixXd::Identity(N, N) * 1e-6;
    Eigen::LDLT<Eigen::MatrixXd> ldlt(cov_inv);
    if (ldlt.info() != Eigen::Success)
        return {theta_mean_, theta_cov_};
    Eigen::VectorXd rhs = Phi_T_W * p_obs;
    Eigen::VectorXd theta_mean = ldlt.solve(rhs);
    Eigen::MatrixXd I = Eigen::MatrixXd::Identity(N, N);
    Eigen::MatrixXd theta_cov = ldlt.solve(I);
    return {theta_mean, theta_cov};
}

std::pair<Eigen::VectorXd, Eigen::MatrixXd> RobustCalibrationFramework::bayesian_update(
    const std::vector<CalibrationPoint>& new_points) {
    if (new_points.empty())
        return {theta_mean_, theta_cov_};
    auto [theta_tls, theta_cov_tls] = total_least_squares_calibration(new_points);
    Eigen::MatrixXd I = Eigen::MatrixXd::Identity(N, N) * 1e-6;
    Eigen::MatrixXd prior_cov = theta_cov_ + I;
    Eigen::MatrixXd lik_cov = theta_cov_tls + I;
    Eigen::LDLT<Eigen::MatrixXd> ldlt_prior(prior_cov);
    Eigen::LDLT<Eigen::MatrixXd> ldlt_lik(lik_cov);
    if (ldlt_prior.info() != Eigen::Success || ldlt_lik.info() != Eigen::Success)
        return {theta_mean_, theta_cov_};
    Eigen::MatrixXd prior_prec = ldlt_prior.solve(Eigen::MatrixXd::Identity(N, N));
    Eigen::MatrixXd lik_prec = ldlt_lik.solve(Eigen::MatrixXd::Identity(N, N));
    Eigen::MatrixXd post_prec = prior_prec + lik_prec;
    Eigen::LDLT<Eigen::MatrixXd> ldlt_post(post_prec);
    if (ldlt_post.info() != Eigen::Success)
        return {theta_mean_, theta_cov_};
    Eigen::MatrixXd post_cov = ldlt_post.solve(Eigen::MatrixXd::Identity(N, N));
    Eigen::VectorXd post_mean = post_cov * (prior_prec * theta_mean_ + lik_prec * theta_tls);
    return {post_mean, post_cov};
}

std::pair<Eigen::VectorXd, Eigen::MatrixXd>
RobustCalibrationFramework::recursive_least_squares_update(const CalibrationPoint& point) {
    Eigen::VectorXd phi = environmental_basis(point.adc_code, point.env);
    Eigen::VectorXd Pphi = rls_P_ * phi;
    double denom = forgetting_factor_ + phi.dot(Pphi);
    if (std::abs(denom) < 1e-18)
        return {theta_mean_, theta_cov_};
    Eigen::VectorXd K = Pphi / denom;
    double prediction_error = point.pressure - phi.dot(theta_mean_);
    Eigen::VectorXd theta_new = theta_mean_ + K * prediction_error;
    rls_P_ = (rls_P_ - K * Pphi.transpose()) / forgetting_factor_;
    Eigen::MatrixXd theta_cov_new = rls_P_ + Eigen::MatrixXd::Identity(N, N) * 0.001;
    return {theta_new, theta_cov_new};
}

std::pair<double, bool> RobustCalibrationFramework::generalized_likelihood_ratio_test(
    const std::vector<CalibrationPoint>& points) const {
    if (static_cast<int>(points.size()) < glr_window_size_)
        return {0.0, false};

    std::vector<CalibrationPoint> recent(points.end() - glr_window_size_, points.end());

    double log_lik_current = 0;
    for (const auto& point : recent) {
        Eigen::VectorXd phi = environmental_basis(point.adc_code, point.env);
        double pred = phi.dot(theta_mean_);
        double res = point.pressure - pred;
        double var = point.uncertainty * point.uncertainty + env_variance_base_;
        log_lik_current += -0.5 * (res * res / var + std::log(2.0 * std::acos(-1.0) * var));
    }

    auto [theta_tls, _] = total_least_squares_calibration(recent);

    double log_lik_unc = 0;
    for (const auto& point : recent) {
        Eigen::VectorXd phi = environmental_basis(point.adc_code, point.env);
        double pred = phi.dot(theta_tls);
        double res = point.pressure - pred;
        double var = point.uncertainty * point.uncertainty + env_variance_base_;
        log_lik_unc += -0.5 * (res * res / var + std::log(2.0 * std::acos(-1.0) * var));
    }

    double glr = 2.0 * (log_lik_unc - log_lik_current);
    return {glr, glr > glr_threshold_};
}

double RobustCalibrationFramework::extrapolation_variance(double adc_code) const {
    if (calibration_points_.empty())
        return 0.0;
    double v_min = calibration_points_.front().adc_code;
    double v_max = calibration_points_.front().adc_code;
    for (const auto& p : calibration_points_) {
        v_min = std::min(v_min, p.adc_code);
        v_max = std::max(v_max, p.adc_code);
    }
    const double delta_v = std::max(v_max - v_min, 1e6);
    const double exp_cap = 100.0;
    auto penalty = [&](double d) {
        double exp_val = std::exp(std::min(2.0 * d, exp_cap));
        return alpha_extrap_ * d * d * exp_val;
    };
    if (adc_code < v_min) {
        double d = (v_min - adc_code) / delta_v;
        return penalty(d);
    }
    if (adc_code > v_max) {
        double d = (adc_code - v_max) / delta_v;
        return penalty(d);
    }
    return 0.0;
}

double RobustCalibrationFramework::compute_measurement_variance(double adc_code, double tau) const {
    const double adc_norm = adc_code / 1e9;
    if (noise_coeffs_) {
        double sigma = measurement_uncertainty(tau, *noise_coeffs_, adc_norm * 2.5,
                                               std::sqrt(env_variance_base_));
        return sigma * sigma;
    }
    return env_variance_base_ + alpha_v_ * adc_norm * adc_norm;
}

std::pair<double, double> RobustCalibrationFramework::predict_pressure_with_uncertainty(
    double adc_code, const EnvironmentalState& env) {
    auto now = std::chrono::steady_clock::now();
    double dt = steady_secs(last_pred_time_, now);
    dt = std::clamp(dt, 0.001, 10.0);
    last_pred_time_ = now;

    Eigen::VectorXd phi = environmental_basis(adc_code, env);
    double predicted = phi.dot(theta_mean_);
    bias_propagate(dt);
    predicted += bias_contribution();

    double meas_var = compute_measurement_variance(adc_code, 0.1);
    double parameter_variance = (phi.transpose() * theta_cov_ * phi)(0, 0);
    double extrap_var = extrapolation_variance(adc_code);
    double bias_var = bias_variance();

    Eigen::VectorXd ev(5);
    ev << env.temperature, env.humidity, env.vibration, env.aging_factor, env.mounting_torque;
    double env_var = (ev.transpose() * env_var_env_ * ev)(0, 0);
    const double adc_norm = adc_code / 1e9;
    double interaction_var =
        adc_norm * adc_norm * (ev.transpose() * env_var_interaction_ * ev)(0, 0);

    double total_var =
        meas_var + parameter_variance + extrap_var + bias_var + env_var + interaction_var;
    double sigma = std::sqrt(std::max(total_var, 1e-12)) * inflation_factor_;
    recent_uncertainties_.push_back(sigma);
    if (recent_uncertainties_.size() > 10)
        recent_uncertainties_.pop_front();
    // Cubic seed + bad ADC / θ can yield ±inf / 1e12; never publish that to Elodin.
    constexpr double kPsiAbsMax = 25000.0;
    constexpr double kPsiNegMin = -3000.0;
    if (!std::isfinite(predicted))
        predicted = 0.0;
    else
        predicted = std::clamp(predicted, kPsiNegMin, kPsiAbsMax);
    return {predicted, sigma};
}

double RobustCalibrationFramework::predict_pressure_psi(double adc_code) {
    EnvironmentalState env;
    return predict_pressure_with_uncertainty(adc_code, env).first;
}

void RobustCalibrationFramework::add_calibration_point(const CalibrationPoint& point) {
    calibration_points_.push_back(point);
    if (calibration_points_.size() > kCalibrationPointsMax)
        calibration_points_.erase(
            calibration_points_.begin(),
            calibration_points_.begin() +
                static_cast<std::ptrdiff_t>(calibration_points_.size() - kCalibrationPointsMax));

    Eigen::VectorXd phi = environmental_basis(point.adc_code, point.env);
    double pred_before = phi.dot(theta_mean_) + bias_contribution();
    double residual = point.pressure - pred_before;
    double dt_point = point.timestamp - last_bias_update_t_;
    if (last_bias_update_t_ <= 0)
        dt_point = 0.01;
    dt_point = std::clamp(dt_point, 0.001, 10.0);
    last_bias_update_t_ = point.timestamp;
    double sigma_meas = std::max(point.uncertainty, 1e-4);
    bias_update(residual, sigma_meas, dt_point);

    // First point at ~0 PSI: cancel θ₀ contribution from higher basis terms (Python)
    if (calibration_points_.size() == 1 && std::abs(point.pressure) < 1e-6) {
        double contrib_rest = theta_mean_.tail(N - 1).dot(phi.tail(N - 1));
        theta_mean_(0) = -contrib_rest;
        bias_b_.setZero();
        bias_P_ = Eigen::Matrix3d::Identity() * 0.01;
        return;
    }

    auto [glr_stat, drift] = generalized_likelihood_ratio_test(calibration_points_);
    (void)glr_stat;
    if (drift) {
        auto [tm, tc] = bayesian_update(calibration_points_);
        theta_mean_ = tm;
        theta_cov_ = tc;
    } else {
        auto [tm, tc] = recursive_least_squares_update(point);
        theta_mean_ = tm;
        theta_cov_ = tc;
    }

    phi = environmental_basis(point.adc_code, point.env);
    Eigen::VectorXd Pphi = rls_P_ * phi;
    double denom = forgetting_factor_ + phi.dot(Pphi);
    if (std::abs(denom) > 1e-18) {
        Eigen::VectorXd K = Pphi / denom;
        rls_P_ = (rls_P_ - K * Pphi.transpose()) / forgetting_factor_;
    }

    double pred = phi.dot(theta_mean_);
    recent_residuals_.push_back(std::abs(point.pressure - pred));
    if (recent_residuals_.size() > 10)
        recent_residuals_.pop_front();
}

void RobustCalibrationFramework::set_theta_mean_for_restore(const Eigen::VectorXd& t) {
    if (t.size() == N)
        theta_mean_ = t;
}

void RobustCalibrationFramework::set_theta_cov_for_restore(const Eigen::MatrixXd& cov) {
    if (cov.rows() == N && cov.cols() == N)
        theta_cov_ = cov;
}

void RobustCalibrationFramework::set_rls_P_for_restore(const Eigen::MatrixXd& p) {
    if (p.rows() == N && p.cols() == N)
        rls_P_ = p;
}

}  // namespace calibration
}  // namespace fsw
