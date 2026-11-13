/**
 * Switch Service: the DAQ end of the Bluetooth switch relay.
 *
 * Sends the switch list ([switch_roles.*] in config.toml, role index + MAC, no names) to the
 * environmental board as SWITCH_CONFIG every [switch_service].interval_ms. The board applies it
 * only when its hash differs from the one it holds, so the resend is free, and a board that
 * rebooted has its list back within one interval. The board keeps the list in memory only.
 *
 * Status flows the other way through daq_bridge (SWITCH_STATUS -> Elodin [0x27, role]).
 *
 * The service never commands a switch on its own (docs: firmware/Environmental Tracker/README).
 */

#include <arpa/inet.h>
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

    uint8_t buf[64];
    while (g_running) {
        size_t n = daq::create_switch_config_packet(wire, now_ms(), buf, sizeof buf);
        if (n > 0 &&
            sendto(sock, buf, n, 0, reinterpret_cast<sockaddr*>(&dst), sizeof dst) < 0)
            perror("[SwitchService] sendto");
        for (uint32_t waited = 0; g_running && waited < relay.interval_ms; waited += 50)
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    close(sock);
    return 0;
}
