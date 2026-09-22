/**
 * Stacklight Service — C++ STACKLIGHT_COMMAND sender.
 *
 * Subscribes to Elodin [0x5000] (SequencerState) for current state, maps it to
 * a StacklightCommandPacket (red/yellow/green/buzzer), and sends it via UDP
 * unicast to the stacklight board whenever the state changes (plus a periodic
 * keepalive resend).
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
#include <sstream>
#include <string>
#include <thread>

#include "elodin/ElodinClient.hpp"
#include "DAQv2-Comms.h"
#include "control/StateMachine.hpp"

namespace {
std::atomic<bool> g_running{true};
std::atomic<uint8_t> g_seq_state{static_cast<uint8_t>(sequencer::State::UNKNOWN)};

void signalHandler(int /*sig*/) {
    std::cout << "\n[StacklightService] Shutting down..." << std::endl;
    g_running = false;
}

// ── sequencer::State → StacklightCommandPacket ──────────────────────────────
// Standard industrial convention: red = danger, yellow = caution,
// green = safe, buzzer = most urgent states (fire, abort).
Diablo::StacklightCommandPacket stateToStacklight(uint8_t s) {
    using sequencer::State;
    Diablo::StacklightCommandPacket cmd{0, 0, 0, 0};

    switch (static_cast<State>(s)) {
        case State::IDLE:
            cmd.green = 1;
            break;
        case State::DEBUG:
        case State::CALIBRATE:
        case State::GN2_VENT:
        case State::FUEL_VENT:
        case State::OX_VENT:
        case State::GN2_HIGH_VENT:
        case State::VENT:
            cmd.yellow = 1;
            break;
        case State::ARMED:
        case State::READY:
        case State::PRESS_STANDBY:
            cmd.red = 1;
            cmd.yellow = 1;
            break;
        case State::FUEL_FILL:
        case State::OX_FILL:
        case State::GN2_LOW_PRESS:
        case State::FUEL_PRESS:
        case State::OX_PRESS:
        case State::GN2_HIGH_PRESS:
            cmd.red = 1;
            break;
        case State::FIRE:
            cmd.red = 1;
            cmd.buzzer = 1;
            break;
        case State::ENGINE_ABORT:
        case State::GSE_ABORT:
        case State::EMERGENCY_ABORT:
            cmd.red = 1;
            cmd.buzzer = 1;
            break;
        case State::UNKNOWN:
        default:
            cmd.red = 1;
            cmd.yellow = 1;
            cmd.green = 1;
            cmd.buzzer = 1;
            break;
    }
    return cmd;
}

// ── Elodin subscriber thread ────────────────────────────────────────────────
void elodinThread(std::string host, uint16_t port) {
    fsw::elodin::ElodinClient client;

    while (g_running) {
        if (!client.is_connected()) {
            if (!client.connect(host, port)) {
                std::this_thread::sleep_for(std::chrono::seconds(2));
                continue;
            }
            client.subscribe_stream();
            std::cout << "[StacklightService] Elodin connected, subscribed" << std::endl;
        }

        uint8_t buf[256];
        ssize_t n = client.read_packet(buf, sizeof(buf));
        if (n < 0) continue; // reconnect next loop

        if (n < 8) continue;

        // SequencerState VTable: [0x50, 0x00]
        if (buf[5] == 0x50 && buf[6] == 0x00 && n >= 8 + 9) {
            const uint8_t seq_state = buf[8 + 8];
            g_seq_state.store(seq_state);
        }
    }
}

}

// ── Minimal TOML reader (mirrors heartbeat_service_main.cpp) ────────────────
std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

std::string getTomlValue(const std::string& content, const std::string& section,
                         const std::string& key, const std::string& fallback = "") {
    std::string sec_header = "[" + section + "]";
    auto sec_pos = content.find(sec_header);
    if (sec_pos == std::string::npos) return fallback;

    auto search_start = sec_pos + sec_header.size();
    auto next_sec = content.find("\n[", search_start);
    std::string sec_content = (next_sec == std::string::npos)
                                  ? content.substr(search_start)
                                  : content.substr(search_start, next_sec - search_start);

    std::istringstream iss(sec_content);
    std::string line;
    while (std::getline(iss, line)) {
        auto c = line.find('#');
        if (c != std::string::npos) line = line.substr(0, c);
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = trim(line.substr(0, eq));
        std::string v = trim(line.substr(eq + 1));
        if (k == key) return v;
    }
    return fallback;
}

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;
    int interval_ms = 1000; // keepalive resend interval
    std::string target_ip = "192.168.2.70";   // PLACEHOLDER — update once team assigns a real IP
    uint16_t target_port = 5006;              // PLACEHOLDER — update once team confirms

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--elodin-host" && i + 1 < argc) {
            elodin_host = argv[++i];
        } else if (arg == "--elodin-port" && i + 1 < argc) {
            elodin_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--interval-ms" && i + 1 < argc) {
            interval_ms = std::max(100, std::atoi(argv[++i]));
        } else if (arg == "--target-ip" && i + 1 < argc) {
            target_ip = argv[++i];
        } else if (arg == "--target-port" && i + 1 < argc) {
            target_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0]
                      << " [--config PATH] [--elodin-host HOST] [--elodin-port PORT]\n"
                         "       [--interval-ms MS] [--target-ip IP] [--target-port PORT]\n";
            return 0;
        }
    }

    // Load config file, falling back to a couple of common relative paths
    std::string config_content;
    {
        std::ifstream f(config_path);
        if (!f.is_open()) {
            for (const auto& fp : {"config/config.toml", "../config/config.toml"}) {
                f.open(fp);
                if (f.is_open()) { config_path = fp; break; }
            }
        }
        if (f.is_open()) {
            std::ostringstream ss;
            ss << f.rdbuf();
            config_content = ss.str();
        }
    }

    if (!config_content.empty()) {
        auto val = getTomlValue(config_content, "stacklight_service", "interval_ms", "");
        if (!val.empty()) { try { interval_ms = std::max(100, std::stoi(val)); } catch (...) {} }

        val = getTomlValue(config_content, "stacklight_service", "target_ip", "");
        if (!val.empty()) target_ip = val;

        val = getTomlValue(config_content, "stacklight_service", "target_port", "");
        if (!val.empty()) { try { target_port = static_cast<uint16_t>(std::stoi(val)); } catch (...) {} }

        val = getTomlValue(config_content, "stacklight_service", "elodin_host", "");
        if (!val.empty()) elodin_host = val;

        val = getTomlValue(config_content, "stacklight_service", "elodin_port", "");
        if (!val.empty()) { try { elodin_port = static_cast<uint16_t>(std::stoi(val)); } catch (...) {} }
    }

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // UDP unicast socket
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "[StacklightService] socket() failed" << std::endl;
        return 1;
    }

    struct sockaddr_in dest;
    memset(&dest, 0, sizeof(dest));
    dest.sin_family = AF_INET;
    dest.sin_port = htons(target_port);
    if (inet_pton(AF_INET, target_ip.c_str(), &dest.sin_addr) != 1) {
        std::cerr << "[StacklightService] Invalid target IP: " << target_ip << std::endl;
        close(sock);
        return 1;
    }

    std::cout << "[StacklightService] Started — interval=" << interval_ms
              << "ms target=" << target_ip << ":" << target_port << std::endl;
    std::cout << "[StacklightService] State from Elodin at " << elodin_host << ":" << elodin_port
              << " [0x5000]" << std::endl;

    std::thread elodin_thread(elodinThread, elodin_host, elodin_port);

        uint8_t last_sent_state = 0xFF; // sentinel value, forces the very first send
    unsigned long count = 0;
    auto last_log = std::chrono::steady_clock::now();
    auto last_send = std::chrono::steady_clock::now() - std::chrono::milliseconds(interval_ms);

    uint8_t buf[Diablo::MAX_PACKET_SIZE];

    while (g_running) {
        uint8_t seq_state = g_seq_state.load();
        auto now = std::chrono::steady_clock::now();
        bool state_changed = (seq_state != last_sent_state);
        bool keepalive_due =
            std::chrono::duration_cast<std::chrono::milliseconds>(now - last_send).count() >= interval_ms;

        if (state_changed || keepalive_due) {
            Diablo::StacklightCommandPacket cmd = stateToStacklight(seq_state);
            auto ts = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() & 0xFFFFFFFFu;

            size_t len = Diablo::create_stacklight_command_packet(cmd, static_cast<uint32_t>(ts),
                                                                    buf, sizeof(buf));
            if (len > 0) {
                ssize_t sent = sendto(sock, buf, len, 0,
                                      reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
                if (sent == static_cast<ssize_t>(len)) {
                    count++;
                    last_sent_state = seq_state;
                    last_send = now;
                }
            }
        }

        auto since_log = std::chrono::duration<double>(now - last_log).count();
        if (since_log >= 10.0) {
            std::cout << "[StacklightService] Sent " << count
                      << " commands (seq_state=" << (int)seq_state << ")" << std::endl;
            last_log = now;
        }

        usleep(100000); // check 10 times per second
    }

    close(sock);
    elodin_thread.join();
    std::cout << "[StacklightService] Stopped." << std::endl;
    return 0;
}