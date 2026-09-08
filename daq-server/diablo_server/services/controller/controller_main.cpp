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
#include <memory>
#include <sstream>
#include <string>
#include <vector>
#include <thread>

#include "config/Config.hpp"
#include "control/ControllerService.hpp"
#include "control/PWMTargets.hpp"
#include "control/RobustDDPController.hpp"
#include "control/StateMachine.hpp"
#include "net/DaqInterface.hpp"

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

// ── Signal handling ────────────────────────────────────────────────────
static std::atomic<bool> g_running{true};

static void signalHandler(int /*sig*/) {
    std::cout << "\n[controller_service] Caught signal, shutting down…" << std::endl;
    g_running = false;
}

// ── TCP control server (FIRE_START / FIRE_STOP) ─────────────────────────
// The sequencer connects, sends "FIRE_START\n" or "FIRE_STOP\n", reads the reply, disconnects.
//
// Structure mirrors sequencer_main.cpp's accept loop, for the reason documented there: this loop
// must keep calling accept(). It used to read the command inline, byte at a time, with a blocking
// recv() and no SO_RCVTIMEO — so a peer that connected and never sent a newline parked it
// permanently. A half-open connection (the sequencer's host dropping off the network without a
// FIN), a port scan, or an operator running `nc` against the port to check it was up all did it.
// Worse, it was silent at both ends: the kernel completes the handshake and buffers the bytes, so
// the sequencer's send() succeeded and it logged the command as delivered while nothing read it.
// (See also SequencerService::notifyControllerFire, which now checks the ACK for that reason.)
constexpr size_t kMaxControlClients = 64;

// One connection on its own thread: read a line, dispatch, reply, close.
static void handleControlClient(int client_fd, fsw::control::ControllerService* svc) {
    // A silent peer can pin this thread, but never the accept loop, and only for 5 s.
    struct timeval tv{.tv_sec = 5, .tv_usec = 0};
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    std::string buf;
    bool got_line = false;
    while (g_running && buf.size() < 64) {
        char tmp[64];
        ssize_t n = ::recv(client_fd, tmp, sizeof(tmp), 0);
        if (n <= 0)
            break;  // peer closed, timed out, or shutdown() woke us
        buf.append(tmp, static_cast<size_t>(n));
        const size_t nl = buf.find('\n');
        if (nl != std::string::npos) {
            buf.resize(nl);
            got_line = true;
            break;
        }
    }

    auto reply = [client_fd](const char* s) {
        ::send(client_fd, s, std::strlen(s), MSG_NOSIGNAL);
    };

    if (!got_line) {
        // Timed out or the peer vanished mid-command. One line, at the point of failure — this
        // port is reachable from the site LAN and a scanner must not be able to flood the log.
        std::cerr << "[ControllerService] ⚠️  control connection closed with no command "
                     "(timeout or peer went away)"
                  << std::endl;
    } else if (buf == "FIRE_START") {
        svc->setFireActive(true);
        std::cout << "[ControllerService] 🔥 FIRE_START received — PWM gate open" << std::endl;
        reply("OK\n");
    } else if (buf == "FIRE_STOP") {
        svc->setFireActive(false);
        std::cout << "[ControllerService] 🛑 FIRE_STOP received — PWM gate closed" << std::endl;
        reply("OK\n");
    } else {
        std::cerr << "[ControllerService] ⚠️  Unknown control cmd: \"" << buf << "\"" << std::endl;
        reply("ERR\n");
    }
    ::close(client_fd);
}

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

    // Threads are counted and joined rather than detached, so none outlives `svc`.
    struct Conn {
        std::thread th;
        int fd{-1};
        std::atomic<bool> done{false};
    };
    std::vector<std::unique_ptr<Conn>> conns;

    auto reap_finished = [&conns]() {
        for (auto it = conns.begin(); it != conns.end();) {
            if ((*it)->done.load()) {
                if ((*it)->th.joinable())
                    (*it)->th.join();
                it = conns.erase(it);
            } else {
                ++it;
            }
        }
    };

    while (g_running) {
        reap_finished();

        struct timeval tv{0, 10000};  // 10 ms — keeps the g_running check cheap and responsive
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(listen_fd, &fds);
        if (select(listen_fd + 1, &fds, nullptr, nullptr, &tv) <= 0)
            continue;

        int client = ::accept(listen_fd, nullptr, nullptr);
        if (client < 0)
            continue;

        // Reap again before testing the cap, so a burst of short-lived connections inside one
        // select() iteration is not counted against the limit after those threads have finished.
        reap_finished();
        if (conns.size() >= kMaxControlClients) {
            // Say why rather than closing cold — a bare close() reaches the client as a TCP
            // reset, indistinguishable from the service having crashed.
            static const char kBusy[] = "ERR:too many connections\n";
            ::send(client, kBusy, sizeof(kBusy) - 1, MSG_NOSIGNAL);
            std::cerr << "[ControllerService] ⚠️  client limit (" << kMaxControlClients
                      << ") reached — refusing connection" << std::endl;
            ::close(client);
            continue;
        }

        auto conn = std::make_unique<Conn>();
        conn->fd = client;
        Conn* raw = conn.get();
        conn->th = std::thread([raw, svc]() {
            handleControlClient(raw->fd, svc);
            raw->done = true;
        });
        conns.push_back(std::move(conn));
    }

    // Wake anything parked in recv() so shutdown does not wait out the 5 s timeout, then join.
    for (const auto& c : conns)
        ::shutdown(c->fd, SHUT_RDWR);
    for (const auto& c : conns)
        if (c->th.joinable())
            c->th.join();

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

    const fsw::config::Config cfg = fsw::config::load(config_path);

    // Populate the config-declared [[states]] in THIS process before any name→id resolution below.
    // The controller is a separate process from the sequencer and never called this; without it,
    // stateId() resolved the fire state against the compiled enum (Fire→16) while the sequencer
    // publishes ids from config — so on a renumbered rig the two disagreed on what "16" means and
    // the PWM ignition parity gate watched the wrong id.
    sequencer::StateMachine::loadStatesFromConfig(config_content);

    // ── Extract settings from config ───────────────────────────────────
    fsw::control::ControllerService::PWMConfig pwm;

    pwm.actuator_port = cfg.network.actuator_cmd_port;

    // Resolve [controller].pwm_*_actuator → [actuator_roles] → [boards.*] IP. See PWMTargets.hpp
    // for why there is nothing to fall back to here. `unresolved` collects the reasons; the fire
    // gate is disabled below if it is non-empty.
    const auto pwm_resolution = fsw::control::resolvePWMTargets(cfg);
    const std::vector<std::string>& unresolved = pwm_resolution.issues;
    pwm.fuel = pwm_resolution.fuel;
    pwm.ox = pwm_resolution.ox;

    // Which NIC PWM commands leave from. The controller shares the apps box with the Docker
    // stack and the site LAN, so "the route to the actuator board" is no longer a single answer.
    {
        const auto nic = fsw::net::resolveDaqBindAddress(cfg, "controller");
        if (!nic.ok)
            return 1;
        pwm.bind_address = nic.address;
    }

    // Controller loop / PWM settings from [controller].
    pwm.frequency_hz = static_cast<float>(cfg.controller.pwm_frequency_hz);
    pwm.duration_ms = cfg.controller.pwm_duration_ms;
    double loop_hz = cfg.controller.controller_loop_hz;

    // Precedence: defaults < config < CLI (--elodin-host/--elodin-port).
    if (!elodin_host_from_cli)
        elodin_host = cfg.database.host;
    if (!elodin_port_from_cli)
        elodin_port = cfg.database.port;
    if (elodin_host.empty())
        elodin_host = "127.0.0.1";
    if (elodin_port == 0)
        elodin_port = 2240;

    // Control port from [controller_service].port (FIRE_START / FIRE_STOP TCP gate); --control-port
    // wins.
    if (control_port == 0)
        control_port = cfg.controller_service.port;

    // Controller algorithm config (using defaults from RobustDDPController.hpp)
    fsw::control::RobustDDPController::Config ctrl_cfg;
    // Override safety constraint from config (0 = disabled, useful for simulation)
    {
        double pmin = cfg.controller.P_copv_min_pa;
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
    // Name the actuator as well as the wire address, so an operator can tell at a glance which
    // valve this process believes it is driving.
    auto describe_target = [](const fsw::control::ControllerService::PWMTarget& t) {
        if (!t.resolved())
            return std::string("(unassigned)");
        return "\"" + t.actuator_name + "\" → " + t.board_ip + " CH" +
               std::to_string((int)t.channel);
    };
    std::cout << "  Actuator port:  " << pwm.actuator_port << std::endl;
    std::cout << "  PWM fuel:       " << describe_target(pwm.fuel) << std::endl;
    std::cout << "  PWM ox:         " << describe_target(pwm.ox) << std::endl;
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

    // Which sequencer state id means "firing", for the parity fallback that watches the sequencer
    // state packet. Config, not a literal — see ControllerService::setFireStateId.
    {
        const std::string fire_state = cfg.fire.state;
        if (fire_state.empty()) {
            // No fire state configured → the PWM fire gate never activates (id 255 = UNKNOWN never
            // matches a real sequencer state), matching the sequencer's disabled fire timer.
            service.setFireStateId(255);
            std::cout << "  Fire state:     (none) — PWM fire gate disabled" << std::endl;
        } else {
            const uint8_t id = sequencer::StateMachine::stateId(fire_state);
            if (id != 255) {
                service.setFireStateId(id);
                std::cout << "  Fire state:     " << fire_state << " (id " << static_cast<int>(id)
                          << ")" << std::endl;
            } else {
                // Config declares states but not this name: disable the gate (255 never matches a
                // real sequencer state) rather than leaving it on a compiled id, matching the
                // sequencer's disabled fire timer. Fail safe and loud, not silent-wrong.
                service.setFireStateId(255);
                std::cerr << "  ⚠️  [fire] state \"" << fire_state
                          << "\" is not a declared state — PWM fire gate DISABLED" << std::endl;
            }
        }
    }

    // Same posture for the PWM targets: config did not say which hardware to drive, so drive
    // none. 255 never matches a real sequencer state, so the gate cannot open by either the TCP
    // command or the Elodin parity path. The process keeps running — telemetry, the Elodin
    // subscriber and the control loop are all still useful, and an operator needs to see the
    // reason rather than a service that vanished at boot.
    if (!unresolved.empty()) {
        service.setFireStateId(255);
        for (const auto& why : unresolved)
            std::cerr << "  ⚠️  [controller] " << why << std::endl;
        std::cerr << "  ⚠️  [controller] PWM fire gate DISABLED. Assign exactly one "
                     "[actuator_roles] entry \"pwm_fuel\" and one \"pwm_ox\" via the optional "
                     "4th element, e.g. \"Fuel Press\" = [\"NC\", 3, 12, \"pwm_fuel\"]."
                  << std::endl;
    }

    std::string lut_path_raw = !lut_path_cli.empty() ? lut_path_cli : cfg.controller.lut_path;
    std::string thrust_curve_path_raw = cfg.controller.thrust_curve_path;
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
        float td_f = static_cast<float>(cfg.controller.fallback_fuel_duty_cycle);
        float td_o = static_cast<float>(cfg.controller.fallback_ox_duty_cycle);
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
