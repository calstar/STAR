/**
 * Actuator Service — C++ service that receives state transitions and sends
 * actuator commands. Actuator state (0=closed, 1=open) is written to Elodin DB
 * by daq_bridge; this service owns command dispatch.
 *
 * Listens on TCP port for "STATE:<state_name>\n". Parses state_machine_actuators.csv,
 * sends UDP to actuator boards.
 *
 * Usage: ./actuator_service [--config PATH] [--csv PATH] [--port PORT]
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "../../daq_comms/include/protocol/DiabloBoardPacketParser.hpp"

namespace {
std::atomic<bool> g_running{true};

void signalHandler(int /*sig*/) {
    std::cout << "\n[ActuatorService] Shutting down..." << std::endl;
    g_running = false;
}

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

// Parse TOML array like ["NO", 1, 12] for actuator_roles
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
        if (k != std::string::npos) {
            board_id = std::stoi(trim(val.substr(k + 1)));
        }
        channel =
            std::stoi(trim(val.substr(j + 1, (k != std::string::npos ? k : val.size()) - j - 1)));
    } catch (...) {
    }
}

}  // namespace

struct ActuatorMapping {
    int channel;  // 1-based
    bool is_no;   // NO valve: closed→hw 1, open→hw 0; NC: closed→0, open→1
    std::string board_ip;
};

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::string csv_path;  // Filled from config or --csv
    uint16_t listen_port = 9998;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--csv" && i + 1 < argc) {
            csv_path = argv[++i];
        } else if (arg == "--port" && i + 1 < argc) {
            listen_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0] << " [--config PATH] [--csv PATH] [--port PORT]\n";
            return 0;
        }
    }

    // Load config
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
            std::cout << "[ActuatorService] Loaded config: " << config_path << std::endl;
        }
    }

    // Build actuator name -> {channel, board_ip}
    // Prefer board discovery (config.toml.auto from daq_bridge heartbeats) for IPs.
    std::map<std::string, ActuatorMapping> actuator_map;
    std::map<int, std::string> board_id_to_ip;

    // Load from config.toml.auto (daq_bridge writes this from heartbeat discovery)
    std::string auto_path = config_path + ".auto";
    {
        std::ifstream fa(auto_path);
        if (fa.is_open()) {
            std::ostringstream ss;
            ss << fa.rdbuf();
            std::string auto_content = ss.str();
            size_t pos = 0;
            while (pos < auto_content.size()) {
                size_t next = auto_content.find("[board_", pos);
                if (next == std::string::npos)
                    break;
                size_t end = auto_content.find(']', next);
                if (end == std::string::npos)
                    break;
                std::string sec = auto_content.substr(next + 1, end - next - 1);
                std::string bt = getTomlValue(auto_content, sec, "board_type", "");
                std::string ip = getTomlValue(auto_content, sec, "ip", "");
                if (bt == "5" && !ip.empty()) {  // board_type 5 = ACTUATOR
                    size_t last_dot = ip.rfind('.');
                    if (last_dot != std::string::npos) {
                        try {
                            int bid = std::stoi(ip.substr(last_dot + 1));
                            if (bid >= 1 && bid <= 254) {
                                board_id_to_ip[bid] = ip;
                                std::cout << "[ActuatorService] Discovery: board " << bid << " -> "
                                          << ip << std::endl;
                            }
                        } catch (...) {
                        }
                    }
                }
                pos = end + 1;
            }
            if (!board_id_to_ip.empty())
                std::cout << "[ActuatorService] Using " << board_id_to_ip.size()
                          << " actuator board IPs from discovery (config.toml.auto)" << std::endl;
        }
    }

    if (!config_content.empty()) {
        // Find all [boards.xxx] sections with type=ACTUATOR (static config fallback)
        auto scan_section = [&](size_t start) {
            if (config_content.compare(start, 9, "[boards.") != 0)
                return start + 1;
            size_t end = config_content.find(']', start);
            if (end == std::string::npos)
                return start + 1;
            std::string sec = config_content.substr(start + 1, end - start - 1);
            if (getTomlValue(config_content, sec, "type", "") != "ACTUATOR")
                return end + 1;
            std::string ip = getTomlValue(config_content, sec, "ip", "");
            std::string id_str = getTomlValue(config_content, sec, "board_id",
                                              getTomlValue(config_content, sec, "id", "0"));
            if (!ip.empty()) {
                try {
                    int id = std::stoi(id_str);
                    if (id > 0 && !board_id_to_ip.count(id))  // discovery overrides; skip if set
                        board_id_to_ip[id] = ip;
                } catch (...) {
                }
            }
            return end + 1;
        };
        size_t pos = 0;
        while (pos < config_content.size()) {
            size_t next = config_content.find("[boards.", pos);
            if (next == std::string::npos)
                break;
            pos = scan_section(next);
        }
        if (board_id_to_ip.empty()) {
            board_id_to_ip[11] = "192.168.2.11";
            board_id_to_ip[12] = "192.168.2.12";
            board_id_to_ip[13] = "192.168.2.13";
            board_id_to_ip[14] = "192.168.2.14";
        }

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
            auto eq = line.find('=');
            if (eq == std::string::npos || current_section != "actuator_roles")
                continue;

            std::string key = trim(line.substr(0, eq));
            std::string val = trim(line.substr(eq + 1));
            int ch = 0, bid = 0;
            bool is_no = false;
            parseActuatorRole(val, ch, bid, is_no);
            if (ch < 1 || ch > 10)
                continue;

            std::string ip;
            if (bid > 0 && board_id_to_ip.count(bid))
                ip = board_id_to_ip[bid];
            else if (bid > 0)
                ip = "192.168.2." + std::to_string(bid);  // canonical: board_id N → 192.168.2.N
            else
                ip = "192.168.2.11";

            actuator_map[key] = {ch, is_no, ip};
        }
    }

    std::cout << "[ActuatorService] Loaded " << actuator_map.size() << " actuator mappings"
              << std::endl;

    // Bind address for outbound UDP — use DAQ interface (e.g. 192.168.2.x) so packets reach boards.
    // On multi-homed hosts, unbound sockets can use wrong interface; binding fixes routing.
    std::string udp_bind_addr =
        getTomlValue(config_content, "actuator_service", "bind_address", "0.0.0.0");
    if (udp_bind_addr.empty())
        udp_bind_addr = "0.0.0.0";
    std::cout << "[ActuatorService] UDP bind_address = " << udp_bind_addr << std::endl;

    // Resolve CSV path: --csv > config [state_machine] actuator_csv > fallbacks
    if (csv_path.empty() && !config_content.empty()) {
        csv_path = getTomlValue(config_content, "state_machine", "actuator_csv", "");
    }
    if (csv_path.empty()) {
        csv_path = "external/DiabloAvionics/test_guis/state_machine_actuators.csv";
    }
    // Try fallbacks when cwd varies (run from build/ vs project root)
    const char* csv_fallbacks[] = {
        "external/DiabloAvionics/test_guis/state_machine_actuators.csv",
        "../external/DiabloAvionics/test_guis/state_machine_actuators.csv",
        "../../external/DiabloAvionics/test_guis/state_machine_actuators.csv",
    };

    // Parse state_machine_actuators.csv: state_name -> { actuator_name -> 0|1 }
    std::map<std::string, std::map<std::string, int>> state_actuators;

    {
        std::ifstream f(csv_path);
        if (!f.is_open()) {
            for (const char* fb : csv_fallbacks) {
                if (std::string(fb) == csv_path)
                    continue;
                f.open(fb);
                if (f.is_open()) {
                    csv_path = fb;
                    break;
                }
            }
        }
        if (!f.is_open()) {
            std::cerr << "[ActuatorService] Cannot open state_machine_actuators.csv (tried: "
                      << csv_path;
            for (const char* fb : csv_fallbacks) {
                if (std::string(fb) != csv_path)
                    std::cerr << ", " << fb;
            }
            std::cerr << ")" << std::endl;
            return 1;
        }
        std::string line;
        if (!std::getline(f, line))
            return 1;

        std::vector<std::string> headers;
        {
            std::istringstream iss(line);
            std::string cell;
            while (std::getline(iss, cell, ',')) {
                headers.push_back(trim(cell));
            }
        }

        while (std::getline(f, line)) {
            std::vector<std::string> cells;
            std::istringstream iss(line);
            std::string cell;
            while (std::getline(iss, cell, ','))
                cells.push_back(trim(cell));
            if (cells.empty())
                continue;

            std::string actuator_name = cells[0];
            if (actuator_name.empty())
                continue;

            for (size_t col = 1; col < headers.size() && col < cells.size(); ++col) {
                std::string state_name = headers[col];
                if (state_name.empty())
                    continue;

                std::string val = cells[col];
                std::transform(val.begin(), val.end(), val.begin(), ::toupper);
                int pos = -1;
                if (val == "OPEN")
                    pos = 1;
                else if (val == "CLOSE" || val == "CLOSED")
                    pos = 0;
                if (pos < 0)
                    continue;

                state_actuators[state_name][actuator_name] = pos;
            }
        }
        std::cout << "[ActuatorService] Loaded " << state_actuators.size() << " states from CSV"
                  << std::endl;
    }

    // Delay CSV (optional): state_name -> actuator_name -> delay in seconds when entering that
    // state
    std::map<std::string, std::map<std::string, double>> state_actuator_delays;
    std::string delay_csv_path =
        getTomlValue(config_content, "state_machine", "actuator_delay_csv", "");
    if (delay_csv_path.empty() && !csv_path.empty()) {
        size_t slash = csv_path.find_last_of("/\\");
        delay_csv_path = (slash != std::string::npos)
                             ? csv_path.substr(0, slash + 1) + "state_machine_actuator_delays.csv"
                             : "state_machine_actuator_delays.csv";
    }
    if (delay_csv_path.empty())
        delay_csv_path = "config/state_machine_actuator_delays.csv";
    const char* delay_fallbacks[] = {
        "config/state_machine_actuator_delays.csv",
        "../config/state_machine_actuator_delays.csv",
        "../../config/state_machine_actuator_delays.csv",
    };
    {
        std::ifstream df(delay_csv_path);
        if (!df.is_open() && !delay_csv_path.empty()) {
            for (const char* fb : delay_fallbacks) {
                if (std::string(fb) == delay_csv_path)
                    continue;
                df.open(fb);
                if (df.is_open()) {
                    delay_csv_path = fb;
                    break;
                }
            }
        }
        // Same dir as state CSV (in case state CSV was loaded from a fallback path)
        if (!df.is_open() && !csv_path.empty()) {
            size_t slash = csv_path.find_last_of("/\\");
            if (slash != std::string::npos) {
                std::string delay_same_dir =
                    csv_path.substr(0, slash + 1) + "state_machine_actuator_delays.csv";
                df.open(delay_same_dir);
                if (df.is_open())
                    delay_csv_path = delay_same_dir;
            }
        }
        if (df.is_open()) {
            std::string line;
            if (std::getline(df, line)) {
                std::vector<std::string> headers;
                std::istringstream iss(line);
                std::string cell;
                while (std::getline(iss, cell, ','))
                    headers.push_back(trim(cell));
                while (std::getline(df, line)) {
                    std::vector<std::string> cells;
                    std::istringstream is(line);
                    while (std::getline(is, cell, ','))
                        cells.push_back(trim(cell));
                    if (cells.empty() || cells[0].empty())
                        continue;
                    std::string actuator_name = cells[0];
                    for (size_t col = 1; col < headers.size() && col < cells.size(); ++col) {
                        if (headers[col].empty())
                            continue;
                        double sec = 0;
                        try {
                            if (!cells[col].empty())
                                sec = std::stod(cells[col]);
                        } catch (...) {
                        }
                        if (sec < 0)
                            sec = 0;
                        state_actuator_delays[headers[col]][actuator_name] = sec;
                    }
                }
            }
            std::cout << "[ActuatorService] Loaded delay CSV: " << state_actuator_delays.size()
                      << " states" << std::endl;
        } else {
            std::cout << "[ActuatorService] No delay CSV at " << delay_csv_path << " (optional)"
                      << std::endl;
        }
    }

    daq_comms::protocol::DiabloBoardPacketParser parser;
    constexpr uint16_t ACTUATOR_PORT = 5005;

    auto sendSingleActuator = [&](const std::string& act_name, int pos) -> bool {
        auto am = actuator_map.find(act_name);
        if (am == actuator_map.end()) {
            std::string canon = act_name;
            std::transform(canon.begin(), canon.end(), canon.begin(), ::tolower);
            for (const auto& [k, v] : actuator_map) {
                std::string kc = k;
                std::transform(kc.begin(), kc.end(), kc.begin(), ::tolower);
                if (kc == canon) {
                    am = actuator_map.find(k);
                    break;
                }
            }
        }
        if (am == actuator_map.end()) {
            std::cerr << "[ActuatorService] Unknown actuator: " << act_name << std::endl;
            return false;
        }
        daq_comms::protocol::DiabloBoardPacketParser::ActuatorCommand cmd;
        cmd.actuator_id = static_cast<uint8_t>(am->second.channel);
        int hw = (am->second.is_no) ? (1 - pos) : pos;
        cmd.actuator_state = static_cast<uint8_t>(hw);
        std::vector<uint8_t> pkt = parser.construct_actuator_command_packet({cmd});
        if (pkt.empty())
            return false;
        int sock = socket(AF_INET, SOCK_DGRAM, 0);
        if (sock < 0)
            return false;
        struct sockaddr_in local;
        memset(&local, 0, sizeof(local));
        local.sin_family = AF_INET;
        local.sin_port = 0;
        if (inet_pton(AF_INET, udp_bind_addr.c_str(), &local.sin_addr) != 1 ||
            bind(sock, reinterpret_cast<struct sockaddr*>(&local), sizeof(local)) < 0) {
            close(sock);
            return false;
        }
        struct sockaddr_in dest;
        memset(&dest, 0, sizeof(dest));
        dest.sin_family = AF_INET;
        dest.sin_port = htons(ACTUATOR_PORT);
        if (inet_pton(AF_INET, am->second.board_ip.c_str(), &dest.sin_addr) != 1) {
            close(sock);
            return false;
        }
        ssize_t sent = sendto(sock, pkt.data(), pkt.size(), 0,
                              reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
        close(sock);
        if (sent == static_cast<ssize_t>(pkt.size())) {
            std::cout << "[ActuatorService] Actuator " << act_name << " -> "
                      << (pos == 1 ? "OPEN" : "CLOSED") << std::endl;
            return true;
        }
        return false;
    };

    auto sendCommandsForState = [&](const std::string& state_name) {
        std::string canon = state_name;
        std::transform(canon.begin(), canon.end(), canon.begin(), ::tolower);
        auto it = state_actuators.end();
        for (const auto& [k, v] : state_actuators) {
            std::string kc = k;
            std::transform(kc.begin(), kc.end(), kc.begin(), ::tolower);
            if (kc == canon) {
                it = state_actuators.find(k);
                break;
            }
        }
        if (it == state_actuators.end()) {
            std::cerr << "[ActuatorService] Unknown state: \"" << state_name
                      << "\" (known: Idle, Armed, Fuel Fill, Ox Fill, ... Vent, Fuel Vent, etc.)"
                      << std::endl;
            return false;
        }

        auto delay_it = state_actuator_delays.find(state_name);
        if (delay_it == state_actuator_delays.end()) {
            for (const auto& [k, v] : state_actuator_delays) {
                std::string kc = k;
                std::transform(kc.begin(), kc.end(), kc.begin(), ::tolower);
                if (kc == canon) {
                    delay_it = state_actuator_delays.find(k);
                    break;
                }
            }
        }
        const bool use_delays = (delay_it != state_actuator_delays.end());
        // During Fire state, Fuel Press and LOX Press are PWM-driven by controller service only.
        // Mains (Fuel Main, LOX Main) are state-driven — actuator service sends open for them.
        const bool is_fire_state = (canon == "fire");
        auto skip_in_fire = [](const std::string& name) {
            return name == "Fuel Press" || name == "LOX Press";
        };

        if (use_delays) {
            std::cout << "[ActuatorService] Applying state \"" << state_name
                      << "\" with per-actuator delays (mains at fire start)" << std::endl;
            // Build (act_name, pos, delay_sec), sort by delay, then send one-by-one with sleep
            struct DelayedCmd {
                std::string act_name;
                int pos;
                double delay_sec;
            };
            std::vector<DelayedCmd> delayed;
            for (const auto& [act_name, pos] : it->second) {
                if (is_fire_state && skip_in_fire(act_name))
                    continue;
                if (actuator_map.find(act_name) == actuator_map.end())
                    continue;
                double d = 0;
                if (delay_it != state_actuator_delays.end()) {
                    auto ad = delay_it->second.find(act_name);
                    if (ad != delay_it->second.end())
                        d = ad->second;
                }
                delayed.push_back({act_name, pos, d});
            }
            std::sort(delayed.begin(), delayed.end(), [](const DelayedCmd& a, const DelayedCmd& b) {
                return a.delay_sec < b.delay_sec;
            });
            double prev_t = 0;
            for (const auto& dc : delayed) {
                if (dc.delay_sec > prev_t) {
                    auto usec = static_cast<unsigned>(std::round((dc.delay_sec - prev_t) * 1e6));
                    if (usec > 0)
                        usleep(usec);
                }
                prev_t = dc.delay_sec;
                sendSingleActuator(dc.act_name, dc.pos);
            }
            return true;
        }

        // No delays: group commands by board IP and send in batch
        std::map<std::string,
                 std::vector<daq_comms::protocol::DiabloBoardPacketParser::ActuatorCommand>>
            by_board;
        for (const auto& [act_name, pos] : it->second) {
            if (is_fire_state && skip_in_fire(act_name))
                continue;
            auto am = actuator_map.find(act_name);
            if (am == actuator_map.end())
                continue;

            daq_comms::protocol::DiabloBoardPacketParser::ActuatorCommand cmd;
            cmd.actuator_id = static_cast<uint8_t>(am->second.channel);
            int hw = (am->second.is_no) ? (1 - pos) : pos;
            cmd.actuator_state = static_cast<uint8_t>(hw);
            by_board[am->second.board_ip].push_back(cmd);
        }

        if (by_board.empty()) {
            std::cerr << "[ActuatorService] State \"" << state_name
                      << "\": no actuator_map matches for CSV actuators" << std::endl;
            return false;
        }

        for (const auto& [ip, commands] : by_board) {
            std::vector<uint8_t> pkt = parser.construct_actuator_command_packet(commands);
            if (pkt.empty())
                continue;

            int sock = socket(AF_INET, SOCK_DGRAM, 0);
            if (sock < 0) {
                std::cerr << "[ActuatorService] socket() failed" << std::endl;
                continue;
            }
            struct sockaddr_in local;
            memset(&local, 0, sizeof(local));
            local.sin_family = AF_INET;
            local.sin_port = 0;
            if (inet_pton(AF_INET, udp_bind_addr.c_str(), &local.sin_addr) != 1) {
                std::cerr << "[ActuatorService] invalid bind_address '" << udp_bind_addr << "'"
                          << std::endl;
                close(sock);
                continue;
            }
            if (bind(sock, reinterpret_cast<struct sockaddr*>(&local), sizeof(local)) < 0) {
                std::cerr << "[ActuatorService] bind(" << udp_bind_addr
                          << ") failed: " << strerror(errno) << std::endl;
                close(sock);
                continue;
            }

            struct sockaddr_in dest;
            memset(&dest, 0, sizeof(dest));
            dest.sin_family = AF_INET;
            dest.sin_port = htons(ACTUATOR_PORT);
            if (inet_pton(AF_INET, ip.c_str(), &dest.sin_addr) != 1) {
                close(sock);
                continue;
            }

            ssize_t sent = sendto(sock, pkt.data(), pkt.size(), 0,
                                  reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
            close(sock);
            if (sent == static_cast<ssize_t>(pkt.size())) {
                std::cout << "[ActuatorService] Sent " << commands.size() << " commands to " << ip
                          << ":" << ACTUATOR_PORT << " for state " << state_name << std::endl;
            }
        }
        return true;
    };

    // TCP listener
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        std::cerr << "[ActuatorService] socket() failed" << std::endl;
        return 1;
    }
    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(listen_port);
    if (bind(listen_fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::cerr << "[ActuatorService] bind() failed on port " << listen_port << std::endl;
        close(listen_fd);
        return 1;
    }
    if (listen(listen_fd, 5) < 0) {
        std::cerr << "[ActuatorService] listen() failed" << std::endl;
        close(listen_fd);
        return 1;
    }

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    std::cout << "[ActuatorService] Listening on port " << listen_port << std::endl;
    std::cout
        << "[ActuatorService] STATE:<name> = full state; ACTUATOR:<name>:0|1 = single actuator\n"
        << std::endl;

    std::string read_buf;
    read_buf.reserve(256);

    while (g_running) {
        struct timeval tv;
        tv.tv_sec = 1;
        tv.tv_usec = 0;
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(listen_fd, &rd);
        int n = select(listen_fd + 1, &rd, nullptr, nullptr, &tv);
        if (n <= 0)
            continue;

        int client = accept(listen_fd, nullptr, nullptr);
        if (client < 0)
            continue;

        // Set a 2-second recv timeout so a stalled sender never blocks the loop.
        struct timeval recv_tv;
        recv_tv.tv_sec = 2;
        recv_tv.tv_usec = 0;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &recv_tv, sizeof(recv_tv));

        read_buf.clear();
        char c;
        while (g_running && recv(client, &c, 1, 0) == 1) {
            if (c == '\n')
                break;
            if (read_buf.size() < 200)
                read_buf += c;
        }

        std::string state_name;
        bool handled = false;
        if (read_buf.compare(0, 6, "STATE:") == 0) {
            state_name = trim(read_buf.substr(6));
            if (!state_name.empty()) {
                sendCommandsForState(state_name);
                handled = true;
            }
        } else if (read_buf.compare(0, 9, "ACTUATOR:") == 0) {
            std::string rest = trim(read_buf.substr(9));
            size_t last_colon = rest.rfind(':');
            if (last_colon != std::string::npos && last_colon > 0) {
                std::string act_name = trim(rest.substr(0, last_colon));
                std::string val_str = trim(rest.substr(last_colon + 1));
                int pos = -1;
                if (val_str == "1" || val_str == "open")
                    pos = 1;
                else if (val_str == "0" || val_str == "closed")
                    pos = 0;
                if (pos >= 0 && !act_name.empty()) {
                    sendSingleActuator(act_name, pos);
                    handled = true;
                }
            }
        }
        close(client);
    }

    close(listen_fd);
    std::cout << "[ActuatorService] Stopped." << std::endl;
    return 0;
}
