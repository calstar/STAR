#include "EnvironmentalRobustCalibration.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>

// Algorithm 1: Environmental-Robust Bayesian Calibration with Adaptive TLS

EnvironmentalRobustCalibration::EnvironmentalRobustCalibration(
    std::shared_ptr<CalibrationMapFunction> calibration_map)
    : calibration_map_(calibration_map), calibration_confidence_(0.0) {
    if (!calibration_map_) {
        throw std::invalid_argument("Calibration map function cannot be null");
    }
}

EnvironmentalRobustCalibration::~EnvironmentalRobustCalibration() {
}

CalibrationParameters EnvironmentalRobustCalibration::performEnvironmentalRobustCalibration(
    const std::vector<CalibrationDataPoint>& calibration_data,
    const std::vector<double>& environmental_uncertainties,
    const Eigen::VectorXd& population_prior_mean,
    const Eigen::MatrixXd& population_prior_covariance, int max_iterations,
    double convergence_tolerance) {
    // Store inputs as specified in Algorithm 1
    calibration_data_ = calibration_data;
    environmental_uncertainties_ = environmental_uncertainties;

    // Step 4: Initialize θ^(0) = μ_pop, Σ_θ^(0) = Σ_pop
    Eigen::VectorXd theta_k = population_prior_mean;
    Eigen::MatrixXd covariance_k = population_prior_covariance;

    // Step 5: Initialize Q_env^(0), Q_interaction^(0)
    variance_model_.env_variance_matrix = Eigen::MatrixXd::Identity(5, 5) * 0.1;
    variance_model_.interaction_matrix = Eigen::MatrixXd::Identity(5, 5) * 0.01;
    variance_model_.nonlinear_variance_alpha1 = 0.001;
    variance_model_.nonlinear_variance_alpha2 = 0.0001;
    variance_model_.nonlinear_variance_alpha3 = 0.00001;

    // Main Loop: for k = 1 to max_iterations
    for (int k = 1; k <= max_iterations; ++k) {
        Eigen::VectorXd theta_prev = theta_k;
        Eigen::MatrixXd covariance_prev = covariance_k;

        // Step 1: Update environmental variance model
        std::vector<double> total_variances = updateEnvironmentalVarianceModel(k);

        // Step 2: Solve robust TLS with environmental calibration map
        theta_k = solveRobustTLS(total_variances, k);

        // Step 3: Update calibration parameter posterior
        auto [theta_updated, covariance_updated] =
            updateCalibrationParameterPosterior(theta_k, total_variances, k);
        theta_k = theta_updated;
        covariance_k = covariance_updated;

        // Step 4: Update environmental variance parameters
        updateEnvironmentalVarianceParameters(theta_k, k);

        // Convergence check: ||θ^(k) - θ^(k-1)|| < ε && ||Q_env^(k) - Q_env^(k-1)|| < ε
        double theta_change = (theta_k - theta_prev).norm();
        double env_change =
            (variance_model_.env_variance_matrix - Eigen::MatrixXd::Identity(5, 5) * 0.1).norm();

        if (theta_change < convergence_tolerance && env_change < convergence_tolerance) {
            std::cout << "Algorithm 1 converged after " << k << " iterations" << std::endl;
            break;
        }
    }

    // Step 5: Validate calibration robustness
    CalibrationQualityMetrics quality_metrics =
        validateCalibrationRobustness(theta_k, covariance_k);

    // Create result
    CalibrationParameters result;
    result.theta = theta_k;
    result.covariance = covariance_k;
    result.basis_functions = calibration_map_->getParameterNames();
    result.calibration_quality = quality_metrics.nrmse;

    current_calibration_ = result;
    calibration_confidence_ = quality_metrics.coverage_95;  // Use coverage as confidence metric

    return result;
}

void EnvironmentalRobustCalibration::addCalibrationDataPoint(
    double voltage, double reference_pressure, const EnvironmentalState& environmental_state,
    double environmental_uncertainty) {
    CalibrationDataPoint data_point;
    data_point.voltage = voltage;
    data_point.reference_pressure = reference_pressure;
    data_point.reference_pressure_uncertainty = environmental_uncertainty;
    data_point.environment = environmental_state;
    data_point.timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count();

    calibration_data_.push_back(data_point);
    environmental_uncertainties_.push_back(environmental_uncertainty);
}

double EnvironmentalRobustCalibration::getCalibrationConfidence() const {
    return calibration_confidence_;
}

bool EnvironmentalRobustCalibration::isReadyForDeployment() const {
    return calibration_confidence_ > 0.8 && calibration_data_.size() >= 10;
}

EnvironmentalVarianceModel EnvironmentalRobustCalibration::getEnvironmentalVarianceModel() const {
    return variance_model_;
}

// Private methods implementing Algorithm 1 steps

std::vector<double> EnvironmentalRobustCalibration::updateEnvironmentalVarianceModel(int k) {
    std::vector<double> total_variances;

    for (size_t i = 0; i < calibration_data_.size(); ++i) {
        double total_variance = computeTotalVariance(i, k);
        total_variances.push_back(total_variance);
    }

    return total_variances;
}

Eigen::VectorXd EnvironmentalRobustCalibration::solveRobustTLS(
    const std::vector<double>& total_variances, int k) {
    // Step 2: min_θ Σ_i (p_obs,i - f(v_i, e_i; θ))^2 / σ_total,i^2

    int num_params = calibration_map_->getNumParameters();
    Eigen::VectorXd theta = current_calibration_.theta;
    if (theta.size() == 0) {
        theta = Eigen::VectorXd::Zero(num_params);
        if (num_params >= 2) {
            theta(0) = 1000.0;  // offset
            theta(1) = 1000.0;  // linear coefficient
        }
    }

    // Iterative robust TLS
    for (int iter = 0; iter < 10; ++iter) {  // Inner iterations for TLS
        Eigen::MatrixXd design_matrix(calibration_data_.size(), num_params);
        Eigen::VectorXd residuals(calibration_data_.size());
        Eigen::VectorXd weights(calibration_data_.size());

        for (size_t i = 0; i < calibration_data_.size(); ++i) {
            const auto& data_point = calibration_data_[i];

            // Compute Jacobian H_i = ∂f/∂θ
            design_matrix.row(i) =
                calibration_map_->jacobian(data_point.voltage, data_point.environment, theta);

            // Compute residual
            double prediction =
                calibration_map_->evaluate(data_point.voltage, data_point.environment, theta);
            residuals(i) = data_point.reference_pressure - prediction;

            // Compute weight based on total variance
            weights(i) = 1.0 / total_variances[i];
        }

        // Weighted least squares update
        Eigen::VectorXd weighted_residuals = weights.asDiagonal() * residuals;
        Eigen::MatrixXd weighted_design = weights.asDiagonal() * design_matrix;

        // Solve normal equations with regularization
        Eigen::MatrixXd reg_matrix = weighted_design.transpose() * weighted_design +
                                     0.01 * Eigen::MatrixXd::Identity(num_params, num_params);
        Eigen::VectorXd update =
            reg_matrix.ldlt().solve(weighted_design.transpose() * weighted_residuals);

        theta += update;

        // Check convergence
        if (update.norm() < 1e-6) {
            break;
        }
    }

    return theta;
}

std::pair<Eigen::VectorXd, Eigen::MatrixXd>
EnvironmentalRobustCalibration::updateCalibrationParameterPosterior(
    const Eigen::VectorXd& theta_k, const std::vector<double>& total_variances, int k) {
    // Step 3: Update calibration parameter posterior
    // H_i = ∂f/∂θ|_{v_i, e_i, θ^(k-1)}
    // Σ_θ^(k) = (Σ_θ^(k-1)^(-1) + Σ_i H_i^T H_i / σ_total,i^2)^(-1)
    // θ^(k) = Σ_θ^(k) (Σ_θ^(k-1)^(-1) θ^(k-1) + Σ_i H_i^T (p_obs,i - f(v_i, e_i; θ^(k-1))) /
    // σ_total,i^2)

    int num_params = calibration_map_->getNumParameters();
    Eigen::MatrixXd covariance_inv = current_calibration_.covariance.inverse();
    Eigen::VectorXd theta_prev = current_calibration_.theta;

    // Build information matrix and information vector
    Eigen::MatrixXd information_matrix = covariance_inv;
    Eigen::VectorXd information_vector = covariance_inv * theta_prev;

    for (size_t i = 0; i < calibration_data_.size(); ++i) {
        const auto& data_point = calibration_data_[i];

        // Compute Jacobian
        Eigen::VectorXd jacobian =
            calibration_map_->jacobian(data_point.voltage, data_point.environment, theta_prev);

        // Compute prediction
        double prediction =
            calibration_map_->evaluate(data_point.voltage, data_point.environment, theta_prev);

        // Update information matrix and vector
        information_matrix += (jacobian * jacobian.transpose()) / total_variances[i];
        information_vector +=
            (jacobian * (data_point.reference_pressure - prediction)) / total_variances[i];
    }

    // Solve for updated parameters and covariance
    Eigen::MatrixXd covariance_k = information_matrix.inverse();
    Eigen::VectorXd theta_updated = covariance_k * information_vector;

    return std::make_pair(theta_updated, covariance_k);
}

void EnvironmentalRobustCalibration::updateEnvironmentalVarianceParameters(
    const Eigen::VectorXd& theta_k, int k) {
    // Step 4: Update environmental variance parameters from residuals

    std::vector<double> residuals;
    std::vector<double> voltages;
    std::vector<Eigen::VectorXd> environmental_states;

    for (const auto& data_point : calibration_data_) {
        double prediction =
            calibration_map_->evaluate(data_point.voltage, data_point.environment, theta_k);
        residuals.push_back(data_point.reference_pressure - prediction);
        voltages.push_back(data_point.voltage);
        environmental_states.push_back(data_point.environment.toVector());
    }

    // Simple residual-based variance estimation
    double residual_variance = 0.0;
    for (double residual : residuals) {
        residual_variance += residual * residual;
    }
    residual_variance /= residuals.size();

    // Update environmental variance parameters
    variance_model_.base_variance = residual_variance;

    // Update nonlinear variance terms based on residual patterns
    double max_voltage = *std::max_element(voltages.begin(), voltages.end());
    double min_voltage = *std::min_element(voltages.begin(), voltages.end());
    double voltage_range = max_voltage - min_voltage;

    if (voltage_range > 0) {
        variance_model_.nonlinear_variance_alpha1 =
            residual_variance / (voltage_range * voltage_range * voltage_range * voltage_range);
        variance_model_.nonlinear_variance_alpha2 =
            residual_variance / (voltage_range * voltage_range);
        variance_model_.nonlinear_variance_alpha3 = residual_variance;
    }
}

CalibrationQualityMetrics EnvironmentalRobustCalibration::validateCalibrationRobustness(
    const Eigen::VectorXd& theta_final, const Eigen::MatrixXd& covariance_final) {
    // Step 5: Validate calibration robustness
    CalibrationQualityMetrics metrics;

    // Compute residuals
    std::vector<double> residuals;
    std::vector<double> predictions;

    for (const auto& data_point : calibration_data_) {
        double prediction =
            calibration_map_->evaluate(data_point.voltage, data_point.environment, theta_final);
        predictions.push_back(prediction);
        residuals.push_back(data_point.reference_pressure - prediction);
    }

    // Compute NRMSE
    double mse = 0.0;
    for (double residual : residuals) {
        mse += residual * residual;
    }
    mse /= residuals.size();

    double max_pressure = *std::max_element(predictions.begin(), predictions.end());
    double min_pressure = *std::min_element(predictions.begin(), predictions.end());
    double pressure_range = max_pressure - min_pressure;

    metrics.nrmse = pressure_range > 0 ? std::sqrt(mse) / pressure_range : std::sqrt(mse);

    // Compute coverage probability (95% confidence)
    double coverage_count = 0.0;
    for (size_t i = 0; i < residuals.size(); ++i) {
        double uncertainty = std::sqrt(computeTotalVariance(i, 0));  // Use final variance
        if (std::abs(residuals[i]) <= 1.96 * uncertainty) {          // 95% confidence
            coverage_count += 1.0;
        }
    }
    metrics.coverage_95 = coverage_count / residuals.size();

    // Compute condition number
    Eigen::JacobiSVD<Eigen::MatrixXd> svd(covariance_final);
    metrics.condition_number =
        svd.singularValues()(0) / svd.singularValues()(svd.singularValues().size() - 1);

    // Compute AIC and BIC
    double log_likelihood = 0.0;
    for (size_t i = 0; i < residuals.size(); ++i) {
        double uncertainty = std::sqrt(computeTotalVariance(i, 0));
        log_likelihood += -0.5 * std::log(2.0 * M_PI * uncertainty * uncertainty) -
                          0.5 * residuals[i] * residuals[i] / (uncertainty * uncertainty);
    }

    int num_params = theta_final.size();
    int num_data = residuals.size();
    metrics.aic = 2 * num_params - 2 * log_likelihood;
    metrics.bic = std::log(num_data) * num_params - 2 * log_likelihood;

    return metrics;
}

double EnvironmentalRobustCalibration::computeTotalVariance(int i, int k) {
    // σ_total,i^2 = σ_base^2 + e_i^T Q_env e_i + v_i^2 e_i^T Q_interaction e_i + α_1 v_i^4 + α_2
    // ||e_i||^2 v_i^2 + α_3 ||e_i||^4

    if (i >= calibration_data_.size()) {
        return 1.0;
    }

    const auto& data_point = calibration_data_[i];
    double voltage = data_point.voltage;
    Eigen::VectorXd env_vector = data_point.environment.toVector();

    double total_variance = variance_model_.base_variance;

    // Environmental variance terms
    total_variance += env_vector.transpose() * variance_model_.env_variance_matrix * env_vector;
    total_variance += voltage * voltage * env_vector.transpose() *
                      variance_model_.interaction_matrix * env_vector;

    // Nonlinear variance terms
    total_variance += variance_model_.nonlinear_variance_alpha1 * std::pow(voltage, 4);
    total_variance +=
        variance_model_.nonlinear_variance_alpha2 * env_vector.squaredNorm() * voltage * voltage;
    total_variance +=
        variance_model_.nonlinear_variance_alpha3 * std::pow(env_vector.squaredNorm(), 2);

    // Add measurement uncertainty
    total_variance +=
        data_point.reference_pressure_uncertainty * data_point.reference_pressure_uncertainty;

    return total_variance;
}

double EnvironmentalRobustCalibration::computeEnvironmentalVariance(
    const Eigen::VectorXd& env_vector, double voltage, int k) {
    double env_variance = env_vector.transpose() * variance_model_.env_variance_matrix * env_vector;
    env_variance += voltage * voltage * env_vector.transpose() *
                    variance_model_.interaction_matrix * env_vector;
    return env_variance;
}

double EnvironmentalRobustCalibration::computeNonlinearVariance(double voltage,
                                                                const Eigen::VectorXd& env_vector) {
    double nonlinear_variance = variance_model_.nonlinear_variance_alpha1 * std::pow(voltage, 4);
    nonlinear_variance +=
        variance_model_.nonlinear_variance_alpha2 * env_vector.squaredNorm() * voltage * voltage;
    nonlinear_variance +=
        variance_model_.nonlinear_variance_alpha3 * std::pow(env_vector.squaredNorm(), 2);
    return nonlinear_variance;
}

// Algorithm 2: Online Environmental-Adaptive EKF with Change Detection

EnvironmentalAdaptiveEKF::EnvironmentalAdaptiveEKF(
    const CalibrationParameters& calibration_parameters,
    const EnvironmentalVarianceModel& environmental_variance_model,
    const EnvironmentalState& initial_environmental_state,
    const Eigen::MatrixXd& initial_environmental_covariance,
    std::shared_ptr<CalibrationMapFunction> calibration_map, int num_physical_states)
    : initial_calibration_(calibration_parameters),
      variance_model_(environmental_variance_model),
      calibration_map_(calibration_map),
      initial_environment_(initial_environmental_state),
      initial_environmental_covariance_(initial_environmental_covariance),
      num_physical_states_(num_physical_states),
      num_calibration_params_(calibration_parameters.theta.size()),
      change_detected_(false),
      lambda_k_(0.0),
      gamma_threshold_(5.0) {
    // Initialize state indices
    physical_start_idx_ = 0;
    calibration_start_idx_ = num_physical_states_;
    environment_start_idx_ = num_physical_states_ + num_calibration_params_;
    bias_idx_ = environment_start_idx_ + 5;  // Environmental state has 5 elements

    int total_state_size =
        num_physical_states_ + num_calibration_params_ + 5 + 1;  // +1 for residual bias

    // Initialize state vector: x_0 = [x_phys,0, θ, ê_0, b_0]ᵀ
    x_k_ = Eigen::VectorXd::Zero(total_state_size);

    // Set calibration parameters
    x_k_.segment(calibration_start_idx_, num_calibration_params_) = calibration_parameters.theta;

    // Set environmental state
    x_k_.segment(environment_start_idx_, 5) = initial_environmental_state.toVector();

    // Initialize covariance matrix: P_0 = blkdiag(P_phys,0, Σ_θ, Σ_e,0, Σ_b,0)
    P_k_ = Eigen::MatrixXd::Identity(total_state_size, total_state_size);

    // Set physical state covariance
    P_k_.block(physical_start_idx_, physical_start_idx_, num_physical_states_,
               num_physical_states_) =
        100.0 * Eigen::MatrixXd::Identity(num_physical_states_, num_physical_states_);

    // Set calibration parameter covariance
    P_k_.block(calibration_start_idx_, calibration_start_idx_, num_calibration_params_,
               num_calibration_params_) = calibration_parameters.covariance;

    // Set environmental state covariance
    P_k_.block(environment_start_idx_, environment_start_idx_, 5, 5) =
        initial_environmental_covariance;

    // Set residual bias covariance
    P_k_(bias_idx_, bias_idx_) = 1.0;

    // Initialize process models
    F_ = Eigen::MatrixXd::Identity(total_state_size, total_state_size);
    F_env_ = Eigen::MatrixXd::Identity(5, 5);
    rho_ = 0.95;  // Residual bias correlation coefficient
}

EnvironmentalAdaptiveEKF::~EnvironmentalAdaptiveEKF() {
}

std::pair<double, double> EnvironmentalAdaptiveEKF::processMeasurement(
    double voltage, double observed_pressure,
    const EnvironmentalState& sensor_environmental_state) {
    static int k = 0;  // Time step counter
    k++;

    // Environmental State Update (Lines 7-9)
    updateEnvironmentalState(k);

    // Prediction (Lines 10-13)
    predictionStep(k);

    // Adaptive Variance Computation (Lines 14-17)
    double total_variance = computeAdaptiveVariance(voltage, k);

    // GLR Test (Lines 18-23)
    double glr_statistic = performGLRTest(voltage, observed_pressure, k);
    change_detected_ = (glr_statistic > gamma_threshold_);

    // Update (Lines 24-29)
    auto [x_updated, P_updated] = updateStep(voltage, observed_pressure, k);
    x_k_ = x_updated;
    P_k_ = P_updated;

    // Output (Line 30): p̂_k = f(v_k, ê_k|k; θ̂_k|k) + b̂_k|k, σ²_p,k
    double predicted_pressure = computeMeasurementModel(voltage, k) + x_k_(bias_idx_);

    return std::make_pair(predicted_pressure, total_variance);
}

Eigen::VectorXd EnvironmentalAdaptiveEKF::getCurrentCalibrationParameters() const {
    return x_k_.segment(calibration_start_idx_, num_calibration_params_);
}

EnvironmentalState EnvironmentalAdaptiveEKF::getCurrentEnvironmentalState() const {
    EnvironmentalState env_state;
    env_state.fromVector(x_k_.segment(environment_start_idx_, 5));
    return env_state;
}

// Private methods implementing Algorithm 2 steps

void EnvironmentalAdaptiveEKF::updateEnvironmentalState(int k) {
    // Lines 7-9: Environmental State Update
    // ê_k|k-1 = F_env ê_k-1|k-1
    // Σ_e,k|k-1 = F_env Σ_e,k-1|k-1 F_env^T + Q_env

    Eigen::VectorXd env_state = x_k_.segment(environment_start_idx_, 5);
    Eigen::MatrixXd env_covariance =
        P_k_.block(environment_start_idx_, environment_start_idx_, 5, 5);

    // Predict environmental state
    env_state = F_env_ * env_state;

    // Predict environmental covariance
    env_covariance = F_env_ * env_covariance * F_env_.transpose() +
                     0.1 * Eigen::MatrixXd::Identity(5, 5);  // Q_env

    // Update state and covariance
    x_k_.segment(environment_start_idx_, 5) = env_state;
    P_k_.block(environment_start_idx_, environment_start_idx_, 5, 5) = env_covariance;
}

void EnvironmentalAdaptiveEKF::predictionStep(int k) {
    // Lines 10-13: Prediction
    // x̂_k|k-1 = F x̂_k-1|k-1
    // Q_k = Q(ê_k|k-1)  (Environment-dependent process noise)
    // P_k|k-1 = F P_k-1|k-1 F^T + Q_k

    // Predict state
    x_k_ = F_ * x_k_;

    // Compute environment-dependent process noise
    Eigen::MatrixXd Q_k = computeProcessNoiseCovariance(k);

    // Predict covariance
    P_k_ = F_ * P_k_ * F_.transpose() + Q_k;
}

double EnvironmentalAdaptiveEKF::computeAdaptiveVariance(double voltage, int k) {
    // Lines 14-17: Adaptive Variance Computation
    // σ²_total,k = σ²_base + ê_k|k-1^T Q_env ê_k|k-1 + v_k^2 ê_k|k-1^T Q_interaction ê_k|k-1 + α_1
    // v_k^4 + α_2 ||ê_k|k-1||^2 v_k^2 + α_3 ||ê_k|k-1||^4

    Eigen::VectorXd env_state = x_k_.segment(environment_start_idx_, 5);

    double total_variance = variance_model_.base_variance;

    // Environmental variance terms
    total_variance += env_state.transpose() * variance_model_.env_variance_matrix * env_state;
    total_variance +=
        voltage * voltage * env_state.transpose() * variance_model_.interaction_matrix * env_state;

    // Nonlinear variance terms
    total_variance += variance_model_.nonlinear_variance_alpha1 * std::pow(voltage, 4);
    total_variance +=
        variance_model_.nonlinear_variance_alpha2 * env_state.squaredNorm() * voltage * voltage;
    total_variance +=
        variance_model_.nonlinear_variance_alpha3 * std::pow(env_state.squaredNorm(), 2);

    return total_variance;
}

double EnvironmentalAdaptiveEKF::performGLRTest(double voltage, double observed_pressure, int k) {
    // Lines 18-23: GLR Test
    // Λ_k = max_{j ∈ [k-N+1,k]} sup_θ L(θ; D_{j:k}) / L(θ̂; D_{j:k})

    // Simple sliding window GLR test
    glr_window_.push_back(observed_pressure);
    if (glr_window_.size() > 50) {  // Window size N = 50
        glr_window_.pop_front();
    }

    if (glr_window_.size() < 10) {
        return 0.0;
    }

    // Compute likelihood ratio for current window
    double current_likelihood = 0.0;
    double max_likelihood = 0.0;

    for (double pressure : glr_window_) {
        double predicted = computeMeasurementModel(voltage, k);
        double residual = pressure - predicted;
        double variance = computeAdaptiveVariance(voltage, k);

        current_likelihood +=
            -0.5 * std::log(2.0 * M_PI * variance) - 0.5 * residual * residual / variance;
        max_likelihood = std::max(max_likelihood, current_likelihood);
    }

    lambda_k_ = max_likelihood - current_likelihood;

    // Trigger recalibration if change detected
    if (lambda_k_ > gamma_threshold_) {
        // Increase uncertainty: Σ_θ,k|k-1 ← Σ_θ,k|k-1 + ΔΣ_recal
        Eigen::MatrixXd recal_cov =
            100.0 * Eigen::MatrixXd::Identity(num_calibration_params_, num_calibration_params_);
        P_k_.block(calibration_start_idx_, calibration_start_idx_, num_calibration_params_,
                   num_calibration_params_) += recal_cov;
    }

    return lambda_k_;
}

std::pair<Eigen::VectorXd, Eigen::MatrixXd> EnvironmentalAdaptiveEKF::updateStep(
    double voltage, double observed_pressure, int k) {
    // Lines 24-29: Update
    // H_k = ∂h/∂x|_{x̂_k|k-1}
    // R_k = σ²_total,k + J_θ Σ_θ,k|k-1 J_θ^T + J_e Σ_e,k|k-1 J_e^T
    // K_k = P_k|k-1 H_k^T (H_k P_k|k-1 H_k^T + R_k)^(-1)
    // x̂_k|k = x̂_k|k-1 + K_k (p_obs,k - h(x̂_k|k-1, v_k))
    // P_k|k = (I - K_k H_k) P_k|k-1

    // Compute measurement model and Jacobian
    double predicted_measurement = computeMeasurementModel(voltage, k);
    Eigen::VectorXd H_k = computeMeasurementJacobian(voltage, k);

    // Compute measurement noise covariance
    double total_variance = computeAdaptiveVariance(voltage, k);
    Eigen::VectorXd J_theta = H_k.segment(calibration_start_idx_, num_calibration_params_);
    Eigen::VectorXd J_env = H_k.segment(environment_start_idx_, 5);

    double R_k = total_variance +
                 J_theta.transpose() *
                     P_k_.block(calibration_start_idx_, calibration_start_idx_,
                                num_calibration_params_, num_calibration_params_) *
                     J_theta +
                 J_env.transpose() *
                     P_k_.block(environment_start_idx_, environment_start_idx_, 5, 5) * J_env;

    // Compute Kalman gain
    double innovation_variance = H_k.transpose() * P_k_ * H_k + R_k;
    Eigen::VectorXd K_k = P_k_ * H_k / innovation_variance;

    // Update state
    double innovation = observed_pressure - predicted_measurement;
    Eigen::VectorXd x_updated = x_k_ + K_k * innovation;

    // Update covariance
    Eigen::MatrixXd P_updated =
        (Eigen::MatrixXd::Identity(P_k_.rows(), P_k_.cols()) - K_k * H_k.transpose()) * P_k_;

    return std::make_pair(x_updated, P_updated);
}

Eigen::VectorXd EnvironmentalAdaptiveEKF::computeMeasurementJacobian(double voltage, int k) {
    // H_k = ∂h/∂x|_{x̂_k|k-1}
    int total_state_size = x_k_.size();
    Eigen::VectorXd H_k = Eigen::VectorXd::Zero(total_state_size);

    // Get current calibration parameters and environmental state
    Eigen::VectorXd theta = x_k_.segment(calibration_start_idx_, num_calibration_params_);
    EnvironmentalState env_state;
    env_state.fromVector(x_k_.segment(environment_start_idx_, 5));

    // Compute Jacobian with respect to calibration parameters
    Eigen::VectorXd jacobian_theta = calibration_map_->jacobian(voltage, env_state, theta);
    H_k.segment(calibration_start_idx_, num_calibration_params_) = jacobian_theta;

    // Compute Jacobian with respect to environmental state
    Eigen::VectorXd jacobian_env =
        calibration_map_->environmentalJacobian(voltage, env_state, theta);
    H_k.segment(environment_start_idx_, 5) = jacobian_env;

    // Jacobian with respect to residual bias
    H_k(bias_idx_) = 1.0;

    return H_k;
}

double EnvironmentalAdaptiveEKF::computeMeasurementModel(double voltage, int k) {
    // h(x̂_k|k-1, v_k) = f(v_k, ê_k|k-1; θ̂_k|k-1)
    Eigen::VectorXd theta = x_k_.segment(calibration_start_idx_, num_calibration_params_);
    EnvironmentalState env_state;
    env_state.fromVector(x_k_.segment(environment_start_idx_, 5));

    return calibration_map_->evaluate(voltage, env_state, theta);
}

Eigen::MatrixXd EnvironmentalAdaptiveEKF::computeProcessNoiseCovariance(int k) {
    // Q_k = Q(ê_k|k-1)  (Environment-dependent process noise)
    int total_state_size = x_k_.size();
    Eigen::MatrixXd Q_k = Eigen::MatrixXd::Zero(total_state_size, total_state_size);

    // Physical state process noise
    Q_k.block(physical_start_idx_, physical_start_idx_, num_physical_states_,
              num_physical_states_) =
        0.1 * Eigen::MatrixXd::Identity(num_physical_states_, num_physical_states_);

    // Calibration parameter process noise (small)
    Q_k.block(calibration_start_idx_, calibration_start_idx_, num_calibration_params_,
              num_calibration_params_) =
        0.01 * Eigen::MatrixXd::Identity(num_calibration_params_, num_calibration_params_);

    // Environmental state process noise
    Q_k.block(environment_start_idx_, environment_start_idx_, 5, 5) =
        0.1 * Eigen::MatrixXd::Identity(5, 5);

    // Residual bias process noise
    Q_k(bias_idx_, bias_idx_) = 0.01 * (1 - rho_ * rho_);

    return Q_k;
}

// Human-in-the-Loop Calibration System

HumanInTheLoopCalibrationSystem::HumanInTheLoopCalibrationSystem(
    std::shared_ptr<CalibrationMapFunction> calibration_map)
    : calibration_map_(calibration_map),
      deployment_phase_(false),
      training_data_points_(0),
      training_confidence_(0.0) {
    if (!calibration_map_) {
        throw std::invalid_argument("Calibration map function cannot be null");
    }

    initializeAlgorithm1();
}

HumanInTheLoopCalibrationSystem::~HumanInTheLoopCalibrationSystem() {
}

std::pair<bool, double> HumanInTheLoopCalibrationSystem::processTrainingMeasurement(
    double voltage, const EnvironmentalState& environmental_state) {
    if (deployment_phase_) {
        // Phase 2: Algorithm 2 - Online deployment
        auto [predicted_pressure, uncertainty] =
            algorithm2_->processMeasurement(voltage, 0.0, environmental_state);
        return std::make_pair(false, predicted_pressure);  // No human input needed in deployment
    }

    // Phase 1: Algorithm 1 - Human-in-the-loop training
    if (training_data_points_ < 5) {
        // Always need human input in early training phase
        return std::make_pair(true, 0.0);
    }

    // Check if we have enough data for autonomous predictions
    if (algorithm1_->isReadyForDeployment()) {
        // Transition to deployment phase
        // Create default population priors for transition
        Eigen::VectorXd population_prior_mean =
            Eigen::VectorXd::Zero(3);       // 3 parameters for polynomial
        population_prior_mean(0) = 1000.0;  // offset
        population_prior_mean(1) = 1000.0;  // linear coefficient
        population_prior_mean(2) = 0.0;     // quadratic coefficient

        Eigen::MatrixXd population_prior_covariance = Eigen::MatrixXd::Identity(3, 3) * 100.0;

        completeTrainingPhase(population_prior_mean, population_prior_covariance);
        auto [predicted_pressure, uncertainty] =
            algorithm2_->processMeasurement(voltage, 0.0, environmental_state);
        return std::make_pair(false, predicted_pressure);
    }

    // Still in training phase, need human input
    return std::make_pair(true, 0.0);
}

void HumanInTheLoopCalibrationSystem::provideHumanInput(
    double voltage, double reference_pressure, const EnvironmentalState& environmental_state) {
    if (deployment_phase_) {
        std::cout << "Warning: System is in deployment phase, human input ignored" << std::endl;
        return;
    }

    // Add calibration data point to Algorithm 1
    algorithm1_->addCalibrationDataPoint(voltage, reference_pressure, environmental_state,
                                         50.0);  // 50 Pa uncertainty
    training_data_points_++;

    std::cout << "Human input provided: " << voltage << "V -> " << reference_pressure << "Pa"
              << std::endl;
    std::cout << "Training data points: " << training_data_points_ << std::endl;
}

bool HumanInTheLoopCalibrationSystem::completeTrainingPhase(
    const Eigen::VectorXd& population_prior_mean,
    const Eigen::MatrixXd& population_prior_covariance) {
    if (deployment_phase_) {
        return true;  // Already in deployment phase
    }

    if (training_data_points_ < 5) {
        std::cout << "Insufficient training data for deployment phase" << std::endl;
        return false;
    }

    std::cout << "Completing Algorithm 1 training phase..." << std::endl;

    // Perform Algorithm 1: Environmental-Robust Bayesian Calibration
    CalibrationParameters calibration_result = algorithm1_->performEnvironmentalRobustCalibration(
        {},  // Data already added via addCalibrationDataPoint
        {},  // Uncertainties already added
        population_prior_mean, population_prior_covariance);

    // Get environmental variance model
    EnvironmentalVarianceModel variance_model = algorithm1_->getEnvironmentalVarianceModel();

    // Initialize Algorithm 2 with Algorithm 1 results
    initializeAlgorithm2(calibration_result, variance_model);

    // Transition to deployment phase
    deployment_phase_ = true;
    training_confidence_ = algorithm1_->getCalibrationConfidence();

    std::cout << "Training phase completed. Confidence: " << training_confidence_ << std::endl;
    std::cout << "Transitioning to Algorithm 2 deployment phase..." << std::endl;

    return true;
}

std::pair<double, double> HumanInTheLoopCalibrationSystem::processDeploymentMeasurement(
    double voltage, const EnvironmentalState& environmental_state) {
    if (!deployment_phase_) {
        throw std::runtime_error("System not in deployment phase. Complete training phase first.");
    }

    // Use Algorithm 2: Environmental-Adaptive EKF
    auto [predicted_pressure, uncertainty] =
        algorithm2_->processMeasurement(voltage, 0.0, environmental_state);

    return std::make_pair(predicted_pressure, uncertainty);
}

double HumanInTheLoopCalibrationSystem::getTrainingConfidence() const {
    if (deployment_phase_) {
        return training_confidence_;
    }
    return algorithm1_->getCalibrationConfidence();
}

bool HumanInTheLoopCalibrationSystem::isChangeDetected() const {
    if (!deployment_phase_) {
        return false;
    }
    return algorithm2_->isChangeDetected();
}

std::map<std::string, double> HumanInTheLoopCalibrationSystem::getSystemStatistics() const {
    std::map<std::string, double> stats;

    stats["deployment_phase"] = deployment_phase_ ? 1.0 : 0.0;
    stats["training_data_points"] = static_cast<double>(training_data_points_);
    stats["training_confidence"] = training_confidence_;

    if (deployment_phase_ && algorithm2_) {
        stats["change_detected"] = algorithm2_->isChangeDetected() ? 1.0 : 0.0;
        stats["glr_statistic"] = algorithm2_->getChangeDetectionStatistic();
    }

    return stats;
}

void HumanInTheLoopCalibrationSystem::initializeAlgorithm1() {
    algorithm1_ = std::make_shared<EnvironmentalRobustCalibration>(calibration_map_);
}

void HumanInTheLoopCalibrationSystem::initializeAlgorithm2(
    const CalibrationParameters& calibration_params,
    const EnvironmentalVarianceModel& variance_model) {
    // Initialize environmental state (could be enhanced with actual sensors)
    EnvironmentalState initial_env_state;
    initial_env_state.temperature = 25.0;
    initial_env_state.humidity = 50.0;
    initial_env_state.vibration_level = 0.1;
    initial_env_state.aging_factor = 0.0;
    initial_env_state.mounting_torque = 1.0;

    // Initialize environmental covariance
    Eigen::MatrixXd initial_env_covariance = Eigen::MatrixXd::Identity(5, 5) * 1.0;

    // Create Algorithm 2 instance
    algorithm2_ = std::make_shared<EnvironmentalAdaptiveEKF>(
        calibration_params, variance_model, initial_env_state, initial_env_covariance,
        calibration_map_,
        3  // Number of physical states
    );
}
