#ifndef OPTIMAL_CONTROLLER_HPP
#define OPTIMAL_CONTROLLER_HPP

#include <Eigen/Dense>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <vector>

/**
 * @brief Optimal Control System
 *
 * Implements optimal control algorithms for engine control including
 * Model Predictive Control (MPC), LQR, and adaptive control with
 * gain scheduling integration.
 */
class OptimalController {
public:
    enum class ControlAlgorithm {
        PID_CONTROL,
        LQR_CONTROL,
        MODEL_PREDICTIVE_CONTROL,
        ADAPTIVE_CONTROL,
        ROBUST_CONTROL,
        FUZZY_CONTROL
    };

    enum class ControlObjective {
        MINIMIZE_TRACKING_ERROR,
        MINIMIZE_CONTROL_EFFORT,
        MINIMIZE_FUEL_CONSUMPTION,
        MAXIMIZE_THRUST_EFFICIENCY,
        MINIMIZE_VIBRATION,
        MIXED_OBJECTIVE
    };

    struct ControlState {
        // Engine states
        double thrust;            // Current thrust (N)
        double chamber_pressure;  // Chamber pressure (Pa)
        double fuel_flow_rate;    // Fuel flow rate (kg/s)
        double ox_flow_rate;      // Oxidizer flow rate (kg/s)
        double mixture_ratio;     // O/F ratio
        double specific_impulse;  // Isp (s)

        // Valve positions
        double fuel_valve_position;  // Fuel valve position (0-1)
        double ox_valve_position;    // Ox valve position (0-1)

        // Environmental conditions
        double temperature;       // Temperature (K)
        double pressure_ambient;  // Ambient pressure (Pa)
        double humidity;          // Humidity (%)

        // Performance metrics
        double efficiency;       // Overall efficiency
        double vibration_level;  // Vibration level
        double noise_level;      // Acoustic noise level

        std::chrono::steady_clock::time_point timestamp;
    };

    struct ControlInput {
        double thrust_demand;            // Thrust demand (N)
        double mixture_ratio_demand;     // Mixture ratio demand
        double chamber_pressure_demand;  // Chamber pressure demand (Pa)
        double efficiency_target;        // Efficiency target
        double vibration_limit;          // Vibration limit
        double noise_limit;              // Noise limit

        std::chrono::steady_clock::time_point timestamp;
    };

    struct ControlOutput {
        double fuel_valve_command;     // Fuel valve command (0-1)
        double ox_valve_command;       // Ox valve command (0-1)
        double valve_rate_limits;      // Rate limits (1/s)
        bool emergency_close;          // Emergency close flag
        double control_confidence;     // Control confidence (0-1)
        double predicted_performance;  // Predicted performance

        std::chrono::steady_clock::time_point timestamp;
    };

    struct MPCConfig {
        size_t prediction_horizon;           // Prediction horizon steps
        size_t control_horizon;              // Control horizon steps
        double sampling_time;                // Sampling time (s)
        std::vector<double> state_weights;   // State weighting matrix
        std::vector<double> input_weights;   // Input weighting matrix
        std::vector<double> output_weights;  // Output weighting matrix
        bool enable_constraints;             // Enable constraints
        std::vector<double> input_limits;    // Input constraints
        std::vector<double> state_limits;    // State constraints
        double optimization_tolerance;       // Optimization tolerance
        size_t max_iterations;               // Max optimization iterations
    };

    struct LQRConfig {
        Eigen::MatrixXd Q;            // State weighting matrix
        Eigen::MatrixXd R;            // Input weighting matrix
        Eigen::MatrixXd N;            // Cross-coupling matrix
        bool enable_integral_action;  // Enable integral action
        double integral_weight;       // Integral weight
        bool enable_anti_windup;      // Enable anti-windup
    };

    OptimalController();
    ~OptimalController();

    // Main interface
    bool initialize(ControlAlgorithm algorithm, const ControlState& initial_state);
    void run();
    void stop();

    // Control computation
    ControlOutput computeControl(const ControlState& current_state,
                                 const ControlInput& control_input);

    // Algorithm-specific configuration
    bool configureMPC(const MPCConfig& config);
    bool configureLQR(const LQRConfig& config);

    // Model management
    bool updateModel(const Eigen::MatrixXd& A, const Eigen::MatrixXd& B, const Eigen::MatrixXd& C,
                     const Eigen::MatrixXd& D);

    bool updateModelParameters(const std::vector<double>& parameters);

    // Gain scheduling integration
    bool setGainSchedule(const std::map<double, std::vector<double>>& gain_schedule);
    bool updateGains(double scheduling_variable);

    // Performance monitoring
    double getControlPerformance() const;
    double getTrackingError() const;
    double getControlEffort() const;
    bool isControlStable() const;

    // Configuration
    ControlAlgorithm getAlgorithm() const;
    bool setObjective(ControlObjective objective);
    ControlObjective getObjective() const;

private:
    void controlLoop();
    void updateModel();
    void computeOptimalControl();

    // MPC implementation
    ControlOutput computeMPCControl(const ControlState& state, const ControlInput& input);
    Eigen::VectorXd solveMPCOptimization(const Eigen::VectorXd& current_state,
                                         const Eigen::VectorXd& reference_trajectory);
    bool setupMPCConstraints();

    // LQR implementation
    ControlOutput computeLQRControl(const ControlState& state, const ControlInput& input);
    Eigen::MatrixXd computeLQRGain();
    Eigen::VectorXd computeIntegralAction(const ControlState& state, const ControlInput& input);

    // PID implementation
    ControlOutput computePIDControl(const ControlState& state, const ControlInput& input);

    // Adaptive control implementation
    ControlOutput computeAdaptiveControl(const ControlState& state, const ControlInput& input);
    void updateAdaptiveParameters(const ControlState& state, const ControlInput& input);

    // Robust control implementation
    ControlOutput computeRobustControl(const ControlState& state, const ControlInput& input);
    Eigen::MatrixXd computeRobustGain();

    // Model and system matrices
    Eigen::MatrixXd A_, B_, C_, D_;  // State-space matrices
    Eigen::VectorXd x_;              // State vector
    Eigen::VectorXd u_;              // Input vector
    Eigen::VectorXd y_;              // Output vector

    // MPC specific
    MPCConfig mpc_config_;
    Eigen::MatrixXd mpc_constraints_;
    std::unique_ptr<class MPCSolver> mpc_solver_;

    // LQR specific
    LQRConfig lqr_config_;
    Eigen::MatrixXd K_;               // LQR gain matrix
    Eigen::VectorXd integral_error_;  // Integral error

    // Control algorithm
    ControlAlgorithm algorithm_;
    ControlObjective objective_;

    // Gain scheduling
    std::map<double, std::vector<double>> gain_schedule_;
    std::vector<double> current_gains_;

    // Performance metrics
    std::atomic<double> control_performance_;
    std::atomic<double> tracking_error_;
    std::atomic<double> control_effort_;
    std::atomic<bool> control_stable_;

    // State variables
    std::atomic<bool> running_;
    ControlState current_state_;
    ControlInput current_input_;
    ControlOutput current_output_;

    // Threading
    std::thread control_thread_;
    std::mutex state_mutex_;
    std::mutex config_mutex_;

    // Timing
    std::chrono::milliseconds control_period_{10};  // 100 Hz control loop
};

/**
 * @brief Model Predictive Control Solver
 *
 * Solves the MPC optimization problem using quadratic programming
 */
class MPCSolver {
public:
    struct OptimizationResult {
        Eigen::VectorXd optimal_sequence;
        double objective_value;
        bool converged;
        size_t iterations;
        std::string solver_status;
    };

    MPCSolver();
    ~MPCSolver();

    bool initialize(const OptimalController::MPCConfig& config);
    OptimizationResult solve(const Eigen::VectorXd& current_state,
                             const Eigen::VectorXd& reference_trajectory, const Eigen::MatrixXd& A,
                             const Eigen::MatrixXd& B);

private:
    void setupQuadraticProgram();
    bool solveQuadraticProgram(const Eigen::MatrixXd& H, const Eigen::VectorXd& f,
                               const Eigen::MatrixXd& A_ineq, const Eigen::VectorXd& b_ineq,
                               const Eigen::MatrixXd& A_eq, const Eigen::VectorXd& b_eq,
                               Eigen::VectorXd& solution);

    OptimalController::MPCConfig config_;
    Eigen::MatrixXd Q_bar_, R_bar_, S_bar_;  // Augmented weighting matrices
    Eigen::MatrixXd A_bar_, B_bar_;          // Augmented system matrices
    Eigen::MatrixXd G_, g_;                  // Constraint matrices
};

/**
 * @brief Engine Model
 *
 * Mathematical model of the liquid rocket engine for control design
 */
class EngineModel {
public:
    struct ModelParameters {
        // Engine geometry
        double chamber_volume;         // Chamber volume (m³)
        double throat_area;            // Throat area (m²)
        double exit_area;              // Exit area (m²)
        double characteristic_length;  // L* (m)

        // Propellant properties
        double fuel_density;      // Fuel density (kg/m³)
        double ox_density;        // Oxidizer density (kg/m³)
        double fuel_cp;           // Fuel specific heat (J/kg·K)
        double ox_cp;             // Oxidizer specific heat (J/kg·K)
        double gamma;             // Specific heat ratio
        double molecular_weight;  // Molecular weight (kg/mol)

        // Valve characteristics
        double fuel_valve_cv;        // Fuel valve flow coefficient
        double ox_valve_cv;          // Ox valve flow coefficient
        double valve_response_time;  // Valve response time (s)

        // Heat transfer
        double heat_transfer_coefficient;  // Heat transfer coefficient
        double wall_temperature;           // Wall temperature (K)

        // Efficiency parameters
        double combustion_efficiency;  // Combustion efficiency
        double nozzle_efficiency;      // Nozzle efficiency
        double pump_efficiency;        // Pump efficiency
    };

    EngineModel();
    ~EngineModel();

    bool initialize(const ModelParameters& parameters);
    bool updateParameters(const ModelParameters& parameters);

    // Model evaluation
    Eigen::VectorXd computeStateDerivative(const Eigen::VectorXd& state,
                                           const Eigen::VectorXd& input, double time) const;

    Eigen::VectorXd computeOutput(const Eigen::VectorXd& state, const Eigen::VectorXd& input) const;

    // Linearization
    bool linearize(const Eigen::VectorXd& operating_point, const Eigen::VectorXd& input_point,
                   Eigen::MatrixXd& A, Eigen::MatrixXd& B, Eigen::MatrixXd& C, Eigen::MatrixXd& D);

    // Model validation
    double validateModel(const std::vector<Eigen::VectorXd>& states,
                         const std::vector<Eigen::VectorXd>& inputs,
                         const std::vector<Eigen::VectorXd>& outputs) const;

private:
    // Engine dynamics
    double computeChamberPressure(const Eigen::VectorXd& state, const Eigen::VectorXd& input) const;
    double computeThrust(const Eigen::VectorXd& state) const;
    double computeSpecificImpulse(const Eigen::VectorXd& state) const;
    double computeCombustionTemperature(const Eigen::VectorXd& state) const;

    // Flow calculations
    double computeFuelFlowRate(double valve_position, double pressure) const;
    double computeOxFlowRate(double valve_position, double pressure) const;
    double computeMassFlowRate(double pressure, double temperature, double valve_position,
                               double cv) const;

    // Thermodynamic calculations
    double computeSoundSpeed(double temperature) const;
    double computeCriticalPressure(double temperature) const;
    double computeMachNumber(double pressure_ratio) const;

    ModelParameters parameters_;
    bool initialized_;
};

#endif  // OPTIMAL_CONTROLLER_HPP
