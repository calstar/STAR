/**
 * Heartbeat Service — C++ SERVER_HEARTBEAT broadcaster.
 *
 * Subscribes to Elodin [0x5000] (SequencerState) for current state, maps it to
 * the legacy EngineState enum (0-4), and broadcasts SERVER_HEARTBEAT (type 2)
 * to all boards on the subnet every 1s.
 *
 * Packet: type(1)=2, version(1)=0, timestamp_ms(4 LE), engine_state(1)
 *
 * Usage: ./heartbeat_service [--config PATH] [--elodin-host HOST] [--elodin-port PORT]
 *        [--broadcast-ip IP] [--broadcast-port PORT] [--interval-ms MS]
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "config/Config.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "net/DaqInterface.hpp"

namespace {
std::atomic<bool> g_running{true};
std::atomic<uint8_t> g_engine_state{0};

// How long read_packet() waits before yielding so the loop can re-check g_running.
constexpr int kElodinRecvTimeoutMs = 3000;

void signalHandler(int /*sig*/) {
    std::cout << "\n[HeartbeatService] Shutting down..." << std::endl;
    g_running = false;
}

constexpr uint8_t SERVER_HEARTBEAT_TYPE = 2;
constexpr uint8_t DIABLO_VERSION = 0;

// ── sequencer::State → EngineState (DiabloEnums.h) ───────────────────────────
// EngineState: SAFE=0, PRESSURIZING=1, LOX_FILL=2, FIRING=3, POST_FIRE=4
// sequencer::State enum values (StateMachine.hpp):
//   DEBUG=0, IDLE=1, ARMED=2, FUEL_FILL=3, OX_FILL=4, GN2_LOW_PRESS=5,
//   GN2_VENT=6, FUEL_PRESS=7, FUEL_VENT=8, OX_PRESS=9, OX_VENT=10,
//   GN2_HIGH_PRESS=11, GN2_HIGH_VENT=12, VENT=13, CALIBRATE=14,
//   READY=15, FIRE=16, ENGINE_ABORT=17, GSE_ABORT=18, EMERGENCY_ABORT=19,
//   PRESS_STANDBY=20
static constexpr uint8_t stateToEngine(uint8_t s) {
    switch (s) {
        case 3:
            return 1;  // FUEL_FILL      → PRESSURIZING
        case 4:
            return 2;  // OX_FILL        → LOX_FILL
        case 5:
            return 1;  // GN2_LOW_PRESS  → PRESSURIZING
        case 6:
            return 1;  // GN2_VENT       → PRESSURIZING
        case 7:
            return 1;  // FUEL_PRESS     → PRESSURIZING
        case 8:
            return 1;  // FUEL_VENT      → PRESSURIZING
        case 9:
            return 1;  // OX_PRESS       → PRESSURIZING
        case 10:
            return 1;  // OX_VENT        → PRESSURIZING
        case 11:
            return 1;  // GN2_HIGH_PRESS → PRESSURIZING
        case 12:
            return 1;  // GN2_HIGH_VENT  → PRESSURIZING
        case 13:
            return 1;  // VENT           → PRESSURIZING
        case 15:
            return 1;  // READY          → PRESSURIZING
        case 16:
            return 3;  // FIRE           → FIRING
        case 20:
            return 1;  // PRESS_STANDBY  → PRESSURIZING
        default:
            return 0;  // DEBUG, IDLE, ARMED, CALIBRATE, ABORT states → SAFE
    }
}

// ── Elodin subscriber thread ──────────────────────────────────────────────────
// Subscribes to [0x50,0x00] (SequencerState) — the only table this service reads — extracts
// current_state and updates g_engine_state.
//
// This used to call subscribe_stream(), whose name and doc comment promised "all stream data" but
// which actually sent the calibration service's list: 480 raw sensor tables plus the calibration
// command table, and not [0x50,0x00]. The effect was silent and total — 481 ACKs for tables this
// thread discards, then a permanent block in read_packet() waiting for a table nobody was sending,
// with engine_state pinned at 0 through every state transition for the life of the process.
void elodinThread(std::string host, uint16_t port) {
    fsw::elodin::ElodinClient client;

    while (g_running) {
        if (!client.is_connected()) {
            if (!client.connect(host, port)) {
                std::this_thread::sleep_for(std::chrono::seconds(2));
                continue;
            }
            if (!client.subscribe_tables({fsw::elodin::kTableSequencerState})) {
                std::cerr << "[HeartbeatService] Failed to subscribe to SequencerState "
                             "[0x50,0x00] — engine_state will not track the sequencer"
                          << std::endl;
                client.disconnect();
                continue;
            }
            // Without a receive timeout read_packet() blocks forever, so the g_running check
            // above can never run and the thread cannot be shut down or re-subscribed.
            client.set_recv_timeout_ms(kElodinRecvTimeoutMs);
            std::cout << "[HeartbeatService] Elodin connected, subscribed to SequencerState"
                      << std::endl;
        }

        // Only [0x50,0x00] is subscribed, so the traffic here is one ~149-byte VTable definition
        // and 25-byte state updates. Sized well clear of both: read_packet() skips a packet that
        // does not fit rather than corrupting the stream, but a skipped state update is a stale
        // engine_state until the next one.
        uint8_t buf[4096];
        ssize_t n = client.read_packet(buf, sizeof(buf));
        if (n < 0) {
            // A read error leaves nothing useful on this socket. Drop it explicitly rather than
            // trusting is_connected(), which the read path does not always clear.
            std::cerr << "[HeartbeatService] Elodin read failed (" << client.last_error()
                      << ") — reconnecting" << std::endl;
            client.disconnect();
            continue;
        }
        if (n < 8)
            continue;  // 0 = receive timeout, nothing to do this round

        // SequencerState VTable: [0x50, 0x00]  (fsw::elodin::kTableSequencerState)
        // Payload: u64[0] ts | u8[8] current_state | pad[9..11] | u32[12] bitmask | u8[16]
        // debug_mode
        if (buf[5] == fsw::elodin::kTableSequencerState.first &&
            buf[6] == fsw::elodin::kTableSequencerState.second && n >= 8 + 9) {
            const uint8_t seq_state = buf[8 + 8];  // header(8) + payload[8]
            g_engine_state.store(stateToEngine(seq_state));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────

std::vector<uint8_t> buildHeartbeatPacket(uint8_t engine_state) {
    auto now = std::chrono::system_clock::now();
    auto ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() &
        0xFFFFFFFFu;
    return {
        SERVER_HEARTBEAT_TYPE,
        DIABLO_VERSION,
        static_cast<uint8_t>(ms >> 0),
        static_cast<uint8_t>(ms >> 8),
        static_cast<uint8_t>(ms >> 16),
        static_cast<uint8_t>(ms >> 24),
        engine_state,
    };
}

}  // namespace

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::optional<std::string> cli_elodin_host, cli_broadcast_ip;
    std::optional<int> cli_elodin_port, cli_interval_ms, cli_broadcast_port;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--elodin-host" && i + 1 < argc) {
            cli_elodin_host = argv[++i];
        } else if (arg == "--elodin-port" && i + 1 < argc) {
            cli_elodin_port = std::atoi(argv[++i]);
        } else if (arg == "--interval-ms" && i + 1 < argc) {
            cli_interval_ms = std::atoi(argv[++i]);
        } else if (arg == "--broadcast-ip" && i + 1 < argc) {
            cli_broadcast_ip = argv[++i];
        } else if (arg == "--broadcast-port" && i + 1 < argc) {
            cli_broadcast_port = std::atoi(argv[++i]);
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0]
                      << " [--config PATH] [--elodin-host HOST] [--elodin-port PORT]\n"
                         "       [--interval-ms MS] [--broadcast-ip IP] [--broadcast-port PORT]\n";
            return 0;
        }
    }

    // Resolve the config path against the usual fallback locations, then parse once.
    {
        std::ifstream f(config_path);
        if (!f.is_open()) {
            for (const auto& fp : {"config/config.toml", "../config/config.toml"}) {
                std::ifstream t(fp);
                if (t.is_open()) {
                    config_path = fp;
                    break;
                }
            }
        }
    }

    // Precedence: defaults < config file < CLI flags. (broadcast_ip/port fall back to
    // [server_heartbeat] inside the parser.)
    const fsw::config::Config cfg = fsw::config::load(config_path);
    std::string elodin_host = cli_elodin_host.value_or(cfg.heartbeat_service.elodin_host);
    uint16_t elodin_port = cli_elodin_port ? static_cast<uint16_t>(*cli_elodin_port)
                                           : cfg.heartbeat_service.elodin_port;
    int interval_ms =
        std::max(100, cli_interval_ms ? *cli_interval_ms
                                      : static_cast<int>(cfg.heartbeat_service.interval_ms));
    std::string broadcast_ip = cli_broadcast_ip.value_or(cfg.heartbeat_service.broadcast_ip);
    uint16_t broadcast_port = cli_broadcast_port ? static_cast<uint16_t>(*cli_broadcast_port)
                                                 : cfg.heartbeat_service.broadcast_port;

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // UDP broadcast socket
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "[HeartbeatService] socket() failed" << std::endl;
        return 1;
    }
    {
        int opt = 1;
        setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &opt, sizeof(opt));
    }

    // Pin the egress NIC. The destination is already subnet-directed, so this is belt-and-braces
    // against a host where the board subnet is reachable more than one way — but it also fixes
    // the source address the boards see. Not fatal: a heartbeat on an unknown interface beats
    // none.
    {
        const auto nic = fsw::net::resolveDaqBindAddress(cfg, "HeartbeatService");
        if (!nic.ok) {
            close(sock);
            return 1;
        }
        fsw::net::bindToDaqInterface(sock, nic.address, "HeartbeatService");
    }

    struct sockaddr_in dest;
    memset(&dest, 0, sizeof(dest));
    dest.sin_family = AF_INET;
    dest.sin_port = htons(broadcast_port);
    if (inet_pton(AF_INET, broadcast_ip.c_str(), &dest.sin_addr) != 1) {
        std::cerr << "[HeartbeatService] Invalid broadcast IP: " << broadcast_ip << std::endl;
        close(sock);
        return 1;
    }

    std::cout << "[HeartbeatService] Started — interval=" << interval_ms
              << "ms broadcast=" << broadcast_ip << ":" << broadcast_port << std::endl;
    std::cout << "[HeartbeatService] State from Elodin at " << elodin_host << ":" << elodin_port
              << " [0x5000]" << std::endl;

    // Start Elodin subscriber thread
    std::thread elodin_thread(elodinThread, elodin_host, elodin_port);

    unsigned long count = 0;
    auto last_log = std::chrono::steady_clock::now();

    while (g_running) {
        uint8_t engine_state = g_engine_state.load();
        auto pkt = buildHeartbeatPacket(engine_state);
        ssize_t sent = sendto(sock, pkt.data(), pkt.size(), 0,
                              reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
        if (sent == static_cast<ssize_t>(pkt.size()))
            count++;

        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - last_log).count() >= 10.0) {
            std::cout << "[HeartbeatService] Sent " << count
                      << " heartbeats (engine_state=" << (int)engine_state << ")" << std::endl;
            last_log = now;
        }

        for (int i = 0; g_running && i < interval_ms; i += 100)
            usleep(100000);
    }

    close(sock);
    elodin_thread.join();
    std::cout << "[HeartbeatService] Stopped." << std::endl;
    return 0;
}
