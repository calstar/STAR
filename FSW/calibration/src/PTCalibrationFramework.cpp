#include "PTCalibrationFramework.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

// Polynomial Calibration Map Implementation
PolynomialCalibrationMap::PolynomialCalibrationMap() {
}

double PolynomialCalibrationMap::evaluate(double voltage, const EnvironmentalState& environment,
                                          const Eigen::VectorXd& theta) const {
    if (theta.size() != 6) {
        throw std::invalid_argument("Polynomial calibration map requires 6 parameters");
    }

    double result = 0.0;
    for (int k = 0; k < 6; ++k) {
        result += theta(k) * computeBasisFunction(k, voltage, environment);
    }
    return result;
}

Eigen::VectorXd PolynomialCalibrationMap::jacobian(double voltage,
                                                   const EnvironmentalState& environment,
                                                   const Eigen::VectorXd& theta) const {
    Eigen::VectorXd jac(6);
    for (int k = 0; k < 6; ++k) {
        jac(k) = computeBasisFunction(k, voltage, environment);
    }
    return jac;
}

Eigen::VectorXd PolynomialCalibrationMap::environmentalJacobian(
    double voltage, const EnvironmentalState& environment, const Eigen::VectorXd& theta) const {
    // For basic polynomial, environmental effects are minimal
    Eigen::VectorXd env_jac = Eigen::VectorXd::Zero(5);
    return env_jac;
}

bool PolynomialCalibrationMap::validateParameters(const Eigen::VectorXd& theta) const {
    if (theta.size() != 6)
        return false;

    // Check for reasonable parameter ranges
    // Basic validation - can be enhanced based on physical constraints
    return std::all_of(theta.data(), theta.data() + theta.size(), [](double x) {
        return std::isfinite(x);
    });
}

double PolynomialCalibrationMap::computeBasisFunction(int k, double voltage,
                                                      const EnvironmentalState& environment) const {
    // ROBUST VOLTAGE CLAMPING - Prevent numerical instability
    const double MIN_VOLTAGE = 1e-6;
    const double MAX_VOLTAGE = 10.0;
    voltage = std::clamp(voltage, MIN_VOLTAGE, MAX_VOLTAGE);

    switch (k) {
        case 0:
            return 1.0;  // offset
        case 1:
            return voltage;  // linear
        case 2:
            return voltage * voltage;  // quadratic
        case 3:
            return voltage * voltage * voltage;  // cubic
        case 4:
            return std::sqrt(voltage);  // sqrt (now safe due to clamping)
        case 5:
            return std::log(1.0 + voltage);  // log (now safe due to clamping)
        default:
            return 0.0;
    }
}

double PolynomialCalibrationMap::computeBasisFunctionDerivative(
    int k, double voltage, const EnvironmentalState& environment) const {
    // ROBUST VOLTAGE CLAMPING - Prevent numerical instability
    const double MIN_VOLTAGE = 1e-6;
    const double MAX_VOLTAGE = 10.0;
    voltage = std::clamp(voltage, MIN_VOLTAGE, MAX_VOLTAGE);

    switch (k) {
        case 0:
            return 0.0;  // offset derivative
        case 1:
            return 1.0;  // linear derivative
        case 2:
            return 2.0 * voltage;  // quadratic derivative
        case 3:
            return 3.0 * voltage * voltage;  // cubic derivative
        case 4:
            return 0.5 / std::sqrt(voltage);  // sqrt derivative (now safe)
        case 5:
            return 1.0 / (1.0 + voltage);  // log derivative (now safe)
        default:
            return 0.0;
    }
}

// Environmental Robust Calibration Map Implementation
EnvironmentalRobustCalibrationMap::EnvironmentalRobustCalibrationMap() {
}

double EnvironmentalRobustCalibrationMap::evaluate(double voltage,
                                                   const EnvironmentalState& environment,
                                                   const Eigen::VectorXd& theta) const {
    if (theta.size() != 6) {
        throw std::invalid_argument("Environmental robust calibration map requires 6 parameters");
    }

    double result = 0.0;
    for (int k = 0; k < 6; ++k) {
        result += theta(k) * computeRobustBasisFunction(k, voltage, environment);
    }
    return result;
}

Eigen::VectorXd EnvironmentalRobustCalibrationMap::jacobian(double voltage,
                                                            const EnvironmentalState& environment,
                                                            const Eigen::VectorXd& theta) const {
    Eigen::VectorXd jac(6);
    for (int k = 0; k < 6; ++k) {
        jac(k) = computeRobustBasisFunction(k, voltage, environment);
    }
    return jac;
}

Eigen::VectorXd EnvironmentalRobustCalibrationMap::environmentalJacobian(
    double voltage, const EnvironmentalState& environment, const Eigen::VectorXd& theta) const {
    Eigen::VectorXd env_jac(5);

    // Compute derivatives with respect to environmental variables
    // Based on the environmental-robust basis functions from the paper
    env_jac(0) = theta(2) * voltage * voltage + theta(5);       // temperature
    env_jac(1) = theta(2) * voltage + theta(5);                 // humidity
    env_jac(2) = theta(3) * voltage * voltage;                  // vibration
    env_jac(3) = theta(4) * std::log(std::max(1e-6, voltage));  // aging
    env_jac(4) = 0.0;  // mounting torque (not explicitly modeled in basis functions)

    return env_jac;
}

bool EnvironmentalRobustCalibrationMap::validateParameters(const Eigen::VectorXd& theta) const {
    if (theta.size() != 6)
        return false;

    // Enhanced validation for environmental-robust model
    return std::all_of(theta.data(), theta.data() + theta.size(), [](double x) {
        return std::isfinite(x);
    });
}

double EnvironmentalRobustCalibrationMap::computeRobustBasisFunction(
    int k, double voltage, const EnvironmentalState& environment) const {
    // ROBUST VOLTAGE CLAMPING - Prevent numerical instability
    const double MIN_VOLTAGE = 1e-6;
    const double MAX_VOLTAGE = 10.0;
    voltage = std::clamp(voltage, MIN_VOLTAGE, MAX_VOLTAGE);

    // ROBUST ENVIRONMENTAL CLAMPING - Prevent extreme environmental values
    const double clamped_temp = std::clamp(environment.temperature, -50.0, 150.0);
    const double clamped_humidity = std::clamp(environment.humidity, 0.0, 100.0);
    const double clamped_vibration = std::clamp(environment.vibration_level, 0.0, 100.0);
    const double clamped_aging = std::clamp(environment.aging_factor, 0.0, 10.0);

    switch (k) {
        case 0:
            return 1.0;  // offset
        case 1:
            return voltage;  // linear
        case 2:
            return voltage * voltage + 0.1 * clamped_temp * voltage +
                   0.01 * clamped_humidity * voltage;  // quadratic + env
        case 3:
            return voltage * voltage * voltage + 0.1 * clamped_temp * voltage * voltage +
                   0.1 * clamped_vibration * voltage;  // cubic + env
        case 4:
            return std::sqrt(voltage) +
                   0.1 * clamped_aging * std::log(voltage);  // sqrt + aging (now safe)
        case 5:
            return std::log(1.0 + voltage) + 0.1 * clamped_temp +
                   0.01 * clamped_humidity;  // log + env (now safe)
        default:
            return 0.0;
    }
}

double EnvironmentalRobustCalibrationMap::computeRobustBasisFunctionDerivative(
    int k, double voltage, const EnvironmentalState& environment) const {
    // ROBUST VOLTAGE CLAMPING - Prevent numerical instability
    const double MIN_VOLTAGE = 1e-6;
    const double MAX_VOLTAGE = 10.0;
    voltage = std::clamp(voltage, MIN_VOLTAGE, MAX_VOLTAGE);

    // ROBUST ENVIRONMENTAL CLAMPING - Prevent extreme environmental values
    const double clamped_temp = std::clamp(environment.temperature, -50.0, 150.0);
    const double clamped_humidity = std::clamp(environment.humidity, 0.0, 100.0);
    const double clamped_vibration = std::clamp(environment.vibration_level, 0.0, 100.0);
    const double clamped_aging = std::clamp(environment.aging_factor, 0.0, 10.0);

    switch (k) {
        case 0:
            return 0.0;  // offset derivative
        case 1:
            return 1.0;  // linear derivative
        case 2:
            return 2.0 * voltage + 0.1 * clamped_temp +
                   0.01 * clamped_humidity;  // quadratic + env derivative
        case 3:
            return 3.0 * voltage * voltage + 0.2 * clamped_temp * voltage +
                   0.1 * clamped_vibration;  // cubic + env derivative
        case 4:
            return 0.5 / std::sqrt(voltage) +
                   0.1 * clamped_aging / voltage;  // sqrt + aging derivative (now safe)
        case 5:
            return 1.0 / (1.0 + voltage);  // log derivative (env terms are constant, now safe)
        default:
            return 0.0;
    }
}

// Main PT Calibration Framework Implementation
PTCalibrationFramework::PTCalibrationFramework(
    std::shared_ptr<CalibrationMapFunction> calibration_map)
    : calibration_map_(calibration_map), rls_initialized_(false) {
    if (!calibration_map_) {
        throw std::invalid_argument("Calibration map function cannot be null");
    }
}

PTCalibrationFramework::~PTCalibrationFramework() {
}

void PTCalibrationFramework::addCalibrationData(const CalibrationDataPoint& data_point) {
    calibration_data_.push_back(data_point);
}

void PTCalibrationFramework::addCalibrationData(
    const std::vector<CalibrationDataPoint>& data_points) {
    calibration_data_.insert(calibration_data_.end(), data_points.begin(), data_points.end());
}

CalibrationParameters PTCalibrationFramework::performBayesianCalibration(
    const Eigen::VectorXd& population_prior_mean,
    const Eigen::MatrixXd& population_prior_covariance, double individual_variance) {
    // ROBUST NUMERICAL STABILITY CHECKS
    if (calibration_data_.empty()) {
        throw std::invalid_argument("No calibration data available");
    }

    // Check for finite inputs
    if (!population_prior_mean.allFinite()) {
        throw std::invalid_argument("Population prior mean contains non-finite values");
    }

    if (!population_prior_covariance.allFinite()) {
        throw std::invalid_argument("Population prior covariance contains non-finite values");
    }

    if (!std::isfinite(individual_variance) || individual_variance <= 0) {
        throw std::invalid_argument("Individual variance must be positive and finite");
    }

    int num_params = calibration_map_->getNumParameters();
    if (population_prior_mean.size() != num_params ||
        population_prior_covariance.rows() != num_params ||
        population_prior_covariance.cols() != num_params) {
        throw std::invalid_argument(
            "Population prior dimensions must match calibration map parameters");
    }

    // Initialize with population prior
    Eigen::VectorXd theta = population_prior_mean;
    Eigen::MatrixXd covariance = population_prior_covariance;

    // Iterative Bayesian update
    for (size_t i = 0; i < calibration_data_.size(); ++i) {
        const auto& data_point = calibration_data_[i];

        // Compute prediction and Jacobian
        double prediction =
            calibration_map_->evaluate(data_point.voltage, data_point.environment, theta);
        Eigen::VectorXd jacobian =
            calibration_map_->jacobian(data_point.voltage, data_point.environment, theta);

        // Compute total variance for this data point
        double total_variance = computeTotalVariance(data_point);

        // Kalman filter update
        double innovation = data_point.reference_pressure - prediction;
        double innovation_variance = jacobian.transpose() * covariance * jacobian + total_variance;

        if (innovation_variance > 1e-12) {
            Eigen::VectorXd kalman_gain = covariance * jacobian / innovation_variance;
            theta += kalman_gain * innovation;
            covariance = covariance - kalman_gain * jacobian.transpose() * covariance;
        }
    }

    // Add individual variance
    covariance += individual_variance * Eigen::MatrixXd::Identity(num_params, num_params);

    // Create result
    CalibrationParameters result;
    result.theta = theta;
    result.covariance = covariance;
    result.basis_functions = calibration_map_->getParameterNames();
    result.calibration_quality = computeQualityMetrics().nrmse;

    current_calibration_ = result;
    return result;
}

CalibrationParameters PTCalibrationFramework::performRobustTLS(int max_iterations,
                                                               double convergence_tolerance) {
    if (calibration_data_.empty()) {
        throw std::runtime_error("No calibration data available");
    }

    int num_params = calibration_map_->getNumParameters();

    // Initialize parameters
    Eigen::VectorXd theta = Eigen::VectorXd::Zero(num_params);
    if (num_params >= 2) {
        theta(0) = 1000.0;  // offset
        theta(1) = 1000.0;  // linear coefficient
    }

    Eigen::MatrixXd covariance = 1000.0 * Eigen::MatrixXd::Identity(num_params, num_params);

    // Iterative robust TLS
    for (int iter = 0; iter < max_iterations; ++iter) {
        Eigen::VectorXd prev_theta = theta;

        // Build design matrix and residual vector
        Eigen::MatrixXd design_matrix(calibration_data_.size(), num_params);
        Eigen::VectorXd residuals(calibration_data_.size());
        Eigen::VectorXd weights(calibration_data_.size());

        for (size_t i = 0; i < calibration_data_.size(); ++i) {
            const auto& data_point = calibration_data_[i];

            // Compute Jacobian
            design_matrix.row(i) =
                calibration_map_->jacobian(data_point.voltage, data_point.environment, theta);

            // Compute residual
            double prediction =
                calibration_map_->evaluate(data_point.voltage, data_point.environment, theta);
            residuals(i) = data_point.reference_pressure - prediction;

            // Compute weight based on total variance
            weights(i) = 1.0 / computeTotalVariance(data_point);
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

        // Update covariance estimate
        covariance = reg_matrix.inverse();

        // Check convergence
        double parameter_change = (theta - prev_theta).norm();
        if (parameter_change < convergence_tolerance) {
            break;
        }
    }

    // Create result
    CalibrationParameters result;
    result.theta = theta;
    result.covariance = covariance;
    result.basis_functions = calibration_map_->getParameterNames();
    result.calibration_quality = computeQualityMetrics().nrmse;

    current_calibration_ = result;
    return result;
}

void PTCalibrationFramework::updateCalibrationRLS(double forgetting_factor,
                                                  const CalibrationDataPoint& new_data_point) {
    if (!rls_initialized_) {
        // Initialize RLS
        int num_params = calibration_map_->getNumParameters();
        rls_theta_ = Eigen::VectorXd::Zero(num_params);
        if (num_params >= 2) {
            rls_theta_(0) = 1000.0;
            rls_theta_(1) = 1000.0;
        }
        rls_covariance_ = 1000.0 * Eigen::MatrixXd::Identity(num_params, num_params);
        rls_initialized_ = true;
    }

    // Compute prediction and Jacobian
    double prediction =
        calibration_map_->evaluate(new_data_point.voltage, new_data_point.environment, rls_theta_);
    Eigen::VectorXd jacobian =
        calibration_map_->jacobian(new_data_point.voltage, new_data_point.environment, rls_theta_);

    // Compute total variance
    double total_variance = computeTotalVariance(new_data_point);

    // RLS update with forgetting factor
    Eigen::VectorXd innovation_variance_vector = jacobian.transpose() * rls_covariance_ * jacobian;
    double innovation_variance = innovation_variance_vector(0) + total_variance;

    if (innovation_variance > 1e-12) {
        Eigen::VectorXd kalman_gain = rls_covariance_ * jacobian / innovation_variance;
        double innovation = new_data_point.reference_pressure - prediction;

        rls_theta_ += kalman_gain * innovation;
        rls_covariance_ = (rls_covariance_ - kalman_gain * jacobian.transpose() * rls_covariance_) /
                          forgetting_factor;
    }

    // Update current calibration
    current_calibration_.theta = rls_theta_;
    current_calibration_.covariance = rls_covariance_;
}

std::pair<double, double> PTCalibrationFramework::predictPressure(
    double voltage, const EnvironmentalState& environment) const {
    if (!current_calibration_.isValid()) {
        throw std::runtime_error("No valid calibration available");
    }

    // Compute prediction
    double prediction =
        calibration_map_->evaluate(voltage, environment, current_calibration_.theta);

    // Compute uncertainty
    Eigen::VectorXd jacobian =
        calibration_map_->jacobian(voltage, environment, current_calibration_.theta);
    double parameter_uncertainty =
        jacobian.transpose() * current_calibration_.covariance * jacobian;

    // Add environmental uncertainty
    Eigen::VectorXd env_jacobian =
        calibration_map_->environmentalJacobian(voltage, environment, current_calibration_.theta);
    double env_uncertainty =
        env_jacobian.transpose() * variance_model_.env_variance_matrix * env_jacobian;

    // Add extrapolation uncertainty
    double extrapolation_uncertainty = computeExtrapolationUncertainty(voltage, environment);

    double total_variance = parameter_uncertainty + env_uncertainty + extrapolation_uncertainty +
                            variance_model_.base_variance;

    return std::make_pair(prediction, total_variance);
}

CalibrationQualityMetrics PTCalibrationFramework::computeQualityMetrics() const {
    CalibrationQualityMetrics metrics;

    if (calibration_data_.empty() || !current_calibration_.isValid()) {
        return metrics;
    }

    // Compute residuals
    std::vector<double> residuals;
    std::vector<double> predictions;
    std::vector<double> uncertainties;

    for (const auto& data_point : calibration_data_) {
        auto prediction_pair = predictPressure(data_point.voltage, data_point.environment);
        predictions.push_back(prediction_pair.first);
        uncertainties.push_back(prediction_pair.second);
        residuals.push_back(data_point.reference_pressure - prediction_pair.first);
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

    // Compute coverage probability
    double coverage_count = 0.0;
    for (size_t i = 0; i < residuals.size(); ++i) {
        double uncertainty_std = std::sqrt(uncertainties[i]);
        if (std::abs(residuals[i]) <= 1.96 * uncertainty_std) {  // 95% confidence
            coverage_count += 1.0;
        }
    }
    metrics.coverage_95 = coverage_count / residuals.size();

    // Compute condition number
    Eigen::JacobiSVD<Eigen::MatrixXd> svd(current_calibration_.covariance);
    metrics.condition_number =
        svd.singularValues()(0) / svd.singularValues()(svd.singularValues().size() - 1);

    // Compute AIC and BIC
    double log_likelihood = 0.0;
    for (size_t i = 0; i < residuals.size(); ++i) {
        double uncertainty_std = std::sqrt(uncertainties[i]);
        log_likelihood += -0.5 * std::log(2.0 * M_PI * uncertainty_std * uncertainty_std) -
                          0.5 * residuals[i] * residuals[i] / (uncertainty_std * uncertainty_std);
    }

    int num_params = current_calibration_.theta.size();
    int num_data = residuals.size();
    metrics.aic = 2 * num_params - 2 * log_likelihood;
    metrics.bic = std::log(num_data) * num_params - 2 * log_likelihood;

    return metrics;
}

void PTCalibrationFramework::clearCalibrationData() {
    calibration_data_.clear();
    rls_initialized_ = false;
}

double PTCalibrationFramework::computeTotalVariance(const CalibrationDataPoint& data_point) const {
    double total_variance =
        data_point.reference_pressure_uncertainty * data_point.reference_pressure_uncertainty;
    total_variance += variance_model_.base_variance;

    // Environmental variance
    Eigen::VectorXd env_vector = data_point.environment.toVector();
    total_variance += env_vector.transpose() * variance_model_.env_variance_matrix * env_vector;
    total_variance += data_point.voltage * data_point.voltage * env_vector.transpose() *
                      variance_model_.interaction_matrix * env_vector;

    // Nonlinear variance terms
    total_variance += variance_model_.nonlinear_variance_alpha1 * std::pow(data_point.voltage, 4);
    total_variance += variance_model_.nonlinear_variance_alpha2 * env_vector.squaredNorm() *
                      data_point.voltage * data_point.voltage;
    total_variance +=
        variance_model_.nonlinear_variance_alpha3 * std::pow(env_vector.squaredNorm(), 2);

    return total_variance;
}

double PTCalibrationFramework::computeExtrapolationUncertainty(
    double voltage, const EnvironmentalState& environment) const {
    // Find voltage range in calibration data
    if (calibration_data_.empty()) {
        return 1000.0;  // Large uncertainty if no data
    }

    double min_voltage = calibration_data_[0].voltage;
    double max_voltage = calibration_data_[0].voltage;

    for (const auto& data_point : calibration_data_) {
        min_voltage = std::min(min_voltage, data_point.voltage);
        max_voltage = std::max(max_voltage, data_point.voltage);
    }

    double voltage_range = max_voltage - min_voltage;
    if (voltage_range <= 0) {
        return 0.0;
    }

    // Compute extrapolation factor
    double extrapolation_factor = 0.0;
    if (voltage < min_voltage) {
        extrapolation_factor = (min_voltage - voltage) / voltage_range;
    } else if (voltage > max_voltage) {
        extrapolation_factor = (voltage - max_voltage) / voltage_range;
    }

    // Extrapolation uncertainty grows quadratically
    return 100.0 * extrapolation_factor * extrapolation_factor;
}

bool PTCalibrationFramework::validateCalibrationData() const {
    if (calibration_data_.empty()) {
        return false;
    }

    for (const auto& data_point : calibration_data_) {
        if (!std::isfinite(data_point.voltage) || !std::isfinite(data_point.reference_pressure)) {
            return false;
        }
        if (data_point.reference_pressure_uncertainty < 0) {
            return false;
        }
    }

    return true;
}

CalibrationParameters PTCalibrationFramework::performSinglePointCalibration(
    double zero_voltage, double zero_pressure, const EnvironmentalState& environment) {
    // ROBUST NUMERICAL STABILITY CHECKS
    if (!std::isfinite(zero_voltage) || !std::isfinite(zero_pressure)) {
        throw std::invalid_argument("Zero voltage and pressure must be finite");
    }

    // Clamp voltage to safe range
    const double MIN_VOLTAGE = 1e-6;
    const double MAX_VOLTAGE = 10.0;
    zero_voltage = std::clamp(zero_voltage, MIN_VOLTAGE, MAX_VOLTAGE);

    int num_params = calibration_map_->getNumParameters();

    // SINGLE-POINT CALIBRATION: Assume linear relationship
    // For a 6-parameter model: p = θ₀ + θ₁v + θ₂v² + θ₃v³ + θ₄√v + θ₅ln(1+v)
    // With only one point, we can only solve for θ₀ and θ₁ (linear terms)
    // Set higher-order terms to zero with high uncertainty

    CalibrationParameters result;
    result.theta = Eigen::VectorXd::Zero(num_params);
    result.covariance = Eigen::MatrixXd::Identity(num_params, num_params);

    // Set linear relationship: p = θ₀ + θ₁v
    // At zero voltage: p = θ₀, so θ₀ = zero_pressure
    // We need to estimate θ₁, but with only one point, we use a reasonable default

    result.theta(0) = zero_pressure;  // offset
    result.theta(1) = 1000.0;         // Default linear coefficient (Pa/V) - reasonable for most PTs

    // Set high uncertainty for parameters we can't determine
    double base_uncertainty = 1000.0;  // 1000 Pa uncertainty
    for (int i = 0; i < num_params; ++i) {
        result.covariance(i, i) = base_uncertainty * base_uncertainty;
    }

    // Lower uncertainty for offset (we know this exactly)
    result.covariance(0, 0) = 10.0 * 10.0;  // 10 Pa uncertainty

    // Higher uncertainty for higher-order terms (we assume they're zero)
    for (int i = 2; i < num_params; ++i) {
        result.covariance(i, i) = 10000.0 * 10000.0;  // Very high uncertainty
    }

    // Set calibration quality metric
    result.calibration_quality = 0.5;  // Medium quality for single-point calibration

    // Set basis function names
    result.basis_functions = calibration_map_->getParameterNames();

    // Validate result
    if (!calibration_map_->validateParameters(result.theta)) {
        throw std::runtime_error("Single-point calibration produced invalid parameters");
    }

    return result;
}

// Factory function
std::shared_ptr<CalibrationMapFunction> createCalibrationMap(const std::string& map_type) {
    if (map_type == "polynomial") {
        return std::make_shared<PolynomialCalibrationMap>();
    } else if (map_type == "environmental_robust") {
        return std::make_shared<EnvironmentalRobustCalibrationMap>();
    } else {
        throw std::invalid_argument("Unknown calibration map type: " + map_type);
    }
}

// Utility function
CalibrationDataPoint convertPTMessageToCalibrationData(const PTMessage& pt_message,
                                                       double reference_pressure,
                                                       double reference_uncertainty,
                                                       const EnvironmentalState& environment) {
    CalibrationDataPoint data_point;
    data_point.voltage = pt_message.getField<2>();  // raw_voltage_v
    data_point.reference_pressure = reference_pressure;
    data_point.reference_pressure_uncertainty = reference_uncertainty;
    data_point.environment = environment;
    data_point.timestamp_ns = pt_message.getField<0>();  // timestamp_ns
    data_point.sensor_id = pt_message.getField<1>();     // sensor_id
    data_point.pt_location = pt_message.getField<3>();   // pt_location

    return data_point;
}
