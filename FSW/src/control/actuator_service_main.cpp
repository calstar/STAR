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
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
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
void parseActuatorRole(const std::string& val, int& channel, int& board_id) {
    channel = 0;
    board_id = 0;
    size_t i = val.find('[');
    if (i == std::string::npos)
        return;
    size_t j = val.find(',', i + 1);
    if (j == std::string::npos)
        return;
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
    std::map<std::string, ActuatorMapping> actuator_map;
    std::map<int, std::string> board_id_to_ip;

    if (!config_content.empty()) {
        for (const auto& sec : {"boards.actuator_board", "boards.actuator_board_2"}) {
            std::string ip = getTomlValue(config_content, sec, "ip", "");
            if (!ip.empty()) {
                std::string id_str = getTomlValue(config_content, sec, "board_id", "0");
                try {
                    int id = std::stoi(id_str);
                    if (id > 0)
                        board_id_to_ip[id] = ip;
                } catch (...) {
                }
            }
        }
        if (board_id_to_ip.empty()) {
            std::string ip =
                getTomlValue(config_content, "boards.actuator_board", "ip", "192.168.2.11");
            board_id_to_ip[11] = ip;
            board_id_to_ip[12] = ip;
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
            parseActuatorRole(val, ch, bid);
            if (ch < 1 || ch > 10)
                continue;

            std::string ip;
            if (bid > 0 && board_id_to_ip.count(bid))
                ip = board_id_to_ip[bid];
            else if (!board_id_to_ip.empty())
                ip = board_id_to_ip.begin()->second;
            else if (bid > 0)
                ip = "192.168.2." + std::to_string(bid);
            else
                ip = "192.168.2.11";

            actuator_map[key] = {ch, ip};
        }
    }

    std::cout << "[ActuatorService] Loaded " << actuator_map.size() << " actuator mappings"
              << std::endl;

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

    daq_comms::protocol::DiabloBoardPacketParser parser;
    constexpr uint16_t ACTUATOR_PORT = 5005;

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
            std::cerr << "[ActuatorService] Unknown state: " << state_name << std::endl;
            return false;
        }

        // Group commands by board IP
        std::map<std::string,
                 std::vector<daq_comms::protocol::DiabloBoardPacketParser::ActuatorCommand>>
            by_board;
        for (const auto& [act_name, pos] : it->second) {
            auto am = actuator_map.find(act_name);
            if (am == actuator_map.end())
                continue;

            daq_comms::protocol::DiabloBoardPacketParser::ActuatorCommand cmd;
            cmd.actuator_id = static_cast<uint8_t>(am->second.channel);
            cmd.actuator_state = (pos == 1) ? 1 : 0;
            by_board[am->second.board_ip].push_back(cmd);
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
    std::cout << "[ActuatorService] Send STATE:<name> to trigger actuator commands\n" << std::endl;

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

        fcntl(client, F_SETFL, O_NONBLOCK);
        read_buf.clear();
        char c;
        while (g_running && recv(client, &c, 1, 0) == 1) {
            if (c == '\n')
                break;
            if (read_buf.size() < 200)
                read_buf += c;
        }

        std::string state_name;
        if (read_buf.compare(0, 6, "STATE:") == 0) {
            state_name = trim(read_buf.substr(6));
        }
        close(client);

        if (!state_name.empty()) {
            sendCommandsForState(state_name);
        }
    }

    close(listen_fd);
    std::cout << "[ActuatorService] Stopped." << std::endl;
    return 0;
}
