#ifndef ENVIRONMENTAL_ROBUST_CALIBRATION_HPP
#define ENVIRONMENTAL_ROBUST_CALIBRATION_HPP

#include <Eigen/Core>
#include <Eigen/Dense>
#include <chrono>
#include <deque>
#include <memory>
#include <vector>

#include "PTCalibrationFramework.hpp"

/**
 * @brief Implementation of Algorithm 1: Environmental-Robust Bayesian Calibration with Adaptive TLS
 *
 * This implements the exact algorithm from the LaTeX paper for offline calibration
 * with human-in-the-loop confidence building.
 */
class EnvironmentalRobustCalibration {
public:
    /**
     * @brief Constructor
     * @param calibration_map Calibration map function
     */
    EnvironmentalRobustCalibration(std::shared_ptr<CalibrationMapFunction> calibration_map);

    /**
     * @brief Destructor
     */
    ~EnvironmentalRobustCalibration();

    /**
     * @brief Algorithm 1: Environmental-Robust Bayesian Calibration with Adaptive TLS
     *
     * Inputs:
     * @param calibration_data Set of N observations {(v_i, p_obs,i, e_i)}_{i=1}^N
     * @param environmental_uncertainties Set {σ_env,i}
     * @param population_prior_mean μ_pop
     * @param population_prior_covariance Σ_pop
     * @param max_iterations Maximum number of iterations
     * @param convergence_tolerance Convergence tolerance ε
     *
     * Outputs:
     * @return CalibrationParameters with θ̂, Σ_θ̂, Q_env̂, Q_interaction̂, calibration quality metrics
     */
    CalibrationParameters performEnvironmentalRobustCalibration(
        const std::vector<CalibrationDataPoint>& calibration_data,
        const std::vector<double>& environmental_uncertainties,
        const Eigen::VectorXd& population_prior_mean,
        const Eigen::MatrixXd& population_prior_covariance, int max_iterations = 100,
        double convergence_tolerance = 1e-6);

    /**
     * @brief Add calibration data point (human-in-the-loop)
     * @param voltage v_i
     * @param reference_pressure p_obs,i
     * @param environmental_state e_i
     * @param environmental_uncertainty σ_env,i
     */
    void addCalibrationDataPoint(double voltage, double reference_pressure,
                                 const EnvironmentalState& environmental_state,
                                 double environmental_uncertainty);

    /**
     * @brief Get current calibration confidence
     * @return Confidence level based on Algorithm 1 convergence and quality metrics
     */
    double getCalibrationConfidence() const;

    /**
     * @brief Check if calibration is ready for Algorithm 2 deployment
     * @return true if ready for online EKF deployment
     */
    bool isReadyForDeployment() const;

    /**
     * @brief Get environmental variance model parameters
     * @return Environmental variance model
     */
    EnvironmentalVarianceModel getEnvironmentalVarianceModel() const;

private:
    std::shared_ptr<CalibrationMapFunction> calibration_map_;
    std::vector<CalibrationDataPoint> calibration_data_;
    std::vector<double> environmental_uncertainties_;
    CalibrationParameters current_calibration_;
    EnvironmentalVarianceModel variance_model_;
    double calibration_confidence_;

    /**
     * @brief Step 1: Update environmental variance model
     * @param k Current iteration
     * @return Updated total variance for each observation
     */
    std::vector<double> updateEnvironmentalVarianceModel(int k);

    /**
     * @brief Step 2: Solve robust TLS with environmental calibration map
     * @param total_variances σ_total,i^2 for each observation
     * @param k Current iteration
     * @return Updated calibration parameters θ^(k)
     */
    Eigen::VectorXd solveRobustTLS(const std::vector<double>& total_variances, int k);

    /**
     * @brief Step 3: Update calibration parameter posterior
     * @param theta_k Updated parameters from Step 2
     * @param total_variances σ_total,i^2 for each observation
     * @param k Current iteration
     * @return Updated posterior parameters and covariance
     */
    std::pair<Eigen::VectorXd, Eigen::MatrixXd> updateCalibrationParameterPosterior(
        const Eigen::VectorXd& theta_k, const std::vector<double>& total_variances, int k);

    /**
     * @brief Step 4: Update environmental variance parameters
     * @param theta_k Current parameters
     * @param k Current iteration
     */
    void updateEnvironmentalVarianceParameters(const Eigen::VectorXd& theta_k, int k);

    /**
     * @brief Step 5: Validate calibration robustness
     * @param theta_final Final parameters
     * @param covariance_final Final covariance
     * @return Calibration quality metrics
     */
    CalibrationQualityMetrics validateCalibrationRobustness(
        const Eigen::VectorXd& theta_final, const Eigen::MatrixXd& covariance_final);

    /**
     * @brief Compute total variance for observation i
     * @param i Observation index
     * @param k Current iteration
     * @return Total variance σ_total,i^2
     */
    double computeTotalVariance(int i, int k);

    /**
     * @brief Compute environmental variance term
     * @param env_vector Environmental state vector e_i
     * @param voltage v_i
     * @param k Current iteration
     * @return Environmental variance contribution
     */
    double computeEnvironmentalVariance(const Eigen::VectorXd& env_vector, double voltage, int k);

    /**
     * @brief Compute nonlinear variance terms
     * @param voltage v_i
     * @param env_vector Environmental state vector e_i
     * @return Nonlinear variance contribution
     */
    double computeNonlinearVariance(double voltage, const Eigen::VectorXd& env_vector);
};

/**
 * @brief Implementation of Algorithm 2: Online Environmental-Adaptive EKF with Change Detection
 *
 * This implements the exact algorithm from the LaTeX paper for online deployment
 * with environmental adaptation and change detection.
 */
class EnvironmentalAdaptiveEKF {
public:
    /**
     * @brief Constructor
     * @param calibration_parameters θ̂, Σ_θ̂ from Algorithm 1
     * @param environmental_variance_model Q_env̂, Q_interaction̂ from Algorithm 1
     * @param initial_environmental_state ê_0, Σ_e,0
     * @param num_physical_states Number of physical states to track
     */
    EnvironmentalAdaptiveEKF(const CalibrationParameters& calibration_parameters,
                             const EnvironmentalVarianceModel& environmental_variance_model,
                             const EnvironmentalState& initial_environmental_state,
                             const Eigen::MatrixXd& initial_environmental_covariance,
                             std::shared_ptr<CalibrationMapFunction> calibration_map,
                             int num_physical_states = 3);

    /**
     * @brief Destructor
     */
    ~EnvironmentalAdaptiveEKF();

    /**
     * @brief Algorithm 2: Online Environmental-Adaptive EKF with Change Detection
     *
     * Process each measurement (v_k, p_obs,k, e_sensor,k):
     * @param voltage v_k
     * @param observed_pressure p_obs,k
     * @param sensor_environmental_state e_sensor,k
     * @return Pair of (predicted_pressure, uncertainty_variance)
     */
    std::pair<double, double> processMeasurement(
        double voltage, double observed_pressure,
        const EnvironmentalState& sensor_environmental_state);

    /**
     * @brief Get current EKF state
     * @return State vector [x_phys, θ, e, b_residual]ᵀ
     */
    const Eigen::VectorXd& getStateEstimate() const {
        return x_k_;
    }

    /**
     * @brief Get current EKF covariance
     * @return State covariance matrix
     */
    const Eigen::MatrixXd& getStateCovariance() const {
        return P_k_;
    }

    /**
     * @brief Get current calibration parameters
     * @return Current calibration parameters θ_k|k
     */
    Eigen::VectorXd getCurrentCalibrationParameters() const;

    /**
     * @brief Get current environmental state
     * @return Current environmental state ê_k|k
     */
    EnvironmentalState getCurrentEnvironmentalState() const;

    /**
     * @brief Check if change detection triggered
     * @return true if GLR test detected change
     */
    bool isChangeDetected() const {
        return change_detected_;
    }

    /**
     * @brief Get change detection statistic
     * @return Current GLR statistic Λ_k
     */
    double getChangeDetectionStatistic() const {
        return lambda_k_;
    }

private:
    // Algorithm 2 state variables
    Eigen::VectorXd x_k_;  // State vector [x_phys, θ, e, b_residual]ᵀ
    Eigen::MatrixXd P_k_;  // State covariance matrix

    // Calibration parameters from Algorithm 1
    CalibrationParameters initial_calibration_;
    EnvironmentalVarianceModel variance_model_;
    std::shared_ptr<CalibrationMapFunction> calibration_map_;

    // Environmental state
    EnvironmentalState initial_environment_;
    Eigen::MatrixXd initial_environmental_covariance_;

    // Process and measurement models
    Eigen::MatrixXd F_;      // State transition matrix
    Eigen::MatrixXd F_env_;  // Environmental state transition matrix
    double rho_;             // Residual bias correlation coefficient

    // Change detection
    bool change_detected_;
    double lambda_k_;                // GLR statistic
    std::deque<double> glr_window_;  // Sliding window for GLR test
    double gamma_threshold_;         // GLR threshold

    // State indices
    int num_physical_states_;
    int num_calibration_params_;
    int physical_start_idx_;
    int calibration_start_idx_;
    int environment_start_idx_;
    int bias_idx_;

    /**
     * @brief Environmental State Update (Lines 7-9)
     * @param k Current time step
     */
    void updateEnvironmentalState(int k);

    /**
     * @brief Prediction Step (Lines 10-13)
     * @param k Current time step
     */
    void predictionStep(int k);

    /**
     * @brief Adaptive Variance Computation (Lines 14-17)
     * @param voltage v_k
     * @param k Current time step
     * @return Total variance σ²_total,k
     */
    double computeAdaptiveVariance(double voltage, int k);

    /**
     * @brief GLR Test (Lines 18-23)
     * @param voltage v_k
     * @param observed_pressure p_obs,k
     * @param k Current time step
     * @return GLR statistic Λ_k
     */
    double performGLRTest(double voltage, double observed_pressure, int k);

    /**
     * @brief Update Step (Lines 24-29)
     * @param voltage v_k
     * @param observed_pressure p_obs,k
     * @param k Current time step
     * @return Updated state and covariance
     */
    std::pair<Eigen::VectorXd, Eigen::MatrixXd> updateStep(double voltage, double observed_pressure,
                                                           int k);

    /**
     * @brief Compute measurement model Jacobian
     * @param voltage v_k
     * @param k Current time step
     * @return Jacobian matrix H_k
     */
    Eigen::VectorXd computeMeasurementJacobian(double voltage, int k);

    /**
     * @brief Compute measurement model
     * @param voltage v_k
     * @param k Current time step
     * @return Predicted measurement h(x_k|k-1, v_k)
     */
    double computeMeasurementModel(double voltage, int k);

    /**
     * @brief Compute process noise covariance (environment-dependent)
     * @param k Current time step
     * @return Process noise covariance Q_k
     */
    Eigen::MatrixXd computeProcessNoiseCovariance(int k);
};

/**
 * @brief Human-in-the-Loop Calibration System implementing the paper's methodology
 *
 * This system implements the exact workflow from the LaTeX paper:
 * 1. Algorithm 1: Offline Environmental-Robust Bayesian Calibration (human-in-the-loop)
 * 2. Algorithm 2: Online Environmental-Adaptive EKF (deployment with confidence)
 */
class HumanInTheLoopCalibrationSystem {
public:
    /**
     * @brief Constructor
     * @param calibration_map Calibration map function
     */
    HumanInTheLoopCalibrationSystem(std::shared_ptr<CalibrationMapFunction> calibration_map);

    /**
     * @brief Destructor
     */
    ~HumanInTheLoopCalibrationSystem();

    /**
     * @brief Phase 1: Human-in-the-Loop Training (Algorithm 1)
     * @param voltage Current voltage measurement
     * @param environmental_state Environmental conditions
     * @return Pair of (needs_human_input, predicted_pressure)
     */
    std::pair<bool, double> processTrainingMeasurement(
        double voltage, const EnvironmentalState& environmental_state);

    /**
     * @brief Provide human input during training phase
     * @param voltage Voltage measurement
     * @param reference_pressure Human-provided reference pressure
     * @param environmental_state Environmental conditions
     */
    void provideHumanInput(double voltage, double reference_pressure,
                           const EnvironmentalState& environmental_state);

    /**
     * @brief Complete Algorithm 1 and transition to Algorithm 2
     * @param population_prior_mean Population prior mean μ_pop
     * @param population_prior_covariance Population prior covariance Σ_pop
     * @return true if successful transition to deployment phase
     */
    bool completeTrainingPhase(const Eigen::VectorXd& population_prior_mean,
                               const Eigen::MatrixXd& population_prior_covariance);

    /**
     * @brief Phase 2: Online Deployment (Algorithm 2)
     * @param voltage Current voltage measurement
     * @param environmental_state Environmental conditions
     * @return Pair of (predicted_pressure, uncertainty_variance)
     */
    std::pair<double, double> processDeploymentMeasurement(
        double voltage, const EnvironmentalState& environmental_state);

    /**
     * @brief Get current system phase
     * @return true if in deployment phase (Algorithm 2), false if in training phase (Algorithm 1)
     */
    bool isInDeploymentPhase() const {
        return deployment_phase_;
    }

    /**
     * @brief Get calibration confidence from Algorithm 1
     * @return Confidence level (0.0 to 1.0)
     */
    double getTrainingConfidence() const;

    /**
     * @brief Get change detection status from Algorithm 2
     * @return true if change detected, false otherwise
     */
    bool isChangeDetected() const;

    /**
     * @brief Get system statistics
     * @return Map of system statistics
     */
    std::map<std::string, double> getSystemStatistics() const;

private:
    std::shared_ptr<CalibrationMapFunction> calibration_map_;
    std::shared_ptr<EnvironmentalRobustCalibration> algorithm1_;
    std::shared_ptr<EnvironmentalAdaptiveEKF> algorithm2_;

    bool deployment_phase_;
    int training_data_points_;
    double training_confidence_;

    /**
     * @brief Initialize Algorithm 1 with training data
     */
    void initializeAlgorithm1();

    /**
     * @brief Initialize Algorithm 2 with Algorithm 1 results
     * @param calibration_params Calibration parameters from Algorithm 1
     * @param variance_model Environmental variance model from Algorithm 1
     */
    void initializeAlgorithm2(const CalibrationParameters& calibration_params,
                              const EnvironmentalVarianceModel& variance_model);
};

#endif  // ENVIRONMENTAL_ROBUST_CALIBRATION_HPP
