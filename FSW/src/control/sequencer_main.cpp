/**
 * sequencer_service — state machine, actuator commanding, abort, FIRE lifecycle.
 *
 * Listens on TCP (default port 9998) for newline-terminated text commands:
 *
 *   TRANSITION:<state_name>          — request state transition
 *   ACTUATOR:<role_name>:<0|1>       — manual actuator command (debug mode only)
 *   DEBUG_MODE:<0|1>                 — toggle debug mode
 *   EXTEND_FIRE                      — extend FIRE window
 *   RELOAD_CONFIG                    — hot-reload config.toml and CSVs
 *
 * Each command gets an immediate reply of "OK\n" or "ERR:<reason>\n".
 * Multiple simultaneous TCP clients are supported (one thread per connection).
 *
 * Usage: ./sequencer_service [--config PATH] [--port PORT]
 */

#include "control/SequencerService.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>

namespace {
std::atomic<bool> g_running{true};

void signalHandler(int /*sig*/) {
    std::cout << "\n[Sequencer] Shutting down..." << std::endl;
    g_running = false;
}

std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

void handleClient(int client_fd, sequencer::SequencerService& svc) {
    // 5-second receive timeout per line
    struct timeval tv{ .tv_sec = 5, .tv_usec = 0 };
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    std::string buf;
    buf.reserve(256);

    auto sendReply = [&](const std::string& msg) {
        send(client_fd, msg.c_str(), msg.size(), MSG_NOSIGNAL);
    };

    while (g_running) {
        buf.clear();
        char c;
        while (g_running && recv(client_fd, &c, 1, 0) == 1) {
            if (c == '\n') break;
            if (buf.size() < 512) buf += c;
        }
        if (buf.empty()) break;

        const std::string cmd = trim(buf);
        if (cmd.empty()) continue;

        // ── TRANSITION:<state_name> ──────────────────────────────────────────
        if (cmd.compare(0, 11, "TRANSITION:") == 0) {
            const std::string state_name = trim(cmd.substr(11));
            if (state_name.empty()) {
                sendReply("ERR:empty state name\n");
            } else if (svc.transitionTo(state_name)) {
                sendReply("OK\n");
            } else {
                sendReply("ERR:transition rejected\n");
            }

        // ── ACTUATOR:<role>:<0|1> ────────────────────────────────────────────
        } else if (cmd.compare(0, 9, "ACTUATOR:") == 0) {
            const std::string rest  = trim(cmd.substr(9));
            const size_t last_colon = rest.rfind(':');
            if (last_colon == std::string::npos || last_colon == 0) {
                sendReply("ERR:bad ACTUATOR format\n");
                continue;
            }
            const std::string role_name = trim(rest.substr(0, last_colon));
            const std::string val_str   = trim(rest.substr(last_colon + 1));
            int pos = -1;
            if (val_str == "1" || val_str == "open")   pos = 1;
            else if (val_str == "0" || val_str == "closed") pos = 0;
            if (pos < 0 || role_name.empty()) {
                sendReply("ERR:bad ACTUATOR value\n");
            } else if (svc.manualActuator(role_name, pos)) {
                sendReply("OK\n");
            } else {
                sendReply("ERR:actuator command failed\n");
            }

        // ── DEBUG_MODE:<0|1> ─────────────────────────────────────────────────
        } else if (cmd.compare(0, 11, "DEBUG_MODE:") == 0) {
            const std::string val = trim(cmd.substr(11));
            if (val == "1" || val == "true") {
                svc.setDebugMode(true);
                sendReply("OK\n");
            } else if (val == "0" || val == "false") {
                svc.setDebugMode(false);
                sendReply("OK\n");
            } else {
                sendReply("ERR:bad DEBUG_MODE value\n");
            }

        // ── EXTEND_FIRE ──────────────────────────────────────────────────────
        } else if (cmd == "EXTEND_FIRE") {
            if (svc.extendFire()) sendReply("OK\n");
            else                  sendReply("ERR:not in FIRE state\n");

        // ── RELOAD_CONFIG ────────────────────────────────────────────────────
        } else if (cmd == "RELOAD_CONFIG") {
            if (svc.reloadConfig()) sendReply("OK\n");
            else                    sendReply("ERR:reload failed\n");

        } else {
            sendReply("ERR:unknown command\n");
        }
    }

    close(client_fd);
}
} // namespace

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    uint16_t    listen_port = 9998;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--port" && i + 1 < argc) {
            listen_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0] << " [--config PATH] [--port PORT]\n";
            return 0;
        }
    }

    signal(SIGINT,  signalHandler);
    signal(SIGTERM, signalHandler);
    signal(SIGPIPE, SIG_IGN); // don't crash on broken TCP connections

    sequencer::SequencerService svc;
    if (!svc.init(config_path)) {
        std::cerr << "[Sequencer] Initialization failed" << std::endl;
        return 1;
    }

    // TCP listen socket
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        std::cerr << "[Sequencer] socket() failed" << std::endl;
        return 1;
    }
    {
        int opt = 1;
        setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    }
    {
        struct sockaddr_in addr{};
        addr.sin_family      = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port        = htons(listen_port);
        if (bind(listen_fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
            std::cerr << "[Sequencer] bind() failed on port " << listen_port << std::endl;
            close(listen_fd);
            return 1;
        }
    }
    if (listen(listen_fd, 10) < 0) {
        std::cerr << "[Sequencer] listen() failed" << std::endl;
        close(listen_fd);
        return 1;
    }

    std::cout << "[Sequencer] Listening on port " << listen_port << std::endl;
    std::cout << "[Sequencer] Commands: TRANSITION:<state> | ACTUATOR:<name>:<0|1> "
              << "| DEBUG_MODE:<0|1> | EXTEND_FIRE | RELOAD_CONFIG" << std::endl;

    while (g_running) {
        // select() with 1-second timeout so we can check g_running
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(listen_fd, &rd);
        struct timeval tv{ .tv_sec = 1, .tv_usec = 0 };
        if (select(listen_fd + 1, &rd, nullptr, nullptr, &tv) <= 0) continue;

        int client_fd = accept(listen_fd, nullptr, nullptr);
        if (client_fd < 0) continue;

        // Detach a thread per client; thread lifetime is short (one command exchange)
        std::thread([client_fd, &svc]() {
            handleClient(client_fd, svc);
        }).detach();
    }

    close(listen_fd);
    std::cout << "[Sequencer] Stopped." << std::endl;
    return 0;
}
