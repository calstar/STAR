/**
 * Config Broadcast Service — C++ ACTUATOR_CONFIG / SENSOR_CONFIG broadcaster.
 *
 * Builds packets from config.toml and calibration JSON, sends via UDP to boards.
 * Flight-ready replacement for Python config_broadcast_service.py.
 *
 * Usage: ./config_broadcast_service [--config PATH] [--interval-ms MS]
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "config/Config.hpp"

namespace {
std::atomic<bool> g_running{true};

void signalHandler(int /*sig*/) {
    std::cout << "\n[ConfigBroadcast] Shutting down..." << std::endl;
    g_running = false;
}

constexpr uint8_t SENSOR_CONFIG = 5;
constexpr uint8_t ACTUATOR_CONFIG = 6;
constexpr uint16_t DEFAULT_LISTEN_PORT = 5005;

std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

uint32_t ipToU32Le(const std::string& ip) {
    int a = 0, b = 0, c = 0, d = 0;
    if (sscanf(ip.c_str(), "%d.%d.%d.%d", &a, &b, &c, &d) != 4)
        return 0;
    return (static_cast<uint32_t>(a) << 24) | (static_cast<uint32_t>(b) << 16) |
           (static_cast<uint32_t>(c) << 8) | static_cast<uint32_t>(d);
}

uint32_t ipToU32Be(const std::string& ip) {
    return ipToU32Le(ip);
}

struct BoardInfo {
    int id;
    std::string ip;
    std::string type;
    bool enabled;
    bool designated_survivor;
    bool necessary_for_abort;
    int voltage_reference;
    // Serial-print / log-stream mode byte (0..3): 0 USB Tier-1, 1 USB verbose,
    // 2 stream Tier-1, 3 stream Tier-1+2. Sent verbatim as the config packet's
    // enable_serial_printing byte; the firmware interprets it as the mode.
    int enable_serial_printing;
    std::vector<int> active_connectors;
    int num_sensors;
    uint16_t listen_port;
};

void parseVentAbortFromCsv(const std::string& csv_path, std::map<std::string, int>& vent_map,
                           std::map<std::string, int>& abort_map) {
    std::ifstream f(csv_path);
    if (!f.is_open())
        return;
    std::string line;
    if (!std::getline(f, line))
        return;
    std::vector<std::string> headers;
    std::istringstream iss(line);
    std::string cell;
    while (std::getline(iss, cell, ','))
        headers.push_back(trim(cell));

    int vent_col = -1, abort_col = -1;
    for (size_t i = 1; i < headers.size(); ++i) {
        if (headers[i] == "Vent")
            vent_col = static_cast<int>(i);
        if (headers[i] == "Engine Abort")
            abort_col = static_cast<int>(i);
    }
    if (vent_col < 0 || abort_col < 0)
        return;

    while (std::getline(f, line)) {
        std::vector<std::string> cells;
        std::istringstream is(line);
        while (std::getline(is, cell, ','))
            cells.push_back(trim(cell));
        if (cells.size() <= static_cast<size_t>(std::max(vent_col, abort_col)))
            continue;
        std::string name = cells[0];
        if (name.empty() || name == "Test Actuator 2")
            continue;
        std::string v = cells[vent_col];
        std::string a = cells[abort_col];
        std::transform(v.begin(), v.end(), v.begin(), ::toupper);
        std::transform(a.begin(), a.end(), a.begin(), ::toupper);
        vent_map[name] = (v == "OPEN") ? 1 : 0;
        abort_map[name] = (a == "OPEN") ? 1 : 0;
    }
}

// One UDP packet to send: (packet type, bytes, dest IP, dest port).
using ConfigPacket = std::tuple<uint8_t, std::vector<uint8_t>, std::string, uint16_t>;

// Read config.toml fresh and build the full SENSOR_CONFIG/ACTUATOR_CONFIG packet set.
// Called every broadcast cycle so board edits (roles, active_connectors, voltage_reference,
// abort thresholds, enable flags) go live without restarting the service or a session.
// Returns an empty vector on any failure (missing/truncated file, no designated survivor);
// the caller keeps the last-good set rather than dropping board config for a cycle.
std::vector<ConfigPacket> buildPackets(const std::string& config_path) {
    const fsw::config::Config cfg = fsw::config::load(config_path);

    // Map typed boards -> local BoardInfo (expand active_connectors, synthesize ip like the old
    // parser).
    std::vector<BoardInfo> boards;
    for (const auto& b : cfg.boards) {
        std::vector<int> active = b.active_connectors;
        if (active.empty())
            for (int i = 1; i <= b.num_sensors; ++i)
                active.push_back(i);
        std::string ip = b.ip;
        if (ip.empty() && b.board_id > 0)
            ip = "192.168.2." + std::to_string(b.board_id);
        boards.push_back({b.board_id, ip, b.type, b.enabled, b.designated_survivor,
                          b.necessary_for_abort, b.voltage_reference, b.enable_serial_printing,
                          active, b.num_sensors, b.listen_port});
    }

    std::string designated_ip;
    int designated_id = -1;
    for (const auto& b : boards) {
        if (b.enabled && b.type == "ACTUATOR" && b.designated_survivor) {
            designated_ip = b.ip;
            designated_id = b.id;
            break;
        }
    }
    // No designated survivor → treat as a bad/partial read and keep last-good.
    if (designated_ip.empty())
        return {};

    std::map<int, std::string> board_id_to_ip;
    for (const auto& b : boards)
        if (b.id > 0)
            board_id_to_ip[b.id] = b.ip;

    std::map<std::string, int> vent_map, abort_map;
    std::string csv_path = cfg.state_machine.actuator_csv;
    const char* csv_fbs[] = {
        "config/state_machine_actuators.csv",
        "../config/state_machine_actuators.csv",
        "../../config/state_machine_actuators.csv",
    };
    for (const char* fb : csv_fbs) {
        std::ifstream t(fb);
        if (t.is_open()) {
            csv_path = fb;
            break;
        }
    }
    parseVentAbortFromCsv(csv_path, vent_map, abort_map);

    const std::map<std::string, double>& abort_pts = cfg.abort_pts;

    std::map<std::string, std::tuple<int, int, bool>> actuator_roles;
    for (const auto& [name, r] : cfg.actuator_roles)
        if (r.channel >= 1 && r.channel <= 255)
            actuator_roles[name] = {r.channel, r.board_id > 0 ? r.board_id : 12, r.is_no};

    // Autonomous overpressure abort thresholds: invert each abort PSI to a raw ADC code through the
    // SAME per-sensor model the calibration service streams to the GUI, so a board trips at the ADC
    // that matches the pressure the operator sees. This used to invert a factory
    // PTCalibrationManager that the physics-or-nothing deploy does not ship (and that deliberately
    // excludes the operator cubic) — every lookup returned null, each abort sensor was silently
    // skipped, and the ACTUATOR_CONFIG packet carried zero thresholds: the hardware overpressure
    // net was simply absent. A threshold that cannot be computed is now logged loudly and omitted
    // (no board trip for that one sensor) rather than shipped wrong or dropped in silence.
    //
    // Only ratiometric-physics (0-5 V) inversion is implemented: adc = psi/full_scale * 2^31, the
    // exact inverse of the calibration service's convert_ratiometric_pt_to_pressure. A sensor whose
    // model is cubic/robust/blend, or that sits on a 4-20 mA board, is refused here (set its
    // calibration_model to "physics" for a board trip, or it has none) — inverting the operator
    // cubic or the current-loop curve would duplicate that math and is left as a follow-up. Both
    // shipped rigs' abort PTs are ratiometric physics.
    std::vector<std::tuple<uint32_t, uint8_t, uint32_t>> abort_pt_list;
    std::set<std::string> abort_warnings;
    for (const auto& [sensor_name, threshold_psi] : abort_pts) {
        const std::string tag = "[ConfigBroadcast] abort_pts \"" + sensor_name + "\": ";
        bool resolved_role = false;
        for (const auto& b : cfg.boards) {
            if (b.type != "PT" || !b.enabled || b.board_id <= 0)
                continue;
            const std::string board_key =
                b.section.rfind("boards.", 0) == 0 ? b.section.substr(7) : b.section;
            const auto* roles = cfg.sensor_roles_for("sensor_roles_" + board_key);
            if (roles == nullptr)
                continue;
            auto rit = roles->find(sensor_name);
            if (rit == roles->end())
                continue;  // not on this board — keep looking
            resolved_role = true;
            const int channel = rit->second;
            if (channel < 1 || channel > 255) {
                abort_warnings.insert(tag + "channel out of range — NO board overpressure trip");
                break;
            }
            // Interface + model + full-scale resolved exactly as calibration_main does, so the trip
            // ADC lands on the same curve the operator reads.
            const bool is_loop = b.has_hp_pt_keys || b.pt_type == "4-20 mA absolute";
            std::string model = is_loop ? "physics" : "cubic";  // interface-aware default
            if (const auto* models = cfg.calibration_model_for("calibration_model_" + board_key)) {
                auto mit = models->find(sensor_name);
                if (mit != models->end())
                    model = mit->second;
            }
            double full_scale = is_loop ? b.hp_pt_full_scale_psi : 1000.0;
            if (const auto* fss = cfg.full_scale_for("calibration_full_scale_" + board_key)) {
                auto fit = fss->find(sensor_name);
                if (fit != fss->end() && fit->second > 0.0)
                    full_scale = fit->second;
            }

            if (model != "physics" || is_loop) {
                abort_warnings.insert(
                    tag + "model \"" + model + (is_loop ? " (4-20 mA)" : "") +
                    "\" cannot be inverted for a board trip — set "
                    "calibration_model = \"physics\", or this sensor has NO trip");
                break;
            }
            if (!(full_scale > 0.0) || !(threshold_psi > 0.0)) {
                abort_warnings.insert(tag + "non-positive full_scale/threshold — NO board trip");
                break;
            }
            constexpr double ADC_MAX = 2147483648.0;  // 2^31
            double adc = std::clamp((threshold_psi / full_scale) * ADC_MAX, 0.0, ADC_MAX - 1.0);
            abort_pt_list.push_back({ipToU32Le(b.ip), static_cast<uint8_t>(channel),
                                     static_cast<uint32_t>(llround(adc))});
            break;  // handled on its owning board
        }
        if (!resolved_role)
            abort_warnings.insert(tag + "no PT sensor_role declares this name — NO board trip");
    }
    // Log each distinct abort-threshold problem once while it persists, and note recovery — never
    // spam the every-cycle rebuild. Dropping resolved entries lets a re-break warn again.
    {
        static std::set<std::string> s_last_abort_warnings;
        for (const auto& w : abort_warnings)
            if (s_last_abort_warnings.count(w) == 0)
                std::cerr << "⚠️  " << w << std::endl;
        if (abort_warnings.empty() && !s_last_abort_warnings.empty())
            std::cout << "[ConfigBroadcast] all abort_pts thresholds resolved" << std::endl;
        s_last_abort_warnings = abort_warnings;
    }

    auto build_actuator_config = [&](int is_abort_controller,
                                     int enable_serial) -> std::vector<uint8_t> {
        std::vector<std::tuple<uint32_t, uint8_t, uint8_t, uint8_t>> abort_actuators;
        for (const auto& [name, tup] : actuator_roles) {
            int ch = std::get<0>(tup), bid = std::get<1>(tup);
            std::string ip = board_id_to_ip.count(bid) ? board_id_to_ip[bid] : designated_ip;
            uint8_t vent = static_cast<uint8_t>(vent_map.count(name) ? vent_map[name] : 0);
            uint8_t abort = static_cast<uint8_t>(abort_map.count(name) ? abort_map[name] : 0);
            abort_actuators.push_back({ipToU32Le(ip), static_cast<uint8_t>(ch), vent, abort});
        }

        size_t N = std::min(abort_actuators.size(), size_t(255));
        size_t X = std::min(abort_pt_list.size(), size_t(255));
        size_t body = 1 + 1 + N * 7 + 1 + X * 9 + 1;
        size_t total = 6 + body;

        std::vector<uint8_t> buf(total);
        buf[0] = ACTUATOR_CONFIG;
        buf[1] = 0;
        *reinterpret_cast<uint32_t*>(&buf[2]) = 0;

        size_t off = 6;
        buf[off++] = static_cast<uint8_t>(is_abort_controller);
        buf[off++] = static_cast<uint8_t>(N);
        for (size_t i = 0; i < N; ++i) {
            auto [ip, aid, vent, abort] = abort_actuators[i];
            *reinterpret_cast<uint32_t*>(&buf[off]) = ip;
            off += 4;
            buf[off++] = aid;
            buf[off++] = vent;
            buf[off++] = abort;
        }
        buf[off++] = static_cast<uint8_t>(X);
        for (size_t i = 0; i < X; ++i) {
            auto [ip, sid, adc] = abort_pt_list[i];
            *reinterpret_cast<uint32_t*>(&buf[off]) = ip;
            off += 4;
            buf[off++] = sid;
            *reinterpret_cast<uint32_t*>(&buf[off]) = adc;
            off += 4;
        }
        buf[off] = static_cast<uint8_t>(enable_serial);  // mode byte 0..3
        return buf;
    };

    auto build_sensor_config = [&](const BoardInfo& b) -> std::vector<uint8_t> {
        std::vector<uint8_t> channels;
        for (int c : b.active_connectors)
            if (c >= 1 && c <= 255)
                channels.push_back(static_cast<uint8_t>(c));
        size_t num = std::min(channels.size(), size_t(255));
        size_t body = 1 + num + 1 + 1 + (b.necessary_for_abort ? 4 : 0) + 1;
        size_t total = 6 + body;

        std::vector<uint8_t> buf(total);
        buf[0] = SENSOR_CONFIG;
        buf[1] = 0;
        *reinterpret_cast<uint32_t*>(&buf[2]) = 0;

        size_t off = 6;
        buf[off++] = static_cast<uint8_t>(num);
        for (size_t i = 0; i < num; ++i)
            buf[off++] = channels[i];
        buf[off++] = static_cast<uint8_t>(std::min(2, std::max(0, b.voltage_reference)));
        buf[off++] = b.necessary_for_abort ? 1 : 0;
        if (b.necessary_for_abort) {
            uint32_t ip_be = ipToU32Be(designated_ip);
            buf[off] = (ip_be >> 24) & 0xFF;
            buf[off + 1] = (ip_be >> 16) & 0xFF;
            buf[off + 2] = (ip_be >> 8) & 0xFF;
            buf[off + 3] = ip_be & 0xFF;
            off += 4;
        }
        buf[off] = static_cast<uint8_t>(b.enable_serial_printing);  // mode byte 0..3
        return buf;
    };

    std::vector<ConfigPacket> packets;
    for (const auto& b : boards) {
        if (!b.enabled)
            continue;
        if (b.type == "ACTUATOR") {
            int is_abort = (b.id == designated_id) ? 1 : 0;
            auto pkt = build_actuator_config(is_abort, b.enable_serial_printing);
            if (!pkt.empty())
                packets.push_back({ACTUATOR_CONFIG, pkt, b.ip, b.listen_port});
        } else if (b.type == "PT" || b.type == "TC" || b.type == "RTD" || b.type == "LC" ||
                   b.type == "ENCODER") {
            auto pkt = build_sensor_config(b);
            packets.push_back({SENSOR_CONFIG, pkt, b.ip, b.listen_port});
        }
    }
    return packets;
}

}  // namespace

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    int interval_ms = -1;  // -1 = use config

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc)
            config_path = argv[++i];
        else if (arg == "--interval-ms" && i + 1 < argc)
            interval_ms = std::max(500, std::atoi(argv[++i]));
        else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0] << " [--config PATH] [--interval-ms MS]\n";
            return 0;
        }
    }

    std::string config_content;
    {
        std::ifstream f(config_path);
        if (!f.is_open()) {
            for (const auto& fp : {"config/config.toml", "../config/config.toml"}) {
                f.open(fp);
                if (f.is_open()) {
                    config_path = fp;
                    break;
                }
            }
        }
        if (f.is_open()) {
            std::ostringstream ss;
            ss << f.rdbuf();
            config_content = ss.str();
        }
    }

    if (config_content.empty()) {
        std::cerr << "[ConfigBroadcast] No config loaded" << std::endl;
        return 1;
    }

    // Precedence: defaults < config < CLI (--interval-ms). Config value clamped to >=500 ms.
    if (interval_ms < 0) {
        const fsw::config::Config cfg = fsw::config::load(config_path);
        interval_ms = std::max(500, static_cast<int>(cfg.config_broadcast_interval_ms));
    }

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Packets (including abort thresholds) are rebuilt from the live config every cycle (below) so
    // board and calibration edits apply with no restart / no session.
    auto packets = buildPackets(config_path);
    if (packets.empty())
        std::cerr << "[ConfigBroadcast] No packets from config yet (no designated_survivor?); "
                     "retrying each cycle"
                  << std::endl;

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "[ConfigBroadcast] socket() failed" << std::endl;
        return 1;
    }

    struct sockaddr_in dest;
    memset(&dest, 0, sizeof(dest));
    dest.sin_family = AF_INET;

    std::cout << "[ConfigBroadcast] Started — interval=" << interval_ms
              << "ms (C++ standalone, live config reload)" << std::endl;
    std::cout << "[ConfigBroadcast] " << packets.size() << " packet types" << std::endl;

    unsigned long total_sent = 0;
    // Per-destination send accounting. The single global counter could not distinguish
    // "all 8 boards got their config" from "the same board got it 8 times".
    std::map<std::string, unsigned long> tx_ok, tx_fail, tx_bad_addr;
    std::map<std::string, size_t> tx_bytes;
    std::map<std::string, uint8_t> tx_type;
    auto last_log = std::chrono::steady_clock::now();

    while (g_running) {
        // Re-read config.toml and rebuild each cycle so board edits go live. Keep the
        // last-good set if a read is empty/mid-write (buildPackets returns {} on failure).
        auto fresh = buildPackets(config_path);
        if (!fresh.empty())
            packets.swap(fresh);

        for (const auto& [pkt_type, pkt, ip, listen_port] : packets) {
            const std::string dest_key = ip + ":" + std::to_string(listen_port);
            if (inet_pton(AF_INET, ip.c_str(), &dest.sin_addr) != 1) {
                tx_bad_addr[dest_key]++;
                continue;
            }
            dest.sin_port = htons(listen_port);
            errno = 0;
            ssize_t sent = sendto(sock, pkt.data(), pkt.size(), 0,
                                  reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
            if (sent == static_cast<ssize_t>(pkt.size())) {
                total_sent++;
                tx_ok[dest_key]++;
                tx_bytes[dest_key] = pkt.size();
                tx_type[dest_key] = pkt_type;
            } else {
                // A short or failed send is the whole bug class we are chasing: the old code
                // counted only successes, so a silently dropped packet looked identical to a
                // delivered one. Report errno the first time and then once per 10s per dest.
                tx_fail[dest_key]++;
                int e = errno;
                if (tx_fail[dest_key] == 1 || tx_fail[dest_key] % 10 == 0) {
                    std::cerr << "[ConfigBroadcast] ✗ sendto(" << dest_key
                              << ") type=" << (int)pkt_type << " len=" << pkt.size() << " returned "
                              << sent << " errno=" << e << " (" << std::strerror(e) << ")"
                              << std::endl;
                }
            }
        }

        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - last_log).count() >= 10.0) {
            std::cout << "[ConfigBroadcast] Sent " << total_sent << " packets total ("
                      << packets.size() << " dests this cycle)" << std::endl;
            for (const auto& [dkey, n] : tx_ok) {
                std::cout << "   → " << dkey << "  type=" << (int)tx_type[dkey]
                          << " len=" << tx_bytes[dkey] << "  ok=" << n << " fail=" << tx_fail[dkey]
                          << std::endl;
            }
            for (const auto& [dkey, n] : tx_fail)
                if (tx_ok.find(dkey) == tx_ok.end())
                    std::cout << "   → " << dkey << "  ok=0 fail=" << n << std::endl;
            for (const auto& [dkey, n] : tx_bad_addr)
                std::cout << "   → " << dkey << "  INVALID ADDRESS, never sent (n=" << n << ")"
                          << std::endl;
            last_log = now;
        }

        for (int i = 0; g_running && i < interval_ms; i += 100)
            usleep(100000);
    }

    close(sock);
    std::cout << "[ConfigBroadcast] Stopped." << std::endl;
    return 0;
}
