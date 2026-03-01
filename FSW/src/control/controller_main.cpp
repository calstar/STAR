/**
 * @file controller_main.cpp
 * @brief Standalone C++ controller service
 *
 * Reads config.toml for actuator board settings, initializes the
 * RobustDDPController, and runs the control loop sending PWM commands
 * to actuator boards over UDP.
 *
 * Usage:
 *   ./controller_service [--config /path/to/config.toml]
 *                        [--elodin-host HOST] [--elodin-port PORT]
 *                        [--thrust N]
 *
 * Default config path: ../../config/config.toml (relative to binary)
 */

#include <csignal>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "control/ControllerService.hpp"
#include "control/RobustDDPController.hpp"

// ── Simple TOML value parser (no library dependency) ───────────────────
static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

static std::string getTomlValue(const std::string& content, const std::string& section,
                                const std::string& key, const std::string& fallback = "") {
    // Find [section]
    std::string sec_header = "[" + section + "]";
    auto sec_pos = content.find(sec_header);
    if (sec_pos == std::string::npos)
        return fallback;

    // Search from section start to next section or EOF
    auto search_start = sec_pos + sec_header.size();
    auto next_sec = content.find("\n[", search_start);
    std::string sec_content = (next_sec == std::string::npos)
                                  ? content.substr(search_start)
                                  : content.substr(search_start, next_sec - search_start);

    // Find key = value
    std::istringstream iss(sec_content);
    std::string line;
    while (std::getline(iss, line)) {
        // Skip comments
        auto comment_pos = line.find('#');
        if (comment_pos != std::string::npos)
            line = line.substr(0, comment_pos);

        auto eq = line.find('=');
        if (eq == std::string::npos)
            continue;

        std::string k = trim(line.substr(0, eq));
        std::string v = trim(line.substr(eq + 1));
        if (k == key)
            return v;
    }
    return fallback;
}

// ── Signal handling ────────────────────────────────────────────────────
static std::atomic<bool> g_running{true};

static void signalHandler(int /*sig*/) {
    std::cout << "\n[controller_service] Caught signal, shutting down…" << std::endl;
    g_running = false;
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════

int main(int argc, char* argv[]) {
    // ── Parse CLI args ─────────────────────────────────────────────────
    std::string config_path = "../../config/config.toml";
    std::string elodin_host;
    uint16_t elodin_port = 2240;
    double thrust_desired = 1000.0;

    // Optional pressure targets in psi
    bool use_pressure_control = false;
    double p_fuel_target_psi = 0.0;
    double p_ox_target_psi = 0.0;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--elodin-host" && i + 1 < argc) {
            elodin_host = argv[++i];
        } else if (arg == "--elodin-port" && i + 1 < argc) {
            elodin_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--thrust" && i + 1 < argc) {
            thrust_desired = std::atof(argv[++i]);
        } else if (arg == "--p-fuel" && i + 1 < argc) {
            p_fuel_target_psi = std::atof(argv[++i]);
            use_pressure_control = true;
        } else if (arg == "--p-ox" && i + 1 < argc) {
            p_ox_target_psi = std::atof(argv[++i]);
            use_pressure_control = true;
        } else if (arg == "--help" || arg == "-h") {
            std::cout
                << "Usage: " << argv[0] << " [OPTIONS]\n"
                << "  --config PATH         config.toml path (default: ../../config/config.toml)\n"
                << "  --elodin-host HOST    Elodin DB host (empty = no DB)\n"
                << "  --elodin-port PORT    Elodin DB port (default: 2240)\n"
                << "  --thrust N            Thrust demand [N] (default: 1000)\n"
                << "  --p-fuel PSI          Fuel tank pressure target [psi]\n"
                << "  --p-ox PSI            Ox tank pressure target [psi]\n";
            return 0;
        }
    }

    // ── Read config.toml ───────────────────────────────────────────────
    std::string config_content;
    {
        std::ifstream f(config_path);
        if (!f.is_open()) {
            std::cerr << "❌ Cannot open config: " << config_path << std::endl;
            // Try fallback paths
            for (const auto& fallback :
                 {"config/config.toml", "../config/config.toml", "../../config/config.toml"}) {
                f.open(fallback);
                if (f.is_open()) {
                    config_path = fallback;
                    std::cout << "ℹ️  Using fallback config: " << fallback << std::endl;
                    break;
                }
            }
            if (!f.is_open()) {
                std::cerr << "❌ No config.toml found. Using defaults." << std::endl;
            }
        }
        if (f.is_open()) {
            std::ostringstream ss;
            ss << f.rdbuf();
            config_content = ss.str();
            std::cout << "📋 Loaded config: " << config_path << std::endl;
        }
    }

    // ── Extract settings ───────────────────────────────────────────────
    fsw::control::ControllerService::PWMConfig pwm;

    // Actuator board IP — from first actuator board in [boards]
    std::string actuator_ip =
        getTomlValue(config_content, "boards.actuator1", "ip", "192.168.2.201");
    pwm.actuator_board_ip = actuator_ip;
    pwm.actuator_port = 5005;
    pwm.fuel_channel = 3;  // Fuel Press CH3 from config
    pwm.lox_channel = 8;   // LOX Press CH8 from config

    // Controller settings
    double loop_hz = 10.0;
    if (!config_content.empty()) {
        std::string v;
        v = getTomlValue(config_content, "controller", "pwm_frequency_hz", "10.0");
        pwm.frequency_hz = static_cast<float>(std::atof(v.c_str()));

        v = getTomlValue(config_content, "controller", "pwm_duration_ms", "10000");
        pwm.duration_ms = static_cast<uint32_t>(std::atoi(v.c_str()));

        v = getTomlValue(config_content, "controller", "controller_loop_hz", "10.0");
        loop_hz = std::atof(v.c_str());
    }

    // Controller algorithm config (using defaults from RobustDDPController.hpp)
    fsw::control::RobustDDPController::Config ctrl_cfg;
    // The defaults in Config{} are already tuned — override from TOML if needed

    std::cout << "\n═══════════════════════════════════════════════════════════" << std::endl;
    std::cout << "  Robust DDP Controller Service" << std::endl;
    std::cout << "═══════════════════════════════════════════════════════════" << std::endl;
    std::cout << "  Actuator board: " << pwm.actuator_board_ip << ":" << pwm.actuator_port
              << std::endl;
    std::cout << "  Fuel Press:     CH" << (int)pwm.fuel_channel << std::endl;
    std::cout << "  LOX Press:      CH" << (int)pwm.lox_channel << std::endl;
    std::cout << "  PWM frequency:  " << pwm.frequency_hz << " Hz" << std::endl;
    std::cout << "  PWM duration:   " << pwm.duration_ms << " ms" << std::endl;
    std::cout << "  Control loop:   " << loop_hz << " Hz" << std::endl;
    std::cout << "  Thrust demand:  " << thrust_desired << " N" << std::endl;
    if (use_pressure_control) {
        std::cout << "  Control Mode:   PRESSURE TARGET" << std::endl;
        std::cout << "    Fuel Target:  " << p_fuel_target_psi << " psi" << std::endl;
        std::cout << "    Ox Target:    " << p_ox_target_psi << " psi" << std::endl;
    } else {
        std::cout << "  Control Mode:   THRUST DESIRED" << std::endl;
    }
    std::cout << "  Elodin DB:      " << (elodin_host.empty() ? "(disabled)" : elodin_host)
              << std::endl;
    std::cout << "═══════════════════════════════════════════════════════════\n" << std::endl;

    // ── Initialize ─────────────────────────────────────────────────────
    fsw::control::ControllerService service;

    if (!service.initialize(pwm, ctrl_cfg, elodin_host, elodin_port)) {
        std::cerr << "❌ Failed to initialize controller service" << std::endl;
        return 1;
    }

    // ── Set default command ────────────────────────────────────────────
    fsw::control::RobustDDPController::Command cmd;
    if (use_pressure_control) {
        cmd.type = fsw::control::RobustDDPController::CommandType::PRESSURE_TARGET;
        cmd.thrust_desired = 0.0;
        cmd.P_fuel_target = p_fuel_target_psi * 6894.76;  // psi -> Pa
        cmd.P_ox_target = p_ox_target_psi * 6894.76;      // psi -> Pa
    } else {
        cmd.type = fsw::control::RobustDDPController::CommandType::THRUST_DESIRED;
        cmd.thrust_desired = thrust_desired;
    }
    service.setCommand(cmd);

    // ── Set initial measurement (zeros — will be overwritten) ──────────
    fsw::control::RobustDDPController::Measurement meas{};
    meas.P_copv = 18.96e6;   // ~2750 psi
    meas.P_reg = 6.89e6;     // ~1000 psi
    meas.P_u_fuel = 6.89e6;  // ~1000 psi (regulated)
    meas.P_u_ox = 6.89e6;    // ~1000 psi (regulated)
    meas.P_d_fuel = 6.89e6;  // Start at ullage pressure
    meas.P_d_ox = 6.89e6;    // Start at ullage pressure
    meas.timestamp = std::chrono::steady_clock::now();
    service.setMeasurement(meas);

    // ── Install signal handlers ────────────────────────────────────────
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    // ── Start ──────────────────────────────────────────────────────────
    if (!service.start(loop_hz)) {
        std::cerr << "❌ Failed to start controller loop" << std::endl;
        return 1;
    }

    std::cout << "\n🎯 Controller running. Press Ctrl+C to stop.\n" << std::endl;

    // ── Wait for shutdown ──────────────────────────────────────────────
    while (g_running && service.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    service.stop();
    std::cout << "✅ Controller service stopped." << std::endl;
    return 0;
}
