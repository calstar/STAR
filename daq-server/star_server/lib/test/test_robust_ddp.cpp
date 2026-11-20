#include <chrono>
#include <iomanip>
#include <iostream>

#include "../include/control/RobustDDPController.hpp"

using namespace fsw::control;

int main() {
    std::cout << "=== Robust DDP Controller Test ===" << std::endl;

    // ── Configure ──────────────────────────────────────────────────────
    RobustDDPController::Config config;
    config.N = 20;
    config.dt = 0.01;
    config.qF = 1.0;
    config.qMR = 10.0;
    config.qGas = 0.1;
    config.qSwitch = 0.01;
    config.MR_min = 1.5;
    config.MR_max = 3.0;
    config.P_u_max = 10e6;
    config.P_copv_min = 1e6;
    config.injector_dp_frac = 0.1;
    config.V_copv = 0.006;  // 6 L COPV
    config.reg_ratio = 0.8;
    config.rho_F = 800.0;
    config.rho_O = 1140.0;
    config.Cd_fuel = 0.7;
    config.Cd_ox = 0.7;
    config.A_inj_fuel = 1e-4;
    config.A_inj_ox = 1e-4;
    config.c_star = 1600.0;
    config.Cf = 1.5;
    config.A_throat = 1e-3;
    config.V_u_F_init = 0.01;
    config.V_u_O_init = 0.01;
    config.T_gas_init = 293.0;
    config.n_polytropic = 1.2;
    config.max_iterations = 5;
    config.altitude_target = -1.0;  // cutoff disabled

    RobustDDPController controller;
    if (!controller.initialize(config)) {
        std::cerr << "Failed to initialize controller" << std::endl;
        return 1;
    }

    // ── Measurement ────────────────────────────────────────────────────
    RobustDDPController::Measurement meas;
    meas.P_copv = 20e6;               // 20 MPa
    meas.P_reg = 16e6;                // 16 MPa
    meas.P_u_fuel = 974.0 * 6894.76;  // ~6.71 MPa
    meas.P_u_ox = 1305.0 * 6894.76;   // ~9.00 MPa
    meas.P_d_fuel = 6.5e6;
    meas.P_d_ox = 8.5e6;
    meas.timestamp = std::chrono::steady_clock::now();

    // ── Nav ────────────────────────────────────────────────────────────
    RobustDDPController::NavState nav;
    nav.h = 0.0;
    nav.vz = 0.0;
    nav.theta = 0.0;
    nav.mass = 25.0;

    // ── Command ────────────────────────────────────────────────────────
    RobustDDPController::Command cmd;
    cmd.type = RobustDDPController::CommandType::THRUST_DESIRED;
    cmd.thrust_desired = 5000.0;  // 5 kN

    // ── Run 10 steps ───────────────────────────────────────────────────
    std::cout << std::fixed << std::setprecision(2);
    std::cout
        << "\nTick | duty_F | duty_O | F_est [N]  | MR_est | P_ch [MPa] | safe_filt | cutoff\n";
    std::cout << std::string(90, '-') << "\n";

    for (int i = 0; i < 10; ++i) {
        auto [act, diag] = controller.step(meas, nav, cmd);

        std::cout << std::setw(4) << i << " | " << std::setw(6) << act.duty_F << " | "
                  << std::setw(6) << act.duty_O << " | " << std::setw(10) << diag.F_estimated
                  << " | " << std::setw(6) << diag.MR_estimated << " | " << std::setw(10)
                  << diag.P_ch / 1e6 << " | " << (diag.safety_filtered ? "  YES  " : "   no  ")
                  << " | " << (diag.cutoff_active ? "YES" : " no") << "\n";

        // Simulate slight blowdown: COPV drops, ullage grows
        meas.P_copv *= 0.995;
        meas.P_u_fuel *= 0.998;
        meas.P_u_ox *= 0.998;
        meas.P_d_fuel = 0.97 * meas.P_u_fuel;
        meas.P_d_ox = 0.97 * meas.P_u_ox;
        nav.h += nav.vz * config.dt;
        nav.vz += (diag.F_estimated / nav.mass - G0) * config.dt;
    }

    // ── Cutoff test ────────────────────────────────────────────────────
    std::cout << "\n--- Cutoff test (altitude_target = 100 m) ---\n";
    controller.reset();
    config.altitude_target = 100.0;
    config.cutoff_delta = 20.0;
    controller.initialize(config);

    nav.h = 80.0;
    nav.vz = 25.0;  // apogee ≈ 80 + 25²/19.6 ≈ 112 m  → cutoff
    auto [act_cut, diag_cut] = controller.step(meas, nav, cmd);
    std::cout << "  h=80, vz=25 → cutoff=" << (diag_cut.cutoff_active ? "YES" : "NO") << "\n";

    nav.h = 10.0;
    nav.vz = 5.0;  // apogee ≈ 10 + 25/19.6 ≈ 11.3 m  → NO cutoff
    auto [act_nocut, diag_nocut] = controller.step(meas, nav, cmd);
    std::cout << "  h=10, vz=5  → cutoff=" << (diag_nocut.cutoff_active ? "YES" : "NO") << "\n";

    std::cout << "\n✅ Robust DDP Controller test completed successfully\n";
    return 0;
}
