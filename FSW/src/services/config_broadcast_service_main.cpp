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
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "calibration/PTCalibration.hpp"

namespace {
std::atomic<bool> g_running{true};

void signalHandler(int /*sig*/) {
    std::cout << "\n[ConfigBroadcast] Shutting down..." << std::endl;
    g_running = false;
}

constexpr uint8_t SENSOR_CONFIG = 5;
constexpr uint8_t ACTUATOR_CONFIG = 6;
constexpr uint16_t TARGET_PORT = 5005;

std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

std::string getTomlValue(const std::string& content, const std::string& section,
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
    bool enable_serial_printing;
    std::vector<int> active_connectors;
    int num_sensors;
};

void parseActuatorRole(const std::string& val, int& channel, int& board_id, bool& is_no) {
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

std::vector<BoardInfo> parseBoards(const std::string& content) {
    std::vector<BoardInfo> boards;
    size_t pos = 0;
    while ((pos = content.find("[boards.", pos)) != std::string::npos) {
        size_t end = content.find(']', pos);
        if (end == std::string::npos)
            break;
        std::string sec = content.substr(pos + 1, end - pos - 1);
        std::string type = getTomlValue(content, sec, "type", "");
        std::string ip = getTomlValue(content, sec, "ip", "");
        std::string id_str =
            getTomlValue(content, sec, "board_id", getTomlValue(content, sec, "id", "0"));
        bool enabled = getTomlValue(content, sec, "enabled", "true") != "false";
        bool designated = getTomlValue(content, sec, "designated_survivor", "false") == "true";
        bool nec_abort = getTomlValue(content, sec, "necessary_for_abort", "false") == "true";
        int ref = 0;
        try {
            ref = std::stoi(getTomlValue(content, sec, "voltage_reference", "0"));
        } catch (...) {
        }
        bool ser = getTomlValue(content, sec, "enable_serial_printing", "false") == "true";
        int num_sens = 10;
        try {
            num_sens = std::stoi(getTomlValue(content, sec, "num_sensors", "10"));
        } catch (...) {
        }

        std::vector<int> active;
        std::string active_str = getTomlValue(content, sec, "active_connectors", "");
        if (!active_str.empty()) {
            size_t p = active_str.find('[');
            if (p != std::string::npos) {
                p++;
                while (p < active_str.size()) {
                    while (p < active_str.size() && (active_str[p] == ' ' || active_str[p] == ','))
                        p++;
                    if (p >= active_str.size())
                        break;
                    size_t e = active_str.find_first_of(",]", p);
                    if (e == std::string::npos)
                        e = active_str.size();
                    try {
                        active.push_back(std::stoi(trim(active_str.substr(p, e - p))));
                    } catch (...) {
                    }
                    p = e + 1;
                }
            }
        }
        if (active.empty())
            for (int i = 1; i <= num_sens; ++i)
                active.push_back(i);

        int bid = 0;
        try {
            bid = std::stoi(id_str);
        } catch (...) {
        }
        if (ip.empty() && bid > 0)
            ip = "192.168.2." + std::to_string(bid);

        boards.push_back(
            {bid, ip, type, enabled, designated, nec_abort, ref, ser, active, num_sens});
        pos = end + 1;
    }
    return boards;
}

std::map<std::string, int> parseSensorRoles(const std::string& content,
                                            const std::string& section) {
    std::map<std::string, int> out;
    std::string sec_header = "[" + section + "]";
    auto sec_pos = content.find(sec_header);
    if (sec_pos == std::string::npos)
        return out;
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
        std::string key = trim(line.substr(0, eq));
        std::string val = trim(line.substr(eq + 1));
        if (key.size() >= 2 && key.front() == '"' && key.back() == '"')
            key = key.substr(1, key.size() - 2);
        try {
            out[key] = std::stoi(val);
        } catch (...) {
        }
    }
    return out;
}

std::map<std::string, double> parseAbortPts(const std::string& content) {
    std::map<std::string, double> out;
    std::string sec_content;
    auto pos = content.find("[abort_pts]");
    if (pos == std::string::npos)
        return out;
    pos += 11;
    auto next = content.find("\n[", pos);
    sec_content =
        (next == std::string::npos) ? content.substr(pos) : content.substr(pos, next - pos);

    std::istringstream iss(sec_content);
    std::string line;
    while (std::getline(iss, line)) {
        auto c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
        auto eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string key = trim(line.substr(0, eq));
        std::string val = trim(line.substr(eq + 1));
        if (key.size() >= 2 && key.front() == '"' && key.back() == '"')
            key = key.substr(1, key.size() - 2);
        try {
            out[key] = std::stod(val);
        } catch (...) {
        }
    }
    return out;
}

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

    if (interval_ms < 0 && !config_content.empty()) {
        std::string val =
            getTomlValue(config_content, "config_broadcast_service", "interval_ms", "");
        if (!val.empty()) {
            try {
                interval_ms = std::max(500, std::stoi(val));
            } catch (...) {
            }
        }
    }
    if (interval_ms < 0)
        interval_ms = 1000;

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    auto boards = parseBoards(config_content);
    std::string designated_ip;
    int designated_id = -1;
    for (const auto& b : boards) {
        if (b.enabled && b.type == "ACTUATOR" && b.designated_survivor) {
            designated_ip = b.ip;
            designated_id = b.id;
            break;
        }
    }

    if (designated_ip.empty()) {
        std::cerr << "[ConfigBroadcast] No designated_survivor actuator board" << std::endl;
        return 1;
    }

    std::map<int, std::string> board_id_to_ip;
    for (const auto& b : boards)
        if (b.id > 0)
            board_id_to_ip[b.id] = b.ip;

    std::map<std::string, int> vent_map, abort_map;
    std::string csv_path = getTomlValue(config_content, "state_machine", "actuator_csv",
                                        "config/state_machine_actuators.csv");
    const char* csv_fbs[] = {
        "config/state_machine_actuators.csv",
        "../config/state_machine_actuators.csv",
        "external/DiabloAvionics/test_guis/state_machine_actuators.csv",
    };
    for (const char* fb : csv_fbs) {
        std::ifstream t(fb);
        if (t.is_open()) {
            csv_path = fb;
            break;
        }
    }
    parseVentAbortFromCsv(csv_path, vent_map, abort_map);

    auto sensor_roles = parseSensorRoles(config_content, "sensor_roles_pt_board");
    if (sensor_roles.empty())
        sensor_roles = parseSensorRoles(config_content, "sensor_roles");
    auto abort_pts = parseAbortPts(config_content);

    fsw::calibration::PTCalibrationManager::set_default_paths(
        "scripts/calibration/calibrations",
        "external/DiabloAvionics/PT_Board/Calibration/PT Calibration Attempt 2026-02-04_test2.csv");
    fsw::calibration::PTCalibrationManager pt_cal;
    pt_cal.load_calibration();

    std::string current_section;
    std::map<std::string, std::tuple<int, int, bool>> actuator_roles;
    std::istringstream cfg(config_content);
    std::string line, cell;
    while (std::getline(cfg, line)) {
        auto c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
        if (line.size() >= 2 && line[0] == '[') {
            size_t end = line.find(']');
            current_section = (end != std::string::npos) ? line.substr(1, end - 1) : "";
            continue;
        }
        auto eq = line.find('=');
        if (eq == std::string::npos || current_section != "actuator_roles")
            continue;
        std::string key = trim(line.substr(0, eq));
        std::string val = trim(line.substr(eq + 1));
        if (key.size() >= 2 && key.front() == '"' && key.back() == '"')
            key = key.substr(1, key.size() - 2);
        int ch = 0, bid = 0;
        bool is_no = false;
        parseActuatorRole(val, ch, bid, is_no);
        if (ch >= 1 && ch <= 255)
            actuator_roles[key] = {ch, bid > 0 ? bid : 12, is_no};
    }

    std::vector<std::tuple<uint8_t, std::vector<uint8_t>, std::string>> packets;

    auto build_actuator_config = [&](int is_abort_controller,
                                     bool enable_serial) -> std::vector<uint8_t> {
        std::vector<std::tuple<uint32_t, uint8_t, uint8_t, uint8_t>> abort_actuators;
        for (const auto& [name, tup] : actuator_roles) {
            int ch = std::get<0>(tup), bid = std::get<1>(tup);
            bool is_no = std::get<2>(tup);
            std::string ip = board_id_to_ip.count(bid) ? board_id_to_ip[bid] : designated_ip;
            uint8_t vent = static_cast<uint8_t>(vent_map.count(name) ? vent_map[name] : 0);
            uint8_t abort = static_cast<uint8_t>(abort_map.count(name) ? abort_map[name] : 0);
            abort_actuators.push_back({ipToU32Le(ip), static_cast<uint8_t>(ch), vent, abort});
        }

        std::string pt_board_ip;
        for (const auto& b : boards) {
            if (b.enabled && b.type == "PT") {
                pt_board_ip = b.ip;
                break;
            }
        }

        std::vector<std::tuple<uint32_t, uint8_t, uint32_t>> abort_pt_list;
        for (const auto& [sensor_name, threshold_psi] : abort_pts) {
            auto it = sensor_roles.find(sensor_name);
            if (it == sensor_roles.end())
                continue;
            int sensor_id = it->second;
            const auto* coeffs = pt_cal.get_calibration(static_cast<uint8_t>(sensor_id));
            if (!coeffs)
                continue;
            auto adc_opt = coeffs->invert_to_adc(threshold_psi);
            if (!adc_opt)
                continue;
            if (!pt_board_ip.empty())
                abort_pt_list.push_back({ipToU32Le(pt_board_ip), static_cast<uint8_t>(sensor_id),
                                         static_cast<uint32_t>(*adc_opt & 0xFFFFFFFFu)});
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
        buf[off] = enable_serial ? 1 : 0;
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
        buf[off] = b.enable_serial_printing ? 1 : 0;
        return buf;
    };

    for (const auto& b : boards) {
        if (!b.enabled)
            continue;
        if (b.type == "ACTUATOR") {
            int is_abort = (b.id == designated_id) ? 1 : 0;
            auto pkt = build_actuator_config(is_abort, b.enable_serial_printing);
            if (!pkt.empty())
                packets.push_back({ACTUATOR_CONFIG, pkt, b.ip});
        } else if (b.type == "PT" || b.type == "TC" || b.type == "RTD" || b.type == "LC") {
            auto pkt = build_sensor_config(b);
            packets.push_back({SENSOR_CONFIG, pkt, b.ip});
        }
    }

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "[ConfigBroadcast] socket() failed" << std::endl;
        return 1;
    }

    struct sockaddr_in dest;
    memset(&dest, 0, sizeof(dest));
    dest.sin_family = AF_INET;
    dest.sin_port = htons(TARGET_PORT);

    std::cout << "[ConfigBroadcast] Started — interval=" << interval_ms << "ms (C++ standalone)"
              << std::endl;
    std::cout << "[ConfigBroadcast] " << packets.size() << " packet types to " << boards.size()
              << " boards" << std::endl;

    unsigned long total_sent = 0;
    auto last_log = std::chrono::steady_clock::now();

    while (g_running) {
        for (const auto& [pkt_type, pkt, ip] : packets) {
            if (inet_pton(AF_INET, ip.c_str(), &dest.sin_addr) != 1)
                continue;
            ssize_t sent = sendto(sock, pkt.data(), pkt.size(), 0,
                                  reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
            if (sent == static_cast<ssize_t>(pkt.size()))
                total_sent++;
        }

        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - last_log).count() >= 10.0 && total_sent > 0) {
            std::cout << "[ConfigBroadcast] Sent " << total_sent << " packets total" << std::endl;
            last_log = now;
        }

        for (int i = 0; g_running && i < interval_ms; i += 100)
            usleep(100000);
    }

    close(sock);
    std::cout << "[ConfigBroadcast] Stopped." << std::endl;
    return 0;
}
