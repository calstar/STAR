/**
 * Switch Service: the DAQ end of the Bluetooth switch relay.
 *
 * Sends the switch list ([switch_roles.*] in config.toml, role index + MAC, no names) to the
 * environmental board as SWITCH_CONFIG every [switch_service].interval_ms. The board applies it
 * only when its hash differs from the one it holds, so the resend is free, and a board that
 * rebooted has its list back within one interval. The board keeps the list in memory only.
 *
 * Operator commands arrive from the backend on loopback UDP [switch_service].command_port, one
 * line "<command_id> <role> <output>", already gated there (approved operator, control on). Each
 * becomes one SWITCH_COMMAND to the board; the board answers SWITCH_COMMAND_RESULT, which
 * daq_bridge logs to Elodin [0x28, role]. Nothing is retried or queued here.
 *
 * Status flows the other way through daq_bridge (SWITCH_STATUS -> Elodin [0x27, role]).
 *
 * The service never commands a switch on its own (docs: firmware/Environmental Tracker/README):
 * every SWITCH_COMMAND it sends is a line the backend sent it.
 */

#include <arpa/inet.h>
#include <poll.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <string>
#include <thread>

#include "DiabloPacketUtils.h"
#include "config/Config.hpp"

namespace {
std::atomic<bool> g_running{true};
void on_signal(int) { g_running = false; }

uint32_t now_ms() {
    using namespace std::chrono;
    return static_cast<uint32_t>(
        duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}
}  // namespace

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--config" && i + 1 < argc)
            config_path = argv[++i];
        else if (a == "--help" || a == "-h") {
            std::cout << "Usage: " << argv[0] << " [--config PATH]\n";
            return 0;
        }
    }
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    const fsw::config::Config cfg = fsw::config::load(config_path);
    const auto& relay = cfg.switch_relay;
    if (!relay.enabled) {
        std::cout << "[SwitchService] [switch_service] is disabled in " << config_path << "\n";
        return 0;
    }
    if (!relay.errors.empty()) {
        // Never send a list we know is wrong: the board would connect to the wrong switches.
        for (const auto& e : relay.errors)
            std::cerr << "[SwitchService] config error: " << e << "\n";
        return 2;
    }
    const fsw::config::BoardConfig* env = fsw::config::switch_relay_board(cfg);

    const daq::SwitchConfig wire = fsw::config::switch_config_for(relay);
    char hash[9];
    std::snprintf(hash, sizeof hash, "%08x", daq::switch_config_hash(wire));
    std::cout << "[SwitchService] " << relay.roles.size() << " switch(es), list " << hash
              << ", to " << env->ip << ":" << env->send_port << " every " << relay.interval_ms
              << " ms\n";
    for (const auto& r : relay.roles) {
        char mac[18];
        std::snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x", r.mac[0], r.mac[1],
                      r.mac[2], r.mac[3], r.mac[4], r.mac[5]);
        std::cout << "  role " << int(r.role) << "  " << mac << "  " << r.name << "\n";
    }

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        perror("[SwitchService] socket");
        return 1;
    }
    sockaddr_in dst{};
    dst.sin_family = AF_INET;
    dst.sin_port = htons(env->send_port);
    if (inet_pton(AF_INET, env->ip.c_str(), &dst.sin_addr) != 1) {
        std::cerr << "[SwitchService] bad env board ip " << env->ip << "\n";
        return 2;
    }

    // Commands from the backend, loopback only.
    int cmd_sock = socket(AF_INET, SOCK_DGRAM, 0);
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = htons(relay.command_port);
    local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (cmd_sock < 0 || bind(cmd_sock, reinterpret_cast<sockaddr*>(&local), sizeof local) < 0) {
        perror("[SwitchService] bind command port");
        return 1;
    }
    std::cout << "[SwitchService] commands on 127.0.0.1:" << relay.command_port << "\n";

    uint8_t buf[64];
    uint32_t last_config = now_ms() - relay.interval_ms;
    while (g_running) {
        if (now_ms() - last_config >= relay.interval_ms) {
            last_config = now_ms();
            size_t n = daq::create_switch_config_packet(wire, last_config, buf, sizeof buf);
            if (n > 0 &&
                sendto(sock, buf, n, 0, reinterpret_cast<sockaddr*>(&dst), sizeof dst) < 0)
                perror("[SwitchService] sendto");
        }

        pollfd p{cmd_sock, POLLIN, 0};
        if (poll(&p, 1, 50) <= 0 || !(p.revents & POLLIN))
            continue;
        char line[128];
        ssize_t got = recv(cmd_sock, line, sizeof line - 1, 0);
        if (got <= 0)
            continue;
        line[got] = 0;
        if (std::string(line).rfind("discover", 0) == 0) {  // "Find switches": 10 s scan
            daq::SwitchDiscoverPacket d{10};
            size_t n = daq::create_switch_discover_packet(d, now_ms(), buf, sizeof buf);
            if (n > 0)
                sendto(sock, buf, n, 0, reinterpret_cast<sockaddr*>(&dst), sizeof dst);
            std::cout << "[SwitchService] discovery scan, 10 s\n";
            continue;
        }
        daq::SwitchCommandPacket cmd{};
        std::string why;
        if (!fsw::config::parse_switch_command(line, relay, cmd, why)) {
            std::cerr << "[SwitchService] refused command \"" << line << "\": " << why << "\n";
            continue;
        }
        size_t n = daq::create_switch_command_packet(cmd, now_ms(), buf, sizeof buf);
        bool sent = n > 0 &&
                    sendto(sock, buf, n, 0, reinterpret_cast<sockaddr*>(&dst), sizeof dst) >= 0;
        std::cout << "[SwitchService] command " << cmd.command_id << ": role " << int(cmd.role)
                  << (cmd.output ? " ARM" : " DISARM") << (sent ? "" : " (send failed)") << "\n";
    }
    close(cmd_sock);
    close(sock);
    return 0;
}
