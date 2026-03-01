#ifndef GAIN_SCHEDULING_HPP
#define GAIN_SCHEDULING_HPP

#include <Eigen/Dense>
#include <atomic>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

/**
 * @brief Gain Scheduling System
 *
 * Implements adaptive gain scheduling for engine control based on operating conditions,
 * including pressure, thrust, temperature, and other engine parameters
 */
class GainScheduling {
public:
    enum class SchedulingVariable {
        CHAMBER_PRESSURE,  // Primary scheduling variable
        THRUST,            // Thrust-based scheduling
        MIXTURE_RATIO,     // O/F ratio-based scheduling
        TEMPERATURE,       // Temperature-based scheduling
        MACH_NUMBER,       // Flight Mach number
        ALTITUDE,          // Altitude-based scheduling
        VELOCITY,          // Vehicle velocity
        COMBINED           // Multi-variable scheduling
    };

    enum class ControlLoop {
        THRUST_CONTROL,
        PRESSURE_CONTROL,
        MIXTURE_RATIO_CONTROL,
        VALVE_POSITION_CONTROL,
        GIMBAL_CONTROL,
        TEMPERATURE_CONTROL
    };

    struct PIDGains {
        double kp;                               // Proportional gain
        double ki;                               // Integral gain
        double kd;                               // Derivative gain
        double integral_limit;                   // Integral windup limit
        double output_limit;                     // Output saturation limit
        double derivative_filter_time_constant;  // Derivative filter time constant
    };

    struct GainSchedule {
        ControlLoop control_loop;
        SchedulingVariable scheduling_variable;
        std::vector<double> breakpoints;    // Scheduling variable breakpoints
        std::vector<PIDGains> gains;        // Gains at each breakpoint
        std::vector<double> weights;        // Interpolation weights (optional)
        bool enable_interpolation;          // Enable smooth interpolation
        bool enable_derivative_scheduling;  // Schedule derivative gains
        bool enable_integral_scheduling;    // Schedule integral gains
    };

    struct SchedulingConfig {
        std::vector<SchedulingVariable> primary_variables;
        std::vector<SchedulingVariable> secondary_variables;
        double interpolation_threshold;         // Threshold for switching between schedules
        bool enable_adaptive_scheduling;        // Enable adaptive gain adjustment
        bool enable_robust_scheduling;          // Enable robust gain scheduling
        double robustness_factor;               // Robustness factor (0-1)
        std::chrono::milliseconds update_rate;  // Gain update rate
    };

    struct OperatingPoint {
        double chamber_pressure;  // Pa
        double thrust;            // N
        double mixture_ratio;     // O/F ratio
        double temperature;       // K
        double mach_number;       // -
        double altitude;          // m
        double velocity;          // m/s
        std::chrono::steady_clock::time_point timestamp;
    };

    GainScheduling();
    ~GainScheduling();

    // Main interface
    bool initialize(const SchedulingConfig& config);
    void updateOperatingPoint(const OperatingPoint& op_point);

    // Gain scheduling
    PIDGains getGains(ControlLoop control_loop, const OperatingPoint& op_point) const;
    PIDGains getCurrentGains(ControlLoop control_loop) const;

    // Schedule management
    bool addGainSchedule(const GainSchedule& schedule);
    bool removeGainSchedule(ControlLoop control_loop);
    bool updateGainSchedule(ControlLoop control_loop, const GainSchedule& schedule);

    // Configuration
    SchedulingConfig getConfig() const;
    bool updateConfig(const SchedulingConfig& config);

    // Adaptive scheduling
    bool enableAdaptiveScheduling(bool enable);
    bool updateAdaptiveGains(ControlLoop control_loop, const PIDGains& performance_gains);

    // Robust scheduling
    bool enableRobustScheduling(bool enable);
    PIDGains computeRobustGains(ControlLoop control_loop, const OperatingPoint& op_point) const;

    // Analysis and validation
    bool validateGainSchedule(const GainSchedule& schedule) const;
    std::vector<double> getStabilityMargins(ControlLoop control_loop,
                                            const OperatingPoint& op_point) const;
    double getPerformanceIndex(ControlLoop control_loop, const OperatingPoint& op_point) const;

private:
    // Gain interpolation
    PIDGains interpolateGains(const GainSchedule& schedule, double scheduling_value) const;
    PIDGains multiVariableInterpolation(ControlLoop control_loop,
                                        const OperatingPoint& op_point) const;

    // Adaptive gain adjustment
    void updateAdaptiveFactors(ControlLoop control_loop, const PIDGains& performance_gains);
    PIDGains applyAdaptiveFactors(ControlLoop control_loop, const PIDGains& nominal_gains) const;

    // Robust gain computation
    PIDGains computeWorstCaseGains(ControlLoop control_loop, const OperatingPoint& op_point) const;
    PIDGains applyRobustnessFactor(const PIDGains& nominal_gains, double robustness_factor) const;

    // Stability analysis
    std::vector<double> computeStabilityMargins(const PIDGains& gains,
                                                const OperatingPoint& op_point) const;
    double computePerformanceIndex(const PIDGains& gains, const OperatingPoint& op_point) const;

    // Configuration validation
    bool validateBreakpoints(const std::vector<double>& breakpoints) const;
    bool validateGains(const std::vector<PIDGains>& gains) const;

    // Configuration
    SchedulingConfig config_;
    std::map<ControlLoop, GainSchedule> gain_schedules_;

    // Current state
    OperatingPoint current_operating_point_;
    std::map<ControlLoop, PIDGains> current_gains_;
    std::map<ControlLoop, PIDGains> adaptive_factors_;

    // Threading
    std::atomic<bool> adaptive_scheduling_enabled_;
    std::atomic<bool> robust_scheduling_enabled_;
    std::mutex schedules_mutex_;
    std::mutex operating_point_mutex_;

    // Timing
    std::chrono::milliseconds update_period_{100};  // 10 Hz gain update
};

/**
 * @brief Advanced Gain Scheduling with Machine Learning
 *
 * Implements machine learning-based gain scheduling for optimal performance
 */
class MLGainScheduling {
public:
    enum class MLAlgorithm {
        NEURAL_NETWORK,
        SUPPORT_VECTOR_REGRESSION,
        GAUSSIAN_PROCESS,
        RANDOM_FOREST,
        ADAPTIVE_CONTROL
    };

    struct MLConfig {
        MLAlgorithm algorithm;
        std::vector<std::string> input_features;
        std::vector<std::string> output_features;
        size_t training_history_size;
        double learning_rate;
        double regularization_factor;
        bool enable_online_learning;
        std::chrono::milliseconds retraining_period;
    };

    struct TrainingData {
        GainScheduling::OperatingPoint operating_point;
        GainScheduling::PIDGains gains;
        double performance_index;
        std::chrono::steady_clock::time_point timestamp;
    };

    MLGainScheduling();
    ~MLGainScheduling();

    bool initialize(const MLConfig& config);
    void addTrainingData(const TrainingData& data);
    GainScheduling::PIDGains predictGains(const GainScheduling::OperatingPoint& op_point) const;

    bool trainModel();
    bool retrainModel();
    double getModelAccuracy() const;

    MLConfig getConfig() const;
    bool updateConfig(const MLConfig& config);

private:
    void mlLoop();
    void onlineLearning();

    MLConfig config_;
    std::vector<TrainingData> training_data_;
    std::atomic<bool> model_trained_;
    double model_accuracy_;

    std::atomic<bool> running_;
    std::thread ml_thread_;
    std::mutex training_data_mutex_;
    std::mutex model_mutex_;
};

/**
 * @brief Gain Scheduling Optimizer
 *
 * Optimizes gain schedules using numerical optimization techniques
 */
class GainOptimizer {
public:
    enum class OptimizationMethod {
        GENETIC_ALGORITHM,
        PARTICLE_SWARM_OPTIMIZATION,
        SIMULATED_ANNEALING,
        GRADIENT_DESCENT,
        BAYESIAN_OPTIMIZATION
    };

    struct OptimizationConfig {
        OptimizationMethod method;
        size_t population_size;
        size_t max_iterations;
        double convergence_threshold;
        std::vector<double> gain_bounds;  // [kp_min, kp_max, ki_min, ki_max, kd_min, kd_max]
        std::string objective_function;   // "stability", "performance", "robustness"
        bool enable_constraints;
        std::vector<std::string> constraints;
    };

    struct OptimizationResult {
        GainScheduling::PIDGains optimized_gains;
        double objective_value;
        size_t iterations_completed;
        bool converged;
        std::vector<double> optimization_history;
        std::chrono::steady_clock::time_point optimization_time;
    };

    GainOptimizer();
    ~GainOptimizer();

    bool initialize(const OptimizationConfig& config);
    OptimizationResult optimizeGains(GainScheduling::ControlLoop control_loop,
                                     const GainScheduling::OperatingPoint& op_point,
                                     const GainScheduling::PIDGains& initial_gains);

    OptimizationConfig getConfig() const;
    bool updateConfig(const OptimizationConfig& config);

private:
    double evaluateObjective(const GainScheduling::PIDGains& gains,
                             const GainScheduling::OperatingPoint& op_point) const;
    bool checkConstraints(const GainScheduling::PIDGains& gains) const;

    OptimizationConfig config_;
    std::mutex config_mutex_;
};

#endif  // GAIN_SCHEDULING_HPP
