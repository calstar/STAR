#include "../include/control/RobustDDPController.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <mutex>
#include <numeric>

namespace fsw {
namespace control {

// ═══════════════════════════════════════════════════════════════════════
//  CONSTRUCTION / INIT / RESET
// ═══════════════════════════════════════════════════════════════════════

RobustDDPController::RobustDDPController() {
    state_.x = Eigen::VectorXd::Zero(N_STATE);
    state_.w_bar = Eigen::VectorXd::Zero(N_STATE);
    state_.V_u_F = 0.01;
    state_.V_u_O = 0.01;
}

RobustDDPController::~RobustDDPController() = default;

bool RobustDDPController::initialize(const Config& config) {
    config_ = config;
    reset();
    return true;
}

void RobustDDPController::reset() {
    std::lock_guard<std::mutex> lock(state_mutex_);
    state_.x = Eigen::VectorXd::Zero(N_STATE);
    state_.w_bar = Eigen::VectorXd::Zero(N_STATE);
    state_.V_u_F = config_.V_u_F_init;
    state_.V_u_O = config_.V_u_O_init;
    x_prev_.reset();
    u_prev_applied_.reset();
    u_seq_prev_.reset();
    tick_ = 0;
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN CONTROL STEP  (§9 pipeline)
// ═══════════════════════════════════════════════════════════════════════

std::pair<RobustDDPController::ActuationCommand, RobustDDPController::Diagnostics>
RobustDDPController::step(const Measurement& meas, const NavState& nav, const Command& cmd) {
    std::lock_guard<std::mutex> lock(state_mutex_);

    Diagnostics diag;
    diag.safety_filtered = false;

    // 1. Build state
    Eigen::VectorXd x = buildState(meas);

    // 2. Build reference
    Reference ref = buildReference(nav, meas, cmd);
    diag.F_ref = ref.F_ref.empty() ? 0.0 : ref.F_ref[0];
    diag.MR_ref = ref.MR_ref.empty() ? 0.0 : ref.MR_ref[0];

    // 3. Update robustness bounds  w_bar ← ρ·w_bar + (1−ρ)·|x_meas − x_pred|
    if (x_prev_.has_value() && u_prev_applied_.has_value()) {
        auto eng = estimateEngine(x_prev_.value()(IDX_P_D_F), x_prev_.value()(IDX_P_D_O));
        Eigen::VectorXd x_pred =
            dynamicsStep(x_prev_.value(), u_prev_applied_.value(), eng.mdot_F, eng.mdot_O);
        Eigen::VectorXd residual = (x - x_pred).cwiseAbs();
        state_.w_bar = config_.rho * state_.w_bar + (1.0 - config_.rho) * residual;
        state_.w_bar *= (1.0 + config_.eta);
    }

    // 4. Supervisory cutoff  (§12)
    if (shouldCutoff(nav)) {
        diag.cutoff_active = true;
        ActuationCommand act{};
        act.duty_F = 0.0;
        act.duty_O = 0.0;
        act.u_F_on = false;
        act.u_O_on = false;
        act.valid = true;
        x_prev_ = x;
        u_prev_applied_ = Eigen::VectorXd::Zero(N_CONTROL);
        ++tick_;
        return {act, diag};
    }

    // 5. Solve — use enumerative MPC for binary valves (§10)
    //    then refine with DDP for PWM (§9)
    Eigen::VectorXd u_binary = enumerativeMPC(x, ref, 0);

    // Also try economic decision logic (§11) as candidate
    Eigen::VectorXd u_econ = economicDecision(x, ref, 0);

    // Pick best of enumerative and economic
    // eng_bin used implicitly inside runningCost
    double cost_bin = runningCost(x, u_binary, ref, 0,
                                  u_prev_applied_.value_or(Eigen::VectorXd::Zero(N_CONTROL)));
    double cost_econ =
        runningCost(x, u_econ, ref, 0, u_prev_applied_.value_or(Eigen::VectorXd::Zero(N_CONTROL)));
    Eigen::VectorXd u_relaxed = (cost_bin <= cost_econ) ? u_binary : u_econ;

    // Optionally refine with DDP if horizon > 1
    if (config_.N > 1 && config_.max_iterations > 0) {
        Eigen::MatrixXd u_init(config_.N, N_CONTROL);
        if (u_seq_prev_.has_value()) {
            // Warm start: shift previous solution
            u_init.topRows(config_.N - 1) = u_seq_prev_->bottomRows(config_.N - 1);
            u_init.row(config_.N - 1) = u_seq_prev_->row(config_.N - 1);
        } else {
            for (int i = 0; i < config_.N; ++i)
                u_init.row(i) = u_relaxed.transpose();
        }

        DDPSolution sol = solveDDP(x, ref, u_init);
        diag.cost = sol.cost;
        diag.solver_iters = sol.iterations;

        // Only use DDP solution if it improves over greedy
        double cost_ddp = runningCost(x, sol.u_seq.row(0).transpose(), ref, 0,
                                      u_prev_applied_.value_or(Eigen::VectorXd::Zero(N_CONTROL)));
        if (cost_ddp < cost_bin && cost_ddp < cost_econ) {
            u_relaxed = sol.u_seq.row(0).transpose();
        }
        u_seq_prev_ = sol.u_seq;
    }

    // 6. Safety filter  (§9.3)
    Eigen::VectorXd u_safe = filterAction(x, u_relaxed, ref, 0);
    if ((u_safe - u_relaxed).norm() > 1e-6)
        diag.safety_filtered = true;

    // 7. Actuation
    ActuationCommand act = computeActuation(u_safe);

    // Engine estimate for diagnostics
    EngineEstimate eng = estimateEngine(x(IDX_P_D_F), x(IDX_P_D_O));
    diag.F_estimated = eng.F;
    diag.MR_estimated = eng.MR;
    diag.P_ch = eng.P_ch;

    if (ref.type == CommandType::PRESSURE_TARGET && tick_ % 10 == 0) {
        std::cout << "[PRESSURE_MODE] tick=" << tick_ << " P_f_d=" << x(IDX_P_D_F) / 6894.76
                  << "psi / " << cmd.P_fuel_target / 6894.76 << "psi" << " u_safe=[" << u_safe(0)
                  << ", " << u_safe(1) << "]" << " cost_bin=" << cost_bin
                  << " cost_econ=" << cost_econ << "\n";
    }

    // Store for next tick
    x_prev_ = x;
    u_prev_applied_ = u_safe;
    ++tick_;

    return {act, diag};
}

RobustDDPController::ControllerState RobustDDPController::getState() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return state_;
}

// ═══════════════════════════════════════════════════════════════════════
//  DYNAMICS  (§4: Blowdown Ullage Dynamics + §5: COPV Gas)
// ═══════════════════════════════════════════════════════════════════════

Eigen::VectorXd RobustDDPController::dynamicsStep(const Eigen::VectorXd& x,
                                                  const Eigen::VectorXd& u, double mdot_F,
                                                  double mdot_O) const {
    const double dt = config_.dt;

    double P_copv = x(IDX_P_COPV);
    // P_reg derived from COPV, not directly from state
    double P_u_F = x(IDX_P_U_F);
    double P_u_O = x(IDX_P_U_O);
    double P_d_F = x(IDX_P_D_F);
    double P_d_O = x(IDX_P_D_O);
    double V_u_F = x(IDX_V_U_F);
    double V_u_O = x(IDX_V_U_O);
    double m_copv = x(IDX_M_GAS_COPV);
    double m_F = x(IDX_M_GAS_F);
    double m_O = x(IDX_M_GAS_O);

    double u_F = std::clamp(u(0), 0.0, 1.0);
    double u_O = std::clamp(u(1), 0.0, 1.0);
    double u_total = std::max(u_F, u_O);

    const double T = config_.T_gas_init;
    const double n = config_.n_polytropic;

    // ── COPV gas flow (choked / subsonic) ──────────────────────────────
    double P_reg_eff = (config_.reg_setpoint > 0 && P_copv >= config_.reg_setpoint)
                           ? config_.reg_setpoint
                           : config_.reg_ratio * P_copv;

    double mdot_gas_reg = 0.0;
    if (u_total > 1e-6 && P_copv > P_reg_eff) {
        double pr_crit = std::pow(2.0 / (GAMMA_N2 + 1.0), GAMMA_N2 / (GAMMA_N2 - 1.0));
        double pr = P_reg_eff / P_copv;
        double Cd_reg = 0.7, A_reg = 2e-5;
        if (pr < pr_crit) {
            // choked
            double C_star = std::sqrt(
                GAMMA_N2 * std::pow(2.0 / (GAMMA_N2 + 1.0), (GAMMA_N2 + 1.0) / (GAMMA_N2 - 1.0)));
            mdot_gas_reg = Cd_reg * A_reg * P_copv / std::sqrt(R_GAS_N2 * T) * C_star;
        } else {
            double t1 = (2.0 * GAMMA_N2) / ((GAMMA_N2 - 1.0) * R_GAS_N2 * T);
            double t2 = std::pow(pr, 2.0 / GAMMA_N2) - std::pow(pr, (GAMMA_N2 + 1.0) / GAMMA_N2);
            mdot_gas_reg = Cd_reg * A_reg * P_copv * std::sqrt(t1 * std::max(t2, 0.0));
        }
        mdot_gas_reg *= u_total;
        mdot_gas_reg = std::clamp(mdot_gas_reg, 0.0, 0.2);
    }

    // ── Gas flow to tanks (proportional to valve duty) ─────────────────
    auto calc_tank_flow = [&](double u_v, double P_tank) -> double {
        if (u_v < 1e-6 || P_reg_eff <= P_tank)
            return 0.0;
        double pr = P_tank / P_reg_eff;
        double pr_crit = std::pow(2.0 / (GAMMA_N2 + 1.0), GAMMA_N2 / (GAMMA_N2 - 1.0));
        double Cd_v = 0.65, A_v = 5e-5;
        double flow;
        if (pr < pr_crit) {
            double C_star = std::sqrt(
                GAMMA_N2 * std::pow(2.0 / (GAMMA_N2 + 1.0), (GAMMA_N2 + 1.0) / (GAMMA_N2 - 1.0)));
            flow = Cd_v * A_v * P_reg_eff / std::sqrt(R_GAS_N2 * T) * C_star;
        } else {
            double t1 = (2.0 * GAMMA_N2) / ((GAMMA_N2 - 1.0) * R_GAS_N2 * T);
            double t2 = std::pow(pr, 2.0 / GAMMA_N2) - std::pow(pr, (GAMMA_N2 + 1.0) / GAMMA_N2);
            flow = Cd_v * A_v * P_reg_eff * std::sqrt(t1 * std::max(t2, 0.0));
        }
        flow *= u_v;
        // mass-conservation clamp
        if (u_total > 1e-6 && mdot_gas_reg > 0.0)
            flow = std::min(flow, mdot_gas_reg * u_v / u_total);
        return std::max(flow, 0.0);
    };

    double mdot_gas_F = calc_tank_flow(u_F, P_u_F);
    double mdot_gas_O = calc_tank_flow(u_O, P_u_O);

    // COPV loss
    double mdot_loss = std::clamp(config_.copv_loss * config_.V_copv / (R_GAS_N2 * T), 0.0, 0.01);
    double mdot_total = mdot_gas_reg + mdot_loss;

    // ── Update gas masses ──────────────────────────────────────────────
    double m_copv_next = std::max(m_copv - dt * mdot_total, 0.0);
    double m_F_next = std::max(m_F + dt * mdot_gas_F, 0.0);
    double m_O_next = std::max(m_O + dt * mdot_gas_O, 0.0);

    // ── COPV pressure (ideal gas + polytropic T) ───────────────────────
    double P_copv_next = 0.0;
    if (config_.V_copv > 1e-10) {
        double T_copv = T;
        if (m_copv > 1e-10) {
            double rho_ratio = m_copv_next / m_copv;
            T_copv = T * std::pow(std::max(rho_ratio, 1e-6), n - 1.0);
            T_copv = std::clamp(T_copv, 200.0, 400.0);
        }
        P_copv_next = m_copv_next * R_GAS_N2 * T_copv / config_.V_copv;
    }
    P_copv_next = std::max(P_copv_next, 0.0);

    // ── Regulator pressure ─────────────────────────────────────────────
    double P_reg_next;
    if (config_.reg_setpoint > 0 && P_copv_next >= config_.reg_setpoint)
        P_reg_next = config_.reg_setpoint;
    else
        P_reg_next = config_.reg_ratio * P_copv_next;

    // ── Ullage volume (§4.1) ───────────────────────────────────────────
    double mdot_F_safe = std::max(mdot_F, 0.0);
    double mdot_O_safe = std::max(mdot_O, 0.0);

    // Pressure-dependent scaling for exponential blowdown
    const double P_ref = 5e6;
    double scale_F = std::sqrt(std::max(P_u_F, 1e5) / P_ref);
    double scale_O = std::sqrt(std::max(P_u_O, 1e5) / P_ref);
    scale_F = std::clamp(scale_F, 0.1, 2.0);
    scale_O = std::clamp(scale_O, 0.1, 2.0);

    if (u_total < 1e-6) {  // pure blowdown — more aggressive
        scale_F *= 1.5;
        scale_O *= 1.5;
    }

    double V_u_F_next = V_u_F + dt * mdot_F_safe * scale_F / config_.rho_F;
    double V_u_O_next = V_u_O + dt * mdot_O_safe * scale_O / config_.rho_O;
    V_u_F_next = std::max(V_u_F_next, 0.0);
    V_u_O_next = std::max(V_u_O_next, 0.0);

    // ── Ullage pressures  P = m·R·T / V ───────────────────────────────
    auto ullage_P = [&](double m_gas, double V_u) {
        if (V_u < 1e-10)
            return 0.0;
        return std::max(m_gas * R_GAS_N2 * T / V_u, 0.0);
    };
    double P_u_F_next = ullage_P(m_F_next, V_u_F_next);
    double P_u_O_next = ullage_P(m_O_next, V_u_O_next);

    // ── Feed pressures  (first-order lag) ──────────────────────────────
    double P_d_F_next = P_d_F + dt * (P_u_F - P_d_F) / (config_.tau_line_F * 2.0);
    double P_d_O_next = P_d_O + dt * (P_u_O - P_d_O) / (config_.tau_line_O * 2.0);

    // ── Assemble ───────────────────────────────────────────────────────
    Eigen::VectorXd x_next(N_STATE);
    x_next << P_copv_next, P_reg_next, P_u_F_next, P_u_O_next, P_d_F_next, P_d_O_next, V_u_F_next,
        V_u_O_next, m_copv_next, m_F_next, m_O_next;
    return x_next;
}

void RobustDDPController::linearize(const Eigen::VectorXd& x, const Eigen::VectorXd& u,
                                    double mdot_F, double mdot_O, Eigen::MatrixXd& A,
                                    Eigen::MatrixXd& B) const {
    const double eps = 1e-6;
    Eigen::VectorXd x_nom = dynamicsStep(x, u, mdot_F, mdot_O);

    A.resize(N_STATE, N_STATE);
    for (int i = 0; i < N_STATE; ++i) {
        Eigen::VectorXd xp = x;
        xp(i) += eps;
        A.col(i) = (dynamicsStep(xp, u, mdot_F, mdot_O) - x_nom) / eps;
    }

    B.resize(N_STATE, N_CONTROL);
    for (int i = 0; i < N_CONTROL; ++i) {
        Eigen::VectorXd up = u;
        up(i) = std::clamp(up(i) + eps, 0.0, 1.0);
        B.col(i) = (dynamicsStep(x, up, mdot_F, mdot_O) - x_nom) / eps;
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  ENGINE MODEL  (§6)
// ═══════════════════════════════════════════════════════════════════════

RobustDDPController::EngineEstimate RobustDDPController::estimateEngine(double P_d_fuel,
                                                                        double P_d_ox) const {
    EngineEstimate est;

    // Injector mass flow  (§6.1): ṁ = Cd·A·√(2·ρ·ΔP)
    // For a simple model, assume chamber pressure from supply pressures
    // Iterative root-find (bracketed) for Pch: ṁF + ṁO = Pch·At / c*
    double P_ch_lo = 0.0;
    double P_ch_hi = std::min(P_d_fuel, P_d_ox);
    if (P_ch_hi < 1e3) {
        est.valid = false;
        return est;
    }

    auto mdot_at_Pch = [&](double P_ch) -> std::pair<double, double> {
        double dP_F = std::max(P_d_fuel - P_ch, 0.0);
        double dP_O = std::max(P_d_ox - P_ch, 0.0);
        double mF = config_.Cd_fuel * config_.A_inj_fuel * std::sqrt(2.0 * config_.rho_F * dP_F);
        double mO = config_.Cd_ox * config_.A_inj_ox * std::sqrt(2.0 * config_.rho_O * dP_O);
        return {mF, mO};
    };

    // Chamber closure: ṁF + ṁO = Pch · At / c*  (§6.3)
    auto residual = [&](double P_ch) -> double {
        auto [mF, mO] = mdot_at_Pch(P_ch);
        double mdot_total = mF + mO;
        double mdot_nozzle = P_ch * config_.A_throat / config_.c_star;
        return mdot_total - mdot_nozzle;
    };

    // Bisection root-find
    for (int i = 0; i < 30; ++i) {
        double P_mid = 0.5 * (P_ch_lo + P_ch_hi);
        if (residual(P_mid) > 0)
            P_ch_lo = P_mid;
        else
            P_ch_hi = P_mid;
        if (P_ch_hi - P_ch_lo < 10.0)
            break;  // 10 Pa tolerance
    }
    double P_ch = 0.5 * (P_ch_lo + P_ch_hi);

    auto [mF, mO] = mdot_at_Pch(P_ch);

    est.P_ch = P_ch;
    est.mdot_F = mF;
    est.mdot_O = mO;
    est.MR = (mF > 1e-8) ? mO / mF : 0.0;
    est.F = config_.Cf * P_ch * config_.A_throat;  // §6.4
    est.dp_F = std::max(P_d_fuel - P_ch, 0.0);
    est.dp_O = std::max(P_d_ox - P_ch, 0.0);
    est.valid = (P_ch > 1e3 && std::isfinite(est.F));
    return est;
}

// ═══════════════════════════════════════════════════════════════════════
//  REFERENCE GENERATION  (§8)
// ═══════════════════════════════════════════════════════════════════════

RobustDDPController::Reference RobustDDPController::buildReference(const NavState& nav,
                                                                   const Measurement& /* meas */,
                                                                   const Command& cmd) const {
    Reference ref;
    ref.type = cmd.type;
    ref.F_ref.resize(config_.N);
    ref.MR_ref.resize(config_.N);
    ref.P_fuel_ref.resize(config_.N);
    ref.P_ox_ref.resize(config_.N);

    double F_target = 0.0;
    double MR_target = 2.0;  // nominal MR
    double P_f_target = 0.0;
    double P_o_target = 0.0;

    if (cmd.type == CommandType::THRUST_DESIRED) {
        F_target = cmd.thrust_desired;
    } else if (cmd.type == CommandType::PRESSURE_TARGET) {
        F_target = cmd.thrust_desired;  // Secondary, maybe 0
        P_f_target = cmd.P_fuel_target;
        P_o_target = cmd.P_ox_target;
    } else {
        // Altitude-based  (§8.1):  a_z = kp·(h*−h) + kd·(v*−vz)
        double kp = 1.0, kd = 2.0;
        double az_des = kp * (cmd.altitude_goal - nav.h) + kd * (0.0 - nav.vz);
        double cos_theta = std::cos(nav.theta);
        if (cos_theta < 0.1)
            cos_theta = 0.1;
        F_target = nav.mass * (az_des + G0) / cos_theta;
        F_target = std::max(F_target, 0.0);
    }

    for (int i = 0; i < config_.N; ++i) {
        ref.F_ref[i] = F_target;
        ref.MR_ref[i] = MR_target;
        ref.P_fuel_ref[i] = P_f_target;
        ref.P_ox_ref[i] = P_o_target;
    }
    return ref;
}

// ═══════════════════════════════════════════════════════════════════════
//  BUILD STATE
// ═══════════════════════════════════════════════════════════════════════

Eigen::VectorXd RobustDDPController::buildState(const Measurement& meas) const {
    Eigen::VectorXd x(N_STATE);
    x(IDX_P_COPV) = meas.P_copv;
    x(IDX_P_REG) = meas.P_reg;
    x(IDX_P_U_F) = meas.P_u_fuel;
    x(IDX_P_U_O) = meas.P_u_ox;
    x(IDX_P_D_F) = meas.P_d_fuel;
    x(IDX_P_D_O) = meas.P_d_ox;
    x(IDX_V_U_F) = state_.V_u_F;
    x(IDX_V_U_O) = state_.V_u_O;

    const double T = config_.T_gas_init;
    x(IDX_M_GAS_COPV) = meas.P_copv * config_.V_copv / (R_GAS_N2 * T);
    x(IDX_M_GAS_F) = (state_.V_u_F > 1e-10) ? meas.P_u_fuel * state_.V_u_F / (R_GAS_N2 * T) : 0.0;
    x(IDX_M_GAS_O) = (state_.V_u_O > 1e-10) ? meas.P_u_ox * state_.V_u_O / (R_GAS_N2 * T) : 0.0;
    return x;
}

// ═══════════════════════════════════════════════════════════════════════
//  CONSTRAINTS  (§7)
// ═══════════════════════════════════════════════════════════════════════

bool RobustDDPController::isStateSafe(const Eigen::VectorXd& x, CommandType cmd_type) const {
    // §5.2  Hard gas constraint: P_copv ≥ P_copv_min
    if (x(IDX_P_COPV) < config_.P_copv_min)
        return false;
    // §7 pressure bounds
    if (x(IDX_P_U_F) > config_.P_u_max)
        return false;
    if (x(IDX_P_U_O) > config_.P_u_max)
        return false;

    // Safety checks on engine are somewhat coupled to thrust mode.
    // If not valid, it's safe (e.g. pressure too low for combustion).
    auto eng = estimateEngine(x(IDX_P_D_F), x(IDX_P_D_O));
    if (!eng.valid)
        return true;  // can't evaluate → assume safe

    if (cmd_type != CommandType::PRESSURE_TARGET) {
        // §7.1 MR bounds
        if (eng.MR < config_.MR_min || eng.MR > config_.MR_max)
            return false;
        // §7.2 Injector stiffness: ΔP ≥ ε·Pch
        if (eng.dp_F < config_.injector_dp_frac * eng.P_ch)
            return false;
        if (eng.dp_O < config_.injector_dp_frac * eng.P_ch)
            return false;
    }

    return true;
}

// ═══════════════════════════════════════════════════════════════════════
//  DDP SOLVER  (§9  — iLQR-style finite-horizon DDP)
// ═══════════════════════════════════════════════════════════════════════

double RobustDDPController::runningCost(const Eigen::VectorXd& x, const Eigen::VectorXd& u,
                                        const Reference& ref, int k,
                                        const Eigen::VectorXd& u_prev) const {
    auto eng = estimateEngine(x(IDX_P_D_F), x(IDX_P_D_O));
    double cost = 0.0;

    if (ref.type == CommandType::PRESSURE_TARGET) {
        // Pressure control mode: penalize deviation from target tank pressures
        double P_f_err = (x(IDX_P_D_F) - ref.P_fuel_ref[k]) / 1e5;  // scale by 1 bar for tuning
        double P_o_err = (x(IDX_P_D_O) - ref.P_ox_ref[k]) / 1e5;

        // High penalty to overcome gas cost/switching cost
        cost += 1e4 * P_f_err * P_f_err;
        cost += 1e4 * P_o_err * P_o_err;
    } else {
        // Thrust/MR control mode
        if (eng.valid) {
            double F_ref = ref.F_ref[k];
            double MR_ref = ref.MR_ref[k];
            double F_err = (eng.F - F_ref) / std::max(std::abs(F_ref), 1.0);
            double MR_err = (eng.MR - MR_ref) / std::max(std::abs(MR_ref), 1.0);
            cost += config_.qF * F_err * F_err;
            cost += config_.qMR * MR_err * MR_err;
        } else if (ref.F_ref[k] > 0) {
            cost += 1e4;
        }
    }

    // Gas consumption
    cost += config_.qGas * config_.dt *
            (config_.copv_cF * u(0) + config_.copv_cO * u(1) + config_.copv_loss);

    // Switching cost
    cost += config_.qSwitch * (u - u_prev).squaredNorm();

    // Soft constraint penalties
    if (x(IDX_P_COPV) < config_.P_copv_min)
        cost += 1e4 * std::pow(config_.P_copv_min - x(IDX_P_COPV), 2) / 1e12;
    if (eng.valid) {
        if (eng.MR < config_.MR_min)
            cost += 1e4 * std::pow(config_.MR_min - eng.MR, 2);
        if (eng.MR > config_.MR_max)
            cost += 1e4 * std::pow(eng.MR - config_.MR_max, 2);
    }
    return cost;
}

RobustDDPController::DDPSolution RobustDDPController::solveDDP(
    const Eigen::VectorXd& x0, const Reference& ref, const Eigen::MatrixXd& u_init) const {
    const int N = config_.N;
    DDPSolution sol;
    sol.u_seq = u_init;

    Eigen::MatrixXd x_seq(N + 1, N_STATE);
    double best_cost = std::numeric_limits<double>::infinity();
    Eigen::MatrixXd best_u = u_init;

    double reg = 1e-4;
    const double eps = 1e-6;

    for (int iter = 0; iter < config_.max_iterations; ++iter) {
        // ── Forward rollout ────────────────────────────────────────────
        x_seq.row(0) = x0.transpose();
        double total_cost = 0.0;
        Eigen::VectorXd u_p = Eigen::VectorXd::Zero(N_CONTROL);

        for (int k = 0; k < N; ++k) {
            Eigen::VectorXd xk = x_seq.row(k).transpose();
            Eigen::VectorXd uk = sol.u_seq.row(k).transpose();
            auto eng = estimateEngine(xk(IDX_P_D_F), xk(IDX_P_D_O));
            total_cost += runningCost(xk, uk, ref, k, u_p);
            u_p = uk;
            x_seq.row(k + 1) = dynamicsStep(xk, uk, eng.mdot_F, eng.mdot_O).transpose();
        }

        if (total_cost < best_cost) {
            best_cost = total_cost;
            best_u = sol.u_seq;
        }

        // Convergence
        if (iter > 0 && std::abs(total_cost - sol.cost) < config_.convergence_tol) {
            sol.converged = true;
            break;
        }
        sol.cost = total_cost;

        // ── Backward pass ──────────────────────────────────────────────
        Eigen::VectorXd Vx = Eigen::VectorXd::Zero(N_STATE);
        Eigen::MatrixXd Vxx = Eigen::MatrixXd::Zero(N_STATE, N_STATE);

        std::vector<Eigen::VectorXd> k_gains(N, Eigen::VectorXd::Zero(N_CONTROL));
        std::vector<Eigen::MatrixXd> K_gains(N, Eigen::MatrixXd::Zero(N_CONTROL, N_STATE));

        for (int k = N - 1; k >= 0; --k) {
            Eigen::VectorXd xk = x_seq.row(k).transpose();
            Eigen::VectorXd uk = sol.u_seq.row(k).transpose();
            auto eng = estimateEngine(xk(IDX_P_D_F), xk(IDX_P_D_O));

            Eigen::MatrixXd A, B;
            linearize(xk, uk, eng.mdot_F, eng.mdot_O, A, B);

            // Cost derivatives via finite differences
            Eigen::VectorXd u_pr = Eigen::VectorXd::Zero(N_CONTROL);
            if (k > 0)
                u_pr = sol.u_seq.row(k - 1).transpose();
            double c0 = runningCost(xk, uk, ref, k, u_pr);

            Eigen::VectorXd lx(N_STATE);
            for (int i = 0; i < N_STATE; ++i) {
                Eigen::VectorXd xp = xk;
                xp(i) += eps;
                lx(i) = (runningCost(xp, uk, ref, k, u_pr) - c0) / eps;
            }
            Eigen::VectorXd lu(N_CONTROL);
            for (int i = 0; i < N_CONTROL; ++i) {
                Eigen::VectorXd up = uk;
                up(i) = std::clamp(up(i) + eps, 0.0, 1.0);
                lu(i) = (runningCost(xk, up, ref, k, u_pr) - c0) / eps;
            }

            // Q-function
            Eigen::VectorXd Qx = lx + A.transpose() * Vx;
            Eigen::VectorXd Qu = lu + B.transpose() * Vx;
            Eigen::MatrixXd Qxx = A.transpose() * Vxx * A;
            Eigen::MatrixXd Quu = B.transpose() * Vxx * B;
            Eigen::MatrixXd Qux = B.transpose() * Vxx * A;

            // Robustification — inflate by w_bar²
            Qxx += Eigen::VectorXd(state_.w_bar.array().square()).asDiagonal();

            // Regularize Quu
            Quu += (reg + 1e-6) * Eigen::MatrixXd::Identity(N_CONTROL, N_CONTROL);

            // Gains
            Eigen::MatrixXd Quu_inv = Quu.inverse();
            k_gains[k] = -Quu_inv * Qu;
            K_gains[k] = -Quu_inv * Qux;

            // Value function update
            Vx = Qx + K_gains[k].transpose() * Quu * k_gains[k] + K_gains[k].transpose() * Qu +
                 Qux.transpose() * k_gains[k];
            Vxx = Qxx + K_gains[k].transpose() * Quu * K_gains[k] + K_gains[k].transpose() * Qux +
                  Qux.transpose() * K_gains[k];
            Vxx = 0.5 * (Vxx + Vxx.transpose());  // symmetrise
        }

        // ── Forward line search ────────────────────────────────────────
        double alpha = 1.0;
        bool improved = false;
        while (alpha > 1e-4) {
            Eigen::MatrixXd u_new(N, N_CONTROL);
            Eigen::MatrixXd x_new(N + 1, N_STATE);
            x_new.row(0) = x0.transpose();
            double c_new = 0.0;
            Eigen::VectorXd u_p2 = Eigen::VectorXd::Zero(N_CONTROL);

            for (int k = 0; k < N; ++k) {
                Eigen::VectorXd dx = x_new.row(k).transpose() - x_seq.row(k).transpose();
                Eigen::VectorXd du = alpha * k_gains[k] + K_gains[k] * dx;
                Eigen::VectorXd uk_new = sol.u_seq.row(k).transpose() + du;
                uk_new = uk_new.cwiseMax(0.0).cwiseMin(1.0);  // clamp
                u_new.row(k) = uk_new.transpose();

                auto eng = estimateEngine(x_new.row(k)(IDX_P_D_F), x_new.row(k)(IDX_P_D_O));
                c_new += runningCost(x_new.row(k).transpose(), uk_new, ref, k, u_p2);
                u_p2 = uk_new;
                x_new.row(k + 1) =
                    dynamicsStep(x_new.row(k).transpose(), uk_new, eng.mdot_F, eng.mdot_O)
                        .transpose();
            }

            if (c_new < total_cost) {
                if (ref.type == CommandType::PRESSURE_TARGET) {
                    // std::cout << "[DDP Iter " << iter << "] accepted step (alpha=" << alpha << ")
                    // cost: " << c_new << " -> u=" << u_new.row(0) << std::endl;
                }
                sol.u_seq = u_new;
                improved = true;
                break;
            }
            alpha *= 0.5;
        }

        if (ref.type == CommandType::PRESSURE_TARGET && !improved) {
            // std::cout << "[DDP Iter " << iter << "] rejected all steps (reg=" << reg << ")" <<
            // std::endl;
        }

        if (!improved)
            reg *= 5.0;
        else
            reg = std::max(reg / 5.0, 1e-6);
        if (reg > 1e6)
            break;

        sol.iterations = iter + 1;
    }

    sol.u_seq = best_u;
    sol.cost = best_cost;
    sol.x_seq = x_seq;
    return sol;
}

// ═══════════════════════════════════════════════════════════════════════
//  ENUMERATIVE ROBUST MPC  (§10)
//
//  Binary valves → only 4 actions: {(0,0),(0,1),(1,0),(1,1)}.
//  Enumerate admissible sequences (respecting dwell), propagate
//  worst-case blowdown + gas loss, reject infeasible, pick min cost.
// ═══════════════════════════════════════════════════════════════════════

Eigen::VectorXd RobustDDPController::enumerativeMPC(const Eigen::VectorXd& x0, const Reference& ref,
                                                    int k) const {
    // Candidate binary actions
    static const std::array<Eigen::Vector2d, 4> actions = {
        {{0.0, 0.0}, {0.0, 1.0}, {1.0, 0.0}, {1.0, 1.0}}};

    double best_cost = std::numeric_limits<double>::infinity();
    Eigen::VectorXd best_u = Eigen::VectorXd::Zero(N_CONTROL);

    Eigen::VectorXd u_prev = u_prev_applied_.value_or(Eigen::VectorXd::Zero(N_CONTROL));

    // Look-ahead depth (tractable since 4^depth)
    const int depth = std::min(config_.N, 3);

    // Depth-1 enumeration with multi-step worst-case propagation
    for (const auto& u_cand : actions) {
        // Propagate worst-case over `depth` steps
        Eigen::VectorXd x_wc = x0;
        double total_cost = 0.0;
        bool feasible = true;

        for (int step = 0; step < depth; ++step) {
            auto eng = estimateEngine(x_wc(IDX_P_D_F), x_wc(IDX_P_D_O));
            total_cost += runningCost(x_wc, u_cand, ref, k, u_prev);

            // Worst-case dynamics: nominal + w_bar disturbance (max adverse)
            Eigen::VectorXd x_next = dynamicsStep(x_wc, u_cand, eng.mdot_F, eng.mdot_O);
            // Inflate by w_bar for robustness (worst-case adversary)
            x_next -= state_.w_bar;  // worst-case direction
            x_next = x_next.cwiseMax(0.0);

            // Check feasibility  (§9.3 constraints)
            if (!isStateSafe(x_next, ref.type)) {
                feasible = false;
                break;
            }
            x_wc = x_next;
        }

        if (!feasible)
            continue;

        if (total_cost < best_cost) {
            best_cost = total_cost;
            best_u = u_cand;
        }
    }

    if (ref.type == CommandType::PRESSURE_TARGET) {
        // std::cout << "[EnumMPC] best cost=" << best_cost << " u=" << best_u.transpose() <<
        // std::endl;
    }

    return best_u;
}

// ═══════════════════════════════════════════════════════════════════════
//  OPEN/CLOSE ECONOMIC DECISION  (§11)
//
//  Valve i opens if: qF·(F_ref − F)·ΔF_i ≥ λ_gas·Δm_c,i + λ_switch
// ═══════════════════════════════════════════════════════════════════════

Eigen::VectorXd RobustDDPController::economicDecision(const Eigen::VectorXd& x,
                                                      const Reference& ref, int k) const {
    auto eng_base = estimateEngine(x(IDX_P_D_F), x(IDX_P_D_O));
    double F_base = eng_base.valid ? eng_base.F : 0.0;

    Eigen::VectorXd u_out = Eigen::VectorXd::Zero(N_CONTROL);

    // Marginal thrust benefit for each valve
    for (int i = 0; i < N_CONTROL; ++i) {
        // Simulate opening valve i
        Eigen::VectorXd u_test = Eigen::VectorXd::Zero(N_CONTROL);
        u_test(i) = 1.0;

        // One-step forward
        auto eng_open = estimateEngine(x(IDX_P_D_F), x(IDX_P_D_O));
        Eigen::VectorXd x_next = dynamicsStep(x, u_test, eng_open.mdot_F, eng_open.mdot_O);
        auto eng_next = estimateEngine(x_next(IDX_P_D_F), x_next(IDX_P_D_O));
        double F_open = eng_next.valid ? eng_next.F : F_base;

        double delta_F = F_open - F_base;

        // Marginal gas cost
        double delta_mc = (i == 0) ? config_.copv_cF : config_.copv_cO;
        delta_mc *= config_.dt;

        // Decision rule  (§11)
        double benefit;
        if (ref.type == CommandType::PRESSURE_TARGET) {
            // High benefit if we are below the pressure target
            double P_f_err = std::max(0.0, ref.P_fuel_ref[k] - x(IDX_P_D_F));
            double P_o_err = std::max(0.0, ref.P_ox_ref[k] - x(IDX_P_D_O));
            double err_pa = (i == 0) ? P_f_err : P_o_err;

            // Scaled benefit: if we are >1 psi (6894 Pa) away, open it
            // gas_cost is usually around ~2000-3000
            benefit = err_pa;
        } else {
            benefit = config_.qF * (ref.F_ref[k] - F_base) * delta_F;
        }
        double gas_cost = config_.qGas * delta_mc + config_.qSwitch;

        if (benefit >= gas_cost)
            u_out(i) = 1.0;
    }

    return u_out;
}

// ═══════════════════════════════════════════════════════════════════════
//  SAFETY FILTER  (§9.3 — tube propagation)
// ═══════════════════════════════════════════════════════════════════════

bool RobustDDPController::isActionSafe(const Eigen::VectorXd& x, const Eigen::VectorXd& u,
                                       CommandType cmd_type, int num_steps) const {
    Eigen::VectorXd x_lo = x;
    Eigen::VectorXd x_hi = x;

    for (int s = 0; s < num_steps; ++s) {
        auto eng = estimateEngine(x_hi(IDX_P_D_F), x_hi(IDX_P_D_O));
        Eigen::VectorXd x_lo_next = dynamicsStep(x_lo, u, eng.mdot_F, eng.mdot_O) - state_.w_bar;
        Eigen::VectorXd x_hi_next = dynamicsStep(x_hi, u, eng.mdot_F, eng.mdot_O) + state_.w_bar;
        x_lo_next = x_lo_next.cwiseMax(0.0);
        x_lo = x_lo_next.cwiseMin(x_hi_next);
        x_hi = x_lo_next.cwiseMax(x_hi_next);

        if (!isStateSafe(x_hi, cmd_type))
            return false;
    }
    return true;
}

Eigen::VectorXd RobustDDPController::filterAction(const Eigen::VectorXd& x,
                                                  const Eigen::VectorXd& u_proposed,
                                                  const Reference& ref, int k) const {
    Eigen::VectorXd u_safe = u_proposed.cwiseMax(0.0).cwiseMin(1.0);

    if (isActionSafe(x, u_safe, ref.type))
        return u_safe;

    // Find best safe action from binary candidates
    static const std::array<Eigen::Vector2d, 9> candidates = {
        {{0, 0}, {0, 0.5}, {0, 1}, {0.5, 0}, {0.5, 0.5}, {0.5, 1}, {1, 0}, {1, 0.5}, {1, 1}}};

    double best_cost = std::numeric_limits<double>::infinity();
    Eigen::VectorXd best_u = Eigen::VectorXd::Zero(N_CONTROL);
    Eigen::VectorXd u_prev = u_prev_applied_.value_or(Eigen::VectorXd::Zero(N_CONTROL));

    for (const auto& c : candidates) {
        if (!isActionSafe(x, c, ref.type))
            continue;
        double cost = runningCost(x, c, ref, k, u_prev);
        if (cost < best_cost) {
            best_cost = cost;
            best_u = c;
        }
    }
    return best_u;
}

// ═══════════════════════════════════════════════════════════════════════
//  SUPERVISORY CUTOFF  (§12)
//   Predict apogee: h_ap = h + vz² / (2g)
//   If h_ap ≥ h* − δ → u_F = u_O = 0
// ═══════════════════════════════════════════════════════════════════════

bool RobustDDPController::shouldCutoff(const NavState& nav) const {
    if (config_.altitude_target < 0)
        return false;  // disabled
    double h_apogee = nav.h + (nav.vz * nav.vz) / (2.0 * G0);
    return h_apogee >= (config_.altitude_target - config_.cutoff_delta);
}

// ═══════════════════════════════════════════════════════════════════════
//  ACTUATION  (quantization + dwell)
// ═══════════════════════════════════════════════════════════════════════

RobustDDPController::ActuationCommand RobustDDPController::computeActuation(
    const Eigen::VectorXd& u_relaxed) const {
    ActuationCommand act;
    double q = config_.duty_quantization;

    // Quantize
    act.duty_F = std::clamp(std::round(u_relaxed(0) / q) * q, 0.0, 1.0);
    act.duty_O = std::clamp(std::round(u_relaxed(1) / q) * q, 0.0, 1.0);

    // Binary threshold (for on/off solenoids)
    act.u_F_on = act.duty_F > 0.5;
    act.u_O_on = act.duty_O > 0.5;
    act.valid = true;
    return act;
}

}  // namespace control
}  // namespace fsw
