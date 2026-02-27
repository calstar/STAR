/**
 * @file controller_service_main.cpp
 * @brief Main entry point for C++ controller service
 *
 * This service runs RobustDDPController integrated with Elodin DB:
 * - Reads sensor measurements from Elodin DB
 * - Computes actuation commands
 * - Writes controller outputs to Elodin DB for logging and replay
 */

#include <csignal>
#include <iostream>
#include <memory>

#include "control/ControllerService.hpp"

std::unique_ptr<fsw::control::ControllerService> g_controller_service;

void signalHandler(int signum) {
    (void)signum;
    std::cout << "\n[controller_service] Shutting down..." << std::endl;
    if (g_controller_service) {
        g_controller_service->stop();
    }
    exit(0);
}

int main(int argc, char* argv[]) {
    // Register signal handlers
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Parse command line arguments
    std::string elodin_host = "localhost";
    uint16_t elodin_port = 2240;
    double loop_rate_hz = 10.0;

    if (argc > 1) {
        elodin_host = argv[1];
    }
    if (argc > 2) {
        elodin_port = static_cast<uint16_t>(std::stoi(argv[2]));
    }
    if (argc > 3) {
        loop_rate_hz = std::stod(argv[3]);
    }

    std::cout << "[controller_service] Starting C++ controller service..." << std::endl;
    std::cout << "[controller_service] Elodin DB: " << elodin_host << ":" << elodin_port
              << std::endl;
    std::cout << "[controller_service] Loop rate: " << loop_rate_hz << " Hz" << std::endl;

    // Create controller service
    g_controller_service = std::make_unique<fsw::control::ControllerService>();

    // Default controller configuration
    fsw::control::RobustDDPController::Config config;
    config.N = 50;
    config.dt = 0.01;
    config.dwell_time = 0.05;
    config.duty_quantization = 0.01;
    config.qF = 100.0;
    config.qMR = 10.0;
    config.qGas = 0.001;
    config.qSwitch = 0.0001;
    config.MR_min = 1.5;
    config.MR_max = 3.0;
    config.injector_dp_frac = 0.1;
    config.eps_i = 0.001;
    config.P_u_max = 10'000'000.0;
    config.P_copv_min = 1'000'000.0;
    config.headroom_dp_min = 50'000.0;
    config.rho = 0.1;
    config.eta = 0.01;
    config.max_iterations = 20;
    config.convergence_tol = 0.001;
    config.copv_cF = 100'000.0;
    config.copv_cO = 100'000.0;
    config.copv_loss = 1000.0;
    config.reg_setpoint = 6'894'760.0;
    config.reg_ratio = 0.8;
    config.alpha_F = 10.0;
    config.alpha_O = 10.0;
    config.rho_F = 800.0;
    config.rho_O = 1140.0;
    config.tau_line_F = 0.05;
    config.tau_line_O = 0.05;

    // Initialize controller service
    if (!g_controller_service->initialize(elodin_host, elodin_port, config)) {
        std::cerr << "[controller_service] ❌ Failed to initialize controller service" << std::endl;
        return 1;
    }

    // Start controller loop
    if (!g_controller_service->start(loop_rate_hz)) {
        std::cerr << "[controller_service] ❌ Failed to start controller loop" << std::endl;
        return 1;
    }

    std::cout << "[controller_service] ✅ Controller service running. Press Ctrl+C to stop."
              << std::endl;

    // Keep main thread alive
    while (g_controller_service->is_running()) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    return 0;
}
