#ifndef ROBUST_DDP_CONTROLLER_HPP
#define ROBUST_DDP_CONTROLLER_HPP

#include <Eigen/Dense>
#include <array>
#include <chrono>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

namespace fsw {
namespace control {

// ────────────────────────────────────────────────────────────────────────
//  Constants  (match Python dynamics.py)
// ────────────────────────────────────────────────────────────────────────
constexpr int N_STATE = 11;   // [P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O,
                              //  V_u_F, V_u_O, m_gas_copv, m_gas_F, m_gas_O]
constexpr int N_CONTROL = 2;  // [u_F, u_O] ∈ [0,1]

// State indices
constexpr int IDX_P_COPV = 0;
constexpr int IDX_P_REG = 1;
constexpr int IDX_P_U_F = 2;
constexpr int IDX_P_U_O = 3;
constexpr int IDX_P_D_F = 4;
constexpr int IDX_P_D_O = 5;
constexpr int IDX_V_U_F = 6;
constexpr int IDX_V_U_O = 7;
constexpr int IDX_M_GAS_COPV = 8;
constexpr int IDX_M_GAS_F = 9;
constexpr int IDX_M_GAS_O = 10;

// Physical constants
constexpr double GAMMA_N2 = 1.4;    // N₂ specific heat ratio
constexpr double R_GAS_N2 = 296.8;  // N₂ gas constant  [J/(kg·K)]
constexpr double G0 = 9.807;        // gravitational accel [m/s²]

/**
 * @brief Robust Hybrid Optimal Controller
 *
 * Implements the full mathematical framework from the paper:
 *   §4  Blowdown ullage dynamics  (ideal-gas law, choked/subsonic flow)
 *   §6  Injector + chamber model  (Cd·A·√(2ρΔP), chamber root-find)
 *   §7  Hard combustion constraints (MR, injector stiffness)
 *   §9  Robust min-max MPC
 *   §10 Enumerative robust MPC for binary valves
 *   §11 Open/close economic decision logic
 *   §12 Supervisory cutoff
 *   + DDP-based continuous relaxation (iLQR-style)
 */
class RobustDDPController {
public:
    // ── Configuration ──────────────────────────────────────────────────
    struct Config {
        // Horizon
        int N = 20;        // Prediction horizon
        double dt = 0.01;  // Timestep [s]

        // Cost weights  (match robust_ddp_default.yaml)
        double qF = 1.0;        // Thrust tracking
        double qMR = 10.0;      // Mixture ratio
        double qGas = 0.1;      // Gas consumption
        double qSwitch = 0.01;  // Control switching

        // Constraints
        double MR_min = 1.5;
        double MR_max = 3.0;
        double P_u_max = 10e6;           // [Pa]
        double P_copv_min = 1e6;         // [Pa]
        double injector_dp_frac = 0.1;   // Minimum ΔP / Pch
        double headroom_dp_min = 50000;  // [Pa]

        // Robustness
        double rho = 0.1;   // Disturbance bound
        double eta = 0.01;  // Robustness margin

        // Actuation
        double dwell_time = 0.05;  // [s]
        double duty_quantization = 0.01;

        // Dynamics (COPV / regulator / feed)
        double copv_cF = 1e5;        // COPV consumption fuel  [Pa/s·u]
        double copv_cO = 1e5;        // COPV consumption ox    [Pa/s·u]
        double copv_loss = 1e3;      // COPV leak [Pa/s]
        double V_copv = 0.006;       // COPV volume  [m³]
        double reg_setpoint = -1.0;  // Regulator setpoint [Pa] (<0 = ratio mode)
        double reg_ratio = 0.8;      // P_reg / P_copv
        double alpha_F = 10.0;       // Pressurization coeff [1/s]
        double alpha_O = 10.0;
        double rho_F = 800.0;      // Fuel density     [kg/m³]
        double rho_O = 1140.0;     // Oxidizer density  [kg/m³]
        double tau_line_F = 0.01;  // Feed-line τ [s]
        double tau_line_O = 0.01;

        // Injector model
        double Cd_fuel = 0.7;  // Discharge coeff
        double Cd_ox = 0.7;
        double A_inj_fuel = 1e-4;  // Injector orifice area [m²]
        double A_inj_ox = 1e-4;
        double c_star = 1600.0;  // Characteristic velocity [m/s]
        double Cf = 1.5;         // Thrust coefficient
        double A_throat = 1e-3;  // Nozzle throat area [m²]

        // Initial ullage volumes [m³]
        double V_u_F_init = 0.01;
        double V_u_O_init = 0.01;

        // Polytropic blowdown
        double n_polytropic = 1.2;
        double T_gas_init = 293.0;  // [K]

        // DDP solver
        int max_iterations = 10;
        double convergence_tol = 1e-4;

        // Supervisory cutoff  (§12)
        double altitude_target = -1.0;  // h* [m]  (< 0 = disabled)
        double cutoff_delta = 50.0;     // δ  [m]
    };

    // ── Sensor measurements ────────────────────────────────────────────
    struct Measurement {
        double P_copv;
        double P_reg;
        double P_u_fuel;
        double P_u_ox;
        double P_d_fuel;
        double P_d_ox;
        std::chrono::steady_clock::time_point timestamp;
    };

    // ── Navigation state ───────────────────────────────────────────────
    struct NavState {
        double h = 0.0;      // Altitude        [m]
        double vz = 0.0;     // Vertical vel    [m/s]
        double theta = 0.0;  // Tilt angle     [rad]
        double mass = 10.0;  // Vehicle mass   [kg]
    };

    // ── Command ────────────────────────────────────────────────────────
    enum class CommandType { THRUST_DESIRED, ALTITUDE_GOAL, PRESSURE_TARGET };
    struct Command {
        CommandType type = CommandType::THRUST_DESIRED;
        double thrust_desired = 0.0;
        double altitude_goal = 0.0;
        double P_fuel_target = 0.0;  // Target fuel tank pressure [Pa]
        double P_ox_target = 0.0;    // Target ox tank pressure [Pa]
    };

    // ── Actuation output ───────────────────────────────────────────────
    struct ActuationCommand {
        double duty_F = 0.0;  // Fuel duty      [0,1]
        double duty_O = 0.0;  // Oxidizer duty  [0,1]
        bool u_F_on = false;
        bool u_O_on = false;
        bool valid = false;
    };

    // ── Engine estimate ────────────────────────────────────────────────
    struct EngineEstimate {
        double F = 0.0;       // Thrust          [N]
        double MR = 0.0;      // Mixture ratio
        double P_ch = 0.0;    // Chamber pressure [Pa]
        double mdot_F = 0.0;  // Fuel flow        [kg/s]
        double mdot_O = 0.0;  // Ox flow          [kg/s]
        double dp_F = 0.0;    // Injector ΔP fuel [Pa]
        double dp_O = 0.0;    // Injector ΔP ox   [Pa]
        bool valid = false;
    };

    // ── Diagnostics ────────────────────────────────────────────────────
    struct Diagnostics {
        double F_ref = 0.0;
        double MR_ref = 0.0;
        double F_estimated = 0.0;
        double MR_estimated = 0.0;
        double P_ch = 0.0;
        double cost = 0.0;
        bool safety_filtered = false;
        bool cutoff_active = false;
        int solver_iters = 0;
        std::vector<double> u_sequence;
    };

    // ── Controller state ───────────────────────────────────────────────
    struct ControllerState {
        Eigen::VectorXd x;  // Full state [N_STATE]
        double V_u_F = 0.01;
        double V_u_O = 0.01;
        Eigen::VectorXd w_bar;  // Residual bounds [N_STATE]
    };

    // ── Public API ─────────────────────────────────────────────────────
    RobustDDPController();
    ~RobustDDPController();

    bool initialize(const Config& config);
    void reset();

    /**
     * @brief Execute one control step.
     *
     * Pipeline:
     *   1. Build state x from measurements
     *   2. Build reference (F_ref, MR_ref) over horizon
     *   3. Update robustness bounds
     *   4. Check supervisory cutoff  (§12)
     *   5. Solve DDP  or  enumerative MPC (§10)
     *   6. Safety filter — reachable tube (§9.3)
     *   7. Actuation quantization + dwell
     */
    std::pair<ActuationCommand, Diagnostics> step(const Measurement& meas, const NavState& nav,
                                                  const Command& cmd);

    ControllerState getState() const;

private:
    // ── Internal types ─────────────────────────────────────────────────
    struct Reference {
        CommandType type = CommandType::THRUST_DESIRED;
        std::vector<double> F_ref;
        std::vector<double> MR_ref;
        std::vector<double> P_fuel_ref;
        std::vector<double> P_ox_ref;
    };

    struct DDPSolution {
        Eigen::MatrixXd u_seq;  // (N, 2)
        Eigen::MatrixXd x_seq;  // (N+1, N_STATE)
        double cost = 0.0;
        int iterations = 0;
        bool converged = false;
    };

    // ── Dynamics (§4–5) ────────────────────────────────────────────────
    Eigen::VectorXd dynamicsStep(const Eigen::VectorXd& x, const Eigen::VectorXd& u, double mdot_F,
                                 double mdot_O) const;

    void linearize(const Eigen::VectorXd& x, const Eigen::VectorXd& u, double mdot_F, double mdot_O,
                   Eigen::MatrixXd& A, Eigen::MatrixXd& B) const;

    // ── Engine model (§6) ──────────────────────────────────────────────
    EngineEstimate estimateEngine(double P_d_fuel, double P_d_ox) const;

    // ── Reference generation (§8) ──────────────────────────────────────
    Reference buildReference(const NavState& nav, const Measurement& meas,
                             const Command& cmd) const;

    // ── State building ─────────────────────────────────────────────────
    Eigen::VectorXd buildState(const Measurement& meas) const;

    // ── Constraint checking (§7) ───────────────────────────────────────
    bool isStateSafe(const Eigen::VectorXd& x,
                     CommandType cmd_type = CommandType::THRUST_DESIRED) const;

    // ── DDP solver (§9) ────────────────────────────────────────────────
    DDPSolution solveDDP(const Eigen::VectorXd& x0, const Reference& ref,
                         const Eigen::MatrixXd& u_init) const;

    double runningCost(const Eigen::VectorXd& x, const Eigen::VectorXd& u, const Reference& ref,
                       int k, const Eigen::VectorXd& u_prev) const;

    // ── Enumerative robust MPC (§10) ───────────────────────────────────
    Eigen::VectorXd enumerativeMPC(const Eigen::VectorXd& x0, const Reference& ref, int k) const;

    // ── Open/close decision logic (§11) ────────────────────────────────
    Eigen::VectorXd economicDecision(const Eigen::VectorXd& x, const Reference& ref, int k) const;

    // ── Safety filter — tube propagation (§9.3) ────────────────────────
    Eigen::VectorXd filterAction(const Eigen::VectorXd& x, const Eigen::VectorXd& u_proposed,
                                 const Reference& ref, int k) const;

    bool isActionSafe(const Eigen::VectorXd& x, const Eigen::VectorXd& u, CommandType cmd_type,
                      int num_steps = 2) const;

    // ── Supervisory cutoff (§12) ───────────────────────────────────────
    bool shouldCutoff(const NavState& nav) const;

    // ── Actuation ──────────────────────────────────────────────────────
    ActuationCommand computeActuation(const Eigen::VectorXd& u_relaxed) const;

    // ── State ──────────────────────────────────────────────────────────
    Config config_;
    ControllerState state_;
    mutable std::mutex state_mutex_;

    std::optional<Eigen::VectorXd> x_prev_;
    std::optional<Eigen::VectorXd> u_prev_applied_;
    std::optional<Eigen::MatrixXd> u_seq_prev_;  // warm start
    int tick_ = 0;
};

}  // namespace control
}  // namespace fsw

#endif  // ROBUST_DDP_CONTROLLER_HPP
