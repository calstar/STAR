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
 * Multiple simultaneous TCP clients are supported (a bounded, joined thread per connection).
 * Commands are not executed on those threads: each is posted to SequencerService's command queue
 * and run by its single worker, which is what serializes access to the state machine.
 *
 * Usage: ./sequencer_service [--config PATH] [--port PORT]
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "control/SequencerService.hpp"

namespace {
std::atomic<bool> g_running{true};

// Concurrent TCP clients accepted. The backend is the real client and holds one connection at a
// time, so this is a guard against runaway thread creation, not a capacity target — set well
// above any legitimate load. Previously unbounded.
constexpr size_t kMaxClients = 64;
// Longest command accepted before the connection is dropped, matching the old per-client cap.
constexpr size_t kMaxLineBytes = 512;

void signalHandler(int /*sig*/) {
    std::cout << "\n[Sequencer] Shutting down..." << std::endl;
    g_running = false;
}

std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

/**
 * Execute one newline-terminated command and write its reply.
 *
 * Does no state-machine work itself: every command below is posted to SequencerService's command
 * queue and executed by its single worker thread, which is what serializes them. This function
 * parses, dispatches, and replies.
 */
void handleCommandLine(int client_fd, const std::string& raw, sequencer::SequencerService& svc) {
    auto sendReply = [&](const std::string& msg) {
        send(client_fd, msg.c_str(), msg.size(), MSG_NOSIGNAL);
    };

    const std::string cmd = trim(raw);
    if (cmd.empty())
        return;

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
        const std::string rest = trim(cmd.substr(9));
        const size_t last_colon = rest.rfind(':');
        if (last_colon == std::string::npos || last_colon == 0) {
            sendReply("ERR:bad ACTUATOR format\n");
            return;
        }
        const std::string role_name = trim(rest.substr(0, last_colon));
        const std::string val_str = trim(rest.substr(last_colon + 1));
        int pos = -1;
        if (val_str == "1" || val_str == "open")
            pos = 1;
        else if (val_str == "0" || val_str == "closed")
            pos = 0;
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
        if (svc.extendFire())
            sendReply("OK\n");
        else
            sendReply("ERR:not in FIRE state\n");

        // ── RELOAD_CONFIG ────────────────────────────────────────────────────
    } else if (cmd == "RELOAD_CONFIG") {
        if (svc.reloadConfig())
            sendReply("OK\n");
        else
            sendReply("ERR:reload failed\n");

    } else {
        sendReply("ERR:unknown command\n");
    }
}

/**
 * One connection, on its own thread: read lines, dispatch, reply, until the peer closes.
 *
 * A thread per connection looks redundant now that SequencerService serializes everything on its
 * worker — and an earlier revision of this change did fold it into the accept loop. A stress run
 * showed why that was wrong: while the loop sits inside a command waiting for the worker, it is
 * not calling accept(), so new connections queue in the backlog and time out at the *client*
 * even though the service itself is healthy (600 concurrent transitions: 0 service-side timeouts,
 * 5 client-side ones, all of them accept latency). Serializing execution is the goal; serializing
 * *acceptance* was an accident.
 *
 * What the old version got wrong was not the threads, it was their lifetime: they were detached
 * while holding a reference to a stack-allocated service, so they could outlive it at shutdown,
 * and nothing bounded how many existed. Both are handled by the caller now — threads are counted
 * and joined.
 */
void handleClient(int client_fd, sequencer::SequencerService& svc) {
    // 5-second receive timeout, so a silent peer cannot pin this thread forever.
    struct timeval tv{.tv_sec = 5, .tv_usec = 0};
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    std::string buf;
    while (g_running) {
        char tmp[512];
        ssize_t n = recv(client_fd, tmp, sizeof(tmp), 0);
        if (n <= 0)
            break;  // peer closed, timed out, or shutdown() woke us
        buf.append(tmp, static_cast<size_t>(n));

        size_t nl;
        while ((nl = buf.find('\n')) != std::string::npos) {
            const std::string line = buf.substr(0, nl);
            buf.erase(0, nl + 1);
            handleCommandLine(client_fd, line, svc);
        }
        if (buf.size() > kMaxLineBytes) {
            std::cerr << "[Sequencer] oversized command — dropping connection" << std::endl;
            break;
        }
    }
    close(client_fd);
}
}  // namespace

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    uint16_t listen_port = 9998;

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

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);
    signal(SIGPIPE, SIG_IGN);  // don't crash on broken TCP connections

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
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(listen_port);
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

    // Connections are tracked rather than detached, so every thread is joined before `svc` — a
    // stack object these threads hold a reference to — goes out of scope at the end of main().
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

        // select() with 10 ms timeout — keeps g_running check while staying low-latency
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(listen_fd, &rd);
        struct timeval tv{.tv_sec = 0, .tv_usec = 10000};
        if (select(listen_fd + 1, &rd, nullptr, nullptr, &tv) <= 0)
            continue;

        int client_fd = accept(listen_fd, nullptr, nullptr);
        if (client_fd < 0)
            continue;

        // Reap again before testing the cap: a burst of short-lived connections arriving inside
        // one select() iteration would otherwise be counted against the limit even though those
        // threads have already finished.
        reap_finished();
        if (conns.size() >= kMaxClients) {
            // Say why, rather than closing cold — a bare close() reaches the client as a TCP
            // reset, which is indistinguishable from the service having crashed.
            static const char kBusy[] = "ERR:too many connections\n";
            send(client_fd, kBusy, sizeof(kBusy) - 1, MSG_NOSIGNAL);
            std::cerr << "[Sequencer] client limit (" << kMaxClients
                      << ") reached — refusing connection" << std::endl;
            close(client_fd);
            continue;
        }

        auto conn = std::make_unique<Conn>();
        conn->fd = client_fd;
        Conn* raw = conn.get();
        conn->th = std::thread([raw, &svc]() {
            handleClient(raw->fd, svc);
            raw->done = true;
        });
        conns.push_back(std::move(conn));
    }

    // Wake any thread parked in recv() so shutdown does not wait out its 5 s timeout, then join
    // them all. Joining before returning is what keeps `svc` alive until nothing references it.
    for (const auto& c : conns)
        shutdown(c->fd, SHUT_RDWR);
    for (const auto& c : conns)
        if (c->th.joinable())
            c->th.join();

    close(listen_fd);
    std::cout << "[Sequencer] Stopped." << std::endl;
    return 0;
}
