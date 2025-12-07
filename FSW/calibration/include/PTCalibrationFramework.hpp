#ifndef PT_CALIBRATION_FRAMEWORK_HPP
#define PT_CALIBRATION_FRAMEWORK_HPP

#include <vector>
#include <memory>
#include <map>
#include <Eigen/Core>
#include <Eigen/Dense>
#include <functional>
#include <chrono>

#include "PTMessage.hpp"

/**
 * @brief Environmental state vector for adaptive calibration
 */
struct EnvironmentalState {
    double temperature;        // Temperature in °C
    double humidity;          // Humidity in %
    double vibration_level;   // Vibration level (normalized)
    double aging_factor;      // Time-dependent aging factor
    double mounting_torque;   // Mounting torque factor
    
    EnvironmentalState() : temperature(25.0), humidity(50.0), 
                          vibration_level(0.0), aging_factor(0.0), 
                          mounting_torque(1.0) {}
    
    Eigen::VectorXd toVector() const {
        Eigen::VectorXd e(5);
        e << temperature, humidity, vibration_level, aging_factor, mounting_torque;
        return e;
    }
    
    void fromVector(const Eigen::VectorXd& e) {
        if (e.size() >= 5) {
            temperature = e(0);
            humidity = e(1);
            vibration_level = e(2);
            aging_factor = e(3);
            mounting_torque = e(4);
        }
    }
};

/**
 * @brief Calibration data point with environmental context
 */
struct CalibrationDataPoint {
    double voltage;                    // Raw voltage reading
    double reference_pressure;         // Reference pressure (Pa)
    double reference_pressure_uncertainty; // Reference uncertainty (Pa)
    EnvironmentalState environment;    // Environmental conditions
    uint64_t timestamp_ns;             // Timestamp
    uint8_t sensor_id;                 // Sensor ID
    uint8_t pt_location;               // PT location
    
    CalibrationDataPoint() : voltage(0.0), reference_pressure(0.0), 
                            reference_pressure_uncertainty(0.0), 
                            timestamp_ns(0), sensor_id(0), pt_location(9) {}
};

/**
 * @brief Calibration parameters with uncertainty
 */
struct CalibrationParameters {
    Eigen::VectorXd theta;             // Calibration coefficients
    Eigen::MatrixXd covariance;        // Parameter covariance matrix
    std::vector<std::string> basis_functions; // Basis function names
    double calibration_quality;        // Overall calibration quality metric
    
    CalibrationParameters() : calibration_quality(0.0) {}
    
    bool isValid() const {
        return theta.size() > 0 && covariance.rows() == theta.size() && 
               covariance.cols() == theta.size();
    }
};

/**
 * @brief Environmental variance model parameters
 */
struct EnvironmentalVarianceModel {
    double base_variance;              // Base measurement variance
    Eigen::MatrixXd env_variance_matrix;      // Q_env matrix
    Eigen::MatrixXd interaction_matrix;       // Q_interaction matrix
    double nonlinear_variance_alpha1;  // v^4 coefficient
    double nonlinear_variance_alpha2;  // ||e||^2 * v^2 coefficient  
    double nonlinear_variance_alpha3;  // ||e||^4 coefficient
    
    EnvironmentalVarianceModel() : base_variance(1.0), 
                                  nonlinear_variance_alpha1(0.0),
                                  nonlinear_variance_alpha2(0.0),
                                  nonlinear_variance_alpha3(0.0) {
        env_variance_matrix = Eigen::MatrixXd::Identity(5, 5);
        interaction_matrix = Eigen::MatrixXd::Identity(5, 5);
    }
};

/**
 * @brief Calibration quality metrics
 */
struct CalibrationQualityMetrics {
    double nrmse;                      // Normalized Root Mean Square Error
    double coverage_95;                // 95% coverage probability
    double extrapolation_confidence;   // Extrapolation confidence
    double condition_number;           // Matrix condition number
    double aic;                        // Akaike Information Criterion
    double bic;                        // Bayesian Information Criterion
    
    CalibrationQualityMetrics() : nrmse(0.0), coverage_95(0.0), 
                                 extrapolation_confidence(0.0),
                                 condition_number(0.0), aic(0.0), bic(0.0) {}
};

/**
 * @brief Abstract base class for calibration map functions
 */
class CalibrationMapFunction {
public:
    virtual ~CalibrationMapFunction() = default;
    
    /**
     * @brief Evaluate calibration function
     * @param voltage Input voltage
     * @param environment Environmental state
     * @param theta Calibration parameters
     * @return Predicted pressure
     */
    virtual double evaluate(double voltage, const EnvironmentalState& environment, 
                           const Eigen::VectorXd& theta) const = 0;
    
    /**
     * @brief Compute Jacobian with respect to parameters
     * @param voltage Input voltage
     * @param environment Environmental state
     * @param theta Calibration parameters
     * @return Jacobian vector
     */
    virtual Eigen::VectorXd jacobian(double voltage, const EnvironmentalState& environment,
                                   const Eigen::VectorXd& theta) const = 0;
    
    /**
     * @brief Compute Jacobian with respect to environmental state
     * @param voltage Input voltage
     * @param environment Environmental state
     * @param theta Calibration parameters
     * @return Environmental Jacobian vector
     */
    virtual Eigen::VectorXd environmentalJacobian(double voltage, const EnvironmentalState& environment,
                                                 const Eigen::VectorXd& theta) const = 0;
    
    /**
     * @brief Get number of parameters
     * @return Number of parameters
     */
    virtual int getNumParameters() const = 0;
    
    /**
     * @brief Get parameter names
     * @return Vector of parameter names
     */
    virtual std::vector<std::string> getParameterNames() const = 0;
    
    /**
     * @brief Validate parameters
     * @param theta Parameter vector
     * @return true if valid, false otherwise
     */
    virtual bool validateParameters(const Eigen::VectorXd& theta) const = 0;
};

/**
 * @brief Physically-informed polynomial calibration map
 */
class PolynomialCalibrationMap : public CalibrationMapFunction {
public:
    PolynomialCalibrationMap();
    virtual ~PolynomialCalibrationMap() = default;
    
    double evaluate(double voltage, const EnvironmentalState& environment, 
                   const Eigen::VectorXd& theta) const override;
    
    Eigen::VectorXd jacobian(double voltage, const EnvironmentalState& environment,
                           const Eigen::VectorXd& theta) const override;
    
    Eigen::VectorXd environmentalJacobian(double voltage, const EnvironmentalState& environment,
                                         const Eigen::VectorXd& theta) const override;
    
    int getNumParameters() const override { return 6; }
    
    std::vector<std::string> getParameterNames() const override {
        return {"offset", "linear", "quadratic", "cubic", "sqrt", "log"};
    }
    
    bool validateParameters(const Eigen::VectorXd& theta) const override;

private:
    double computeBasisFunction(int k, double voltage, const EnvironmentalState& environment) const;
    double computeBasisFunctionDerivative(int k, double voltage, const EnvironmentalState& environment) const;
};

/**
 * @brief Environmental-robust calibration map with adaptive basis functions
 */
class EnvironmentalRobustCalibrationMap : public CalibrationMapFunction {
public:
    EnvironmentalRobustCalibrationMap();
    virtual ~EnvironmentalRobustCalibrationMap() = default;
    
    double evaluate(double voltage, const EnvironmentalState& environment, 
                   const Eigen::VectorXd& theta) const override;
    
    Eigen::VectorXd jacobian(double voltage, const EnvironmentalState& environment,
                           const Eigen::VectorXd& theta) const override;
    
    Eigen::VectorXd environmentalJacobian(double voltage, const EnvironmentalState& environment,
                                         const Eigen::VectorXd& theta) const override;
    
    int getNumParameters() const override { return 6; }
    
    std::vector<std::string> getParameterNames() const override {
        return {"offset", "linear", "quadratic", "cubic", "sqrt", "log"};
    }
    
    bool validateParameters(const Eigen::VectorXd& theta) const override;

private:
    double computeRobustBasisFunction(int k, double voltage, const EnvironmentalState& environment) const;
    double computeRobustBasisFunctionDerivative(int k, double voltage, const EnvironmentalState& environment) const;
};

/**
 * @brief Main PT Calibration Framework
 */
class PTCalibrationFramework {
public:
    /**
     * @brief Constructor
     * @param calibration_map Calibration map function to use
     */
    PTCalibrationFramework(std::shared_ptr<CalibrationMapFunction> calibration_map);
    
    /**
     * @brief Destructor
     */
    ~PTCalibrationFramework();
    
    /**
     * @brief Add calibration data point
     * @param data_point Calibration data point
     */
    void addCalibrationData(const CalibrationDataPoint& data_point);
    
    /**
     * @brief Add multiple calibration data points
     * @param data_points Vector of calibration data points
     */
    void addCalibrationData(const std::vector<CalibrationDataPoint>& data_points);
    
    /**
     * @brief Perform Bayesian calibration with Total Least Squares
     * @param population_prior_mean Population-level parameter prior mean
     * @param population_prior_covariance Population-level parameter prior covariance
     * @param individual_variance Individual transducer variance
     * @return Calibration parameters with uncertainty
     */
    CalibrationParameters performBayesianCalibration(
        const Eigen::VectorXd& population_prior_mean,
        const Eigen::MatrixXd& population_prior_covariance,
        double individual_variance = 1.0);
    
    /**
     * @brief Perform robust Total Least Squares calibration
     * @param max_iterations Maximum number of iterations
     * @param convergence_tolerance Convergence tolerance
     * @return Calibration parameters with uncertainty
     */
    CalibrationParameters performRobustTLS(int max_iterations = 100, 
                                         double convergence_tolerance = 1e-6);
    
    /**
     * @brief Single-point calibration for future use when PTs may be at different pressures
     * Uses only the zero point and assumes linear relationship
     * @param zero_voltage Voltage at zero pressure
     * @param zero_pressure Pressure at zero voltage (usually 0)
     * @param environment Environmental conditions
     * @return Calibration parameters with uncertainty
     */
    CalibrationParameters performSinglePointCalibration(
        double zero_voltage,
        double zero_pressure,
        const EnvironmentalState& environment);
    
    /**
     * @brief Update calibration with new data using Recursive Least Squares
     * @param forgetting_factor Forgetting factor (0 < lambda <= 1)
     * @param new_data_point New calibration data point
     */
    void updateCalibrationRLS(double forgetting_factor, const CalibrationDataPoint& new_data_point);
    
    /**
     * @brief Predict pressure from voltage with uncertainty
     * @param voltage Input voltage
     * @param environment Environmental state
     * @return Pair of (predicted_pressure, uncertainty_variance)
     */
    std::pair<double, double> predictPressure(double voltage, const EnvironmentalState& environment) const;
    
    /**
     * @brief Compute calibration quality metrics
     * @return Calibration quality metrics
     */
    CalibrationQualityMetrics computeQualityMetrics() const;
    
    /**
     * @brief Get current calibration parameters
     * @return Current calibration parameters
     */
    const CalibrationParameters& getCalibrationParameters() const { return current_calibration_; }
    
    /**
     * @brief Get environmental variance model
     * @return Environmental variance model
     */
    const EnvironmentalVarianceModel& getEnvironmentalVarianceModel() const { return variance_model_; }
    
    /**
     * @brief Set environmental variance model
     * @param model Environmental variance model
     */
    void setEnvironmentalVarianceModel(const EnvironmentalVarianceModel& model) { variance_model_ = model; }
    
    /**
     * @brief Clear all calibration data
     */
    void clearCalibrationData();
    
    /**
     * @brief Get number of calibration data points
     * @return Number of data points
     */
    size_t getNumCalibrationPoints() const { return calibration_data_.size(); }
    
    /**
     * @brief Save calibration to file
     * @param filename Output filename
     * @return true if successful, false otherwise
     */
    bool saveCalibration(const std::string& filename) const;
    
    /**
     * @brief Load calibration from file
     * @param filename Input filename
     * @return true if successful, false otherwise
     */
    bool loadCalibration(const std::string& filename);
    
    /**
     * @brief Validate calibration data
     * @return true if data is valid, false otherwise
     */
    bool validateCalibrationData() const;

private:
    std::shared_ptr<CalibrationMapFunction> calibration_map_;
    std::vector<CalibrationDataPoint> calibration_data_;
    CalibrationParameters current_calibration_;
    EnvironmentalVarianceModel variance_model_;
    
    // RLS state
    Eigen::VectorXd rls_theta_;
    Eigen::MatrixXd rls_covariance_;
    bool rls_initialized_;
    
    /**
     * @brief Compute total measurement variance for a data point
     * @param data_point Calibration data point
     * @return Total variance
     */
    double computeTotalVariance(const CalibrationDataPoint& data_point) const;
    
    /**
     * @brief Update environmental variance model from residuals
     * @param residuals Residual vector
     * @param voltages Voltage vector
     * @param environments Environmental states
     */
    void updateEnvironmentalVarianceModel(const Eigen::VectorXd& residuals,
                                        const Eigen::VectorXd& voltages,
                                        const std::vector<EnvironmentalState>& environments);
    
    /**
     * @brief Compute extrapolation uncertainty
     * @param voltage Input voltage
     * @param environment Environmental state
     * @return Extrapolation uncertainty variance
     */
    double computeExtrapolationUncertainty(double voltage, const EnvironmentalState& environment) const;
    
    /**
     * @brief Compute coverage probability
     * @param confidence_level Confidence level (e.g., 0.95 for 95%)
     * @return Coverage probability
     */
    double computeCoverageProbability(double confidence_level = 0.95) const;
};

/**
 * @brief Factory function to create calibration map
 * @param map_type Type of calibration map ("polynomial", "environmental_robust")
 * @return Shared pointer to calibration map
 */
std::shared_ptr<CalibrationMapFunction> createCalibrationMap(const std::string& map_type);

/**
 * @brief Utility function to convert PT message to calibration data point
 * @param pt_message PT message
 * @param reference_pressure Reference pressure (Pa)
 * @param reference_uncertainty Reference uncertainty (Pa)
 * @param environment Environmental state
 * @return Calibration data point
 */
CalibrationDataPoint convertPTMessageToCalibrationData(
    const PTMessage& pt_message,
    double reference_pressure,
    double reference_uncertainty,
    const EnvironmentalState& environment);

#endif  // PT_CALIBRATION_FRAMEWORK_HPP
