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

    // Parse command line arguments (flags: --elodin-host, --relay-host, --rate, --config)
    std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;
    std::string relay_host = "127.0.0.1";
    uint16_t relay_port = 9090;
    double loop_rate_hz = 10.0;
    std::string lut_path = "";

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if ((arg == "--elodin-host" || arg == "-e") && i + 1 < argc)
            elodin_host = argv[++i];
        else if ((arg == "--relay-host" || arg == "-r") && i + 1 < argc)
            relay_host = argv[++i];
        else if ((arg == "--relay-port") && i + 1 < argc)
            relay_port = static_cast<uint16_t>(std::stoi(argv[++i]));
        else if ((arg == "--rate") && i + 1 < argc)
            loop_rate_hz = std::stod(argv[++i]);
        else if ((arg == "--elodin-port") && i + 1 < argc)
            elodin_port = static_cast<uint16_t>(std::stoi(argv[++i]));
        else if ((arg == "--lut-path") && i + 1 < argc)
            lut_path = argv[++i];
        else if (arg == "--config" && i + 1 < argc)
            ++i;  // config path accepted but not used (defaults cover all)
    }

    std::cout << "[controller_service] Starting C++ controller service..." << std::endl;
    std::cout << "[controller_service] Elodin DB: " << elodin_host << ":" << elodin_port
              << std::endl;
    std::cout << "[controller_service] Relay: " << relay_host << ":" << relay_port << std::endl;
    std::cout << "[controller_service] Loop rate: " << loop_rate_hz << " Hz" << std::endl;
    if (!lut_path.empty())
        std::cout << "[controller_service] LUT path: " << lut_path << std::endl;

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

    // Default PWM config (fuel → CH3, LOX → CH8 on actuator board)
    // Board 12 (192.168.2.12) hosts Fuel Press CH3 and LOX Press CH8 per config.toml actuator_roles
    fsw::control::ControllerService::PWMConfig pwm_config;
    pwm_config.actuator_board_ip = "192.168.2.12";
    pwm_config.actuator_port = 5005;
    pwm_config.fuel_channel = 3;
    pwm_config.lox_channel = 8;
    pwm_config.frequency_hz = 10.0f;
    pwm_config.duration_ms = 1000;

    // Initialize controller service
    if (!g_controller_service->initialize(pwm_config, config, elodin_host, elodin_port, relay_host,
                                          relay_port, lut_path)) {
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
