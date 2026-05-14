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

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <thread>

#include "control/ControllerService.hpp"
#include "control/RobustDDPController.hpp"

// ── Simple TOML value parser (no library dependency) ───────────────────
static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

/** Resolve path relative to config: paths like output/lut/... are relative to project root. */
static std::string resolveConfigPath(const std::string& config_path, const std::string& path) {
    if (path.empty() || (path.size() > 0 && path[0] == '/'))
        return path;
    size_t last = config_path.rfind('/');
    std::string config_dir = (last != std::string::npos) ? config_path.substr(0, last) : ".";
    last = config_dir.rfind('/');
    std::string project_root = (last != std::string::npos) ? config_dir.substr(0, last) : ".";
    return project_root + "/" + path;
}

static std::string getTomlValue(const std::string& content, const std::string& section,
                                const std::string& key, const std::string& fallback = "") {
    std::string sec_header = "[" + section + "]";
    auto sec_pos = content.find(sec_header);
    if (sec_pos == std::string::npos)
        return fallback;

    auto search_start = sec_pos + sec_header.size();
    auto next_sec = content.find("\n[", search_start);
    std::string sec_content = (next_sec == std::string::npos)
                                  ? content.substr(search_start)
                                  : content.substr(search_start, next_sec - search_start);

    std::istringstream iss(sec_content);
    std::string line;
    while (std::getline(iss, line)) {
        auto c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
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

// Parse [actuator_roles] entry: "Fuel Press" = ["NC", 3, 12] → channel, board_id, is_no
static void parseActuatorRole(const std::string& val, int& channel, int& board_id, bool& is_no) {
    channel = 0;
    board_id = 0;
    is_no = false;
    size_t i = val.find('[');
    if (i == std::string::npos)
        return;
    size_t j = val.find(',', i + 1);
    if (j == std::string::npos)
        return;
    std::string type_str = trim(val.substr(i + 1, j - i - 1));
    if (type_str == "NO" || type_str == "no")
        is_no = true;
    size_t k = val.find(',', j + 1);
    try {
        if (k != std::string::npos)
            board_id = std::stoi(trim(val.substr(k + 1)));
        channel =
            std::stoi(trim(val.substr(j + 1, (k != std::string::npos ? k : val.size()) - j - 1)));
    } catch (...) {
    }
}

// Build board_id → IP map from all [boards.xxx] sections (mirrors actuator_service logic)
static std::map<int, std::string> buildBoardIpMap(const std::string& config_content,
                                                  const std::string& config_path) {
    std::map<int, std::string> m;

    // Fallback: scan [boards.xxx] sections in config.toml
    if (!config_content.empty()) {
        size_t pos = 0;
        while (pos < config_content.size()) {
            size_t next = config_content.find("[boards.", pos);
            if (next == std::string::npos)
                break;
            size_t end = config_content.find(']', next);
            if (end == std::string::npos)
                break;
            std::string sec = config_content.substr(next + 1, end - next - 1);
            std::string ip = getTomlValue(config_content, sec, "ip", "");
            std::string id_str = getTomlValue(config_content, sec, "board_id",
                                              getTomlValue(config_content, sec, "id", "0"));
            if (!ip.empty() && !m.count(0)) {
                try {
                    int id = std::stoi(id_str);
                    if (id > 0 && !m.count(id))
                        m[id] = ip;
                } catch (...) {
                }
            }
            pos = end + 1;
        }
    }

    // Last-resort defaults matching standard subnet layout
    if (m.empty()) {
        m[11] = "192.168.2.11";
        m[12] = "192.168.2.12";
        m[13] = "192.168.2.13";
        m[14] = "192.168.2.14";
    }
    return m;
}

// ── Signal handling ────────────────────────────────────────────────────
static std::atomic<bool> g_running{true};

static void signalHandler(int /*sig*/) {
    std::cout << "\n[controller_service] Caught signal, shutting down…" << std::endl;
    g_running = false;
}

// ── TCP control server (FIRE_START / FIRE_STOP) ─────────────────────────
// Mirrors the actuator_service TCP command pattern.
// TS backend connects, sends "FIRE_START\n" or "FIRE_STOP\n", then disconnects.
static void runControlServer(fsw::control::ControllerService* svc, uint16_t port) {
    int listen_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        std::cerr << "[ControllerService] ❌ Control socket failed: " << strerror(errno)
                  << std::endl;
        return;
    }
    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    if (bind(listen_fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::cerr << "[ControllerService] ❌ Control bind(" << port
                  << ") failed: " << strerror(errno) << std::endl;
        ::close(listen_fd);
        return;
    }
    ::listen(listen_fd, 4);
    std::cout << "[ControllerService] 🎮 Control server on TCP :" << port
              << "  (FIRE_START | FIRE_STOP)" << std::endl;

    while (g_running) {
        struct timeval tv{1, 0};
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(listen_fd, &fds);
        if (select(listen_fd + 1, &fds, nullptr, nullptr, &tv) <= 0)
            continue;

        int client = ::accept(listen_fd, nullptr, nullptr);
        if (client < 0)
            continue;

        std::string buf;
        char c;
        while (buf.size() < 64 && ::recv(client, &c, 1, 0) == 1) {
            if (c == '\n')
                break;
            buf += c;
        }

        if (buf == "FIRE_START") {
            svc->setFireActive(true);
            std::cout << "[ControllerService] 🔥 FIRE_START received — PWM gate open" << std::endl;
            const char* reply = "OK\n";
            ::send(client, reply, std::strlen(reply), 0);
        } else if (buf == "FIRE_STOP") {
            svc->setFireActive(false);
            std::cout << "[ControllerService] 🛑 FIRE_STOP received — PWM gate closed" << std::endl;
            const char* reply = "OK\n";
            ::send(client, reply, std::strlen(reply), 0);
        } else {
            std::cerr << "[ControllerService] ⚠️  Unknown control cmd: \"" << buf << "\""
                      << std::endl;
            const char* reply = "ERR\n";
            ::send(client, reply, std::strlen(reply), 0);
        }
        ::close(client);
    }
    ::close(listen_fd);
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════

int main(int argc, char* argv[]) {
    // ── Parse CLI args ─────────────────────────────────────────────────
    std::string config_path = "../../config/config.toml";
    std::string elodin_host = "";  // empty = use config.toml [database].host
    uint16_t elodin_port = 0;      // 0 = use config.toml [database].port
    uint16_t control_port = 0;     // 0 = use config.toml [controller_service].port
    double thrust_desired = 1000.0;
    bool elodin_host_from_cli = false;
    bool elodin_port_from_cli = false;

    // Optional pressure targets in psi
    bool use_pressure_control = false;
    double p_fuel_target_psi = 0.0;
    double p_ox_target_psi = 0.0;
    std::string lut_path_cli;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--elodin-host" && i + 1 < argc) {
            elodin_host = argv[++i];
            elodin_host_from_cli = true;
        } else if (arg == "--elodin-port" && i + 1 < argc) {
            elodin_port = static_cast<uint16_t>(std::atoi(argv[++i]));
            elodin_port_from_cli = true;
        } else if (arg == "--control-port" && i + 1 < argc) {
            control_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--thrust" && i + 1 < argc) {
            thrust_desired = std::atof(argv[++i]);
        } else if (arg == "--p-fuel" && i + 1 < argc) {
            p_fuel_target_psi = std::atof(argv[++i]);
            use_pressure_control = true;
        } else if (arg == "--p-ox" && i + 1 < argc) {
            p_ox_target_psi = std::atof(argv[++i]);
            use_pressure_control = true;
        } else if (arg == "--lut-path" && i + 1 < argc) {
            lut_path_cli = argv[++i];
        } else if (arg == "--help" || arg == "-h") {
            std::cout
                << "Usage: " << argv[0] << " [OPTIONS]\n"
                << "  --config PATH         config.toml path (default: ../../config/config.toml)\n"
                << "  --elodin-host HOST    Elodin DB host (empty = no DB)\n"
                << "  --elodin-port PORT    Elodin DB port (default: 2240)\n"
                << "  --thrust N            Thrust demand [N] (default: 1000)\n"
                << "  --p-fuel PSI          Fuel tank pressure target [psi]\n"
                << "  --p-ox PSI            Ox tank pressure target [psi]\n"
                << "  --lut-path PATH      LUT binary for boolean control (bypasses DDP)\n";
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

    // ── Extract settings from config ───────────────────────────────────
    fsw::control::ControllerService::PWMConfig pwm;

    // Build board_id → IP map from [boards.xxx] sections (uses discovery if available)
    auto board_ip_map = buildBoardIpMap(config_content, config_path);

    // Read actuator_cmd_port from [network] (boards listen on this for commands)
    {
        std::string v = getTomlValue(config_content, "network", "actuator_cmd_port", "5005");
        pwm.actuator_port = static_cast<uint16_t>(std::atoi(v.c_str()));
    }

    // Parse [actuator_roles] to find Fuel Press and LOX Press channels/boards
    {
        int fuel_channel = 3, fuel_board_id = 12;
        int lox_channel = 8, lox_board_id = 12;
        bool found_fuel = false, found_lox = false;

        std::string current_section;
        std::istringstream cfg(config_content);
        std::string line;
        while (std::getline(cfg, line)) {
            auto c = line.find('#');
            if (c != std::string::npos)
                line = line.substr(0, c);
            if (line.size() >= 2 && line[0] == '[') {
                size_t end = line.find(']');
                current_section = (end != std::string::npos) ? line.substr(1, end - 1) : "";
                continue;
            }
            if (current_section != "actuator_roles")
                continue;
            auto eq = line.find('=');
            if (eq == std::string::npos)
                continue;
            std::string key = trim(line.substr(0, eq));
            std::string val = trim(line.substr(eq + 1));
            int ch = 0, bid = 0;
            bool is_no = false;
            parseActuatorRole(val, ch, bid, is_no);
            if (ch < 1)
                continue;
            if (key == "Fuel Press") {
                fuel_channel = ch;
                fuel_board_id = bid;
                found_fuel = true;
            } else if (key == "LOX Press") {
                lox_channel = ch;
                lox_board_id = bid;
                found_lox = true;
            }
        }

        if (!found_fuel)
            std::cerr << "⚠️  [controller] 'Fuel Press' not found in [actuator_roles]; "
                         "using defaults (CH3, board 12)"
                      << std::endl;
        if (!found_lox)
            std::cerr << "⚠️  [controller] 'LOX Press' not found in [actuator_roles]; "
                         "using defaults (CH8, board 12)"
                      << std::endl;

        pwm.fuel_channel = static_cast<uint8_t>(fuel_channel);
        pwm.lox_channel = static_cast<uint8_t>(lox_channel);

        // Resolve board IDs to IPs; warn if they differ (PWMConfig has one IP for now)
        auto fuel_it = board_ip_map.find(fuel_board_id);
        auto lox_it = board_ip_map.find(lox_board_id);
        std::string fuel_ip = (fuel_it != board_ip_map.end())
                                  ? fuel_it->second
                                  : "192.168.2." + std::to_string(fuel_board_id);
        std::string lox_ip = (lox_it != board_ip_map.end())
                                 ? lox_it->second
                                 : "192.168.2." + std::to_string(lox_board_id);

        if (fuel_ip != lox_ip)
            std::cerr << "⚠️  [controller] Fuel Press (" << fuel_ip << ") and LOX Press (" << lox_ip
                      << ") on different boards — using fuel board IP for both" << std::endl;
        pwm.actuator_board_ip = fuel_ip;
    }

    // Controller loop / PWM settings from [controller] section
    double loop_hz = 10.0;
    {
        std::string v;
        v = getTomlValue(config_content, "controller", "pwm_frequency_hz", "10.0");
        pwm.frequency_hz = static_cast<float>(std::atof(v.c_str()));

        v = getTomlValue(config_content, "controller", "pwm_duration_ms", "10000");
        pwm.duration_ms = static_cast<uint32_t>(std::atoi(v.c_str()));

        v = getTomlValue(config_content, "controller", "controller_loop_hz", "10.0");
        loop_hz = std::atof(v.c_str());
    }

    if (!elodin_host_from_cli) {
        std::string db_host = getTomlValue(config_content, "database", "host", "127.0.0.1");
        if (!db_host.empty())
            elodin_host = db_host;
    }
    if (!elodin_port_from_cli) {
        std::string db_port_str = getTomlValue(config_content, "database", "port", "2240");
        if (!db_port_str.empty())
            elodin_port = static_cast<uint16_t>(std::atoi(db_port_str.c_str()));
    }
    if (elodin_host.empty())
        elodin_host = "127.0.0.1";
    if (elodin_port == 0)
        elodin_port = 2240;

    // Read control port from [controller_service].port (FIRE_START / FIRE_STOP TCP gate)
    if (control_port == 0) {
        std::string cp = getTomlValue(config_content, "controller_service", "port", "9999");
        if (!cp.empty())
            control_port = static_cast<uint16_t>(std::atoi(cp.c_str()));
        if (control_port == 0)
            control_port = 9999;
    }

    // Controller algorithm config (using defaults from RobustDDPController.hpp)
    fsw::control::RobustDDPController::Config ctrl_cfg;
    // Override safety constraint from config (0 = disabled, useful for simulation)
    {
        std::string v = getTomlValue(config_content, "controller", "P_copv_min_pa", "0");
        double pmin = std::atof(v.c_str());
        ctrl_cfg.P_copv_min = pmin;  // 0 disables the check; real hotfire sets >0
        if (pmin == 0.0)
            std::cout << "  P_copv_min:     disabled (0)" << std::endl;
        else
            std::cout << "  P_copv_min:     " << pmin << " Pa (" << (pmin / 6894.76) << " psi)"
                      << std::endl;
    }

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

    std::string lut_path_raw = !lut_path_cli.empty()
                                   ? lut_path_cli
                                   : getTomlValue(config_content, "controller", "lut_path", "");
    std::string thrust_curve_path_raw =
        getTomlValue(config_content, "controller", "thrust_curve_path", "");
    std::string lut_path = resolveConfigPath(config_path, lut_path_raw);
    std::string thrust_curve_path = resolveConfigPath(config_path, thrust_curve_path_raw);
    if (!lut_path.empty())
        std::cout << "  LUT path:       " << lut_path << " (boolean control)" << std::endl;
    if (!thrust_curve_path.empty())
        std::cout << "  Thrust curve:   " << thrust_curve_path << std::endl;

    if (!service.initialize(pwm, ctrl_cfg, elodin_host, elodin_port, lut_path, thrust_curve_path)) {
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

    // ── Optional open-loop test duty (fallback_fuel/ox_duty_cycle from config) ──
    // When non-zero this bypasses the DDP controller so you can validate UDP PWM delivery.
    {
        float td_f = 0.0f, td_o = 0.0f;
        std::string v;
        v = getTomlValue(config_content, "controller", "fallback_fuel_duty_cycle", "0");
        td_f = static_cast<float>(std::atof(v.c_str()));
        v = getTomlValue(config_content, "controller", "fallback_ox_duty_cycle", "0");
        td_o = static_cast<float>(std::atof(v.c_str()));
        if (td_f > 0.0f || td_o > 0.0f)
            service.setTestDuty(td_f, td_o);
    }

    // ── Install signal handlers ────────────────────────────────────────
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    // ── Start ──────────────────────────────────────────────────────────
    if (!service.start(loop_hz)) {
        std::cerr << "❌ Failed to start controller loop" << std::endl;
        return 1;
    }

    // ── Start TCP control server (FIRE_START / FIRE_STOP gate) ────────────
    std::thread control_thread(runControlServer, &service, control_port);
    control_thread.detach();

    std::cout << "\n🎯 Controller running. PWM gated to FIRE state (TCP :" << control_port << ").\n"
              << std::endl;

    // ── Wait for shutdown ──────────────────────────────────────────────
    while (g_running && service.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    service.stop();
    std::cout << "✅ Controller service stopped." << std::endl;
    return 0;
}
