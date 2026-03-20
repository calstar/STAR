/**
 * Heartbeat Service — C++ SERVER_HEARTBEAT broadcaster.
 *
 * Polls backend /api/engine_state via HTTP, broadcasts SERVER_HEARTBEAT (type 2)
 * to boards. Flight-ready replacement for Python heartbeat_service.py.
 *
 * Packet: type(1)=2, version(1)=0, timestamp_ms(4 LE), engine_state(1)
 *
 * Usage: ./heartbeat_service [--config PATH] [--backend-url URL]
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
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace {
std::atomic<bool> g_running{true};

void signalHandler(int /*sig*/) {
    std::cout << "\n[HeartbeatService] Shutting down..." << std::endl;
    g_running = false;
}

constexpr uint8_t SERVER_HEARTBEAT_TYPE = 2;
constexpr uint8_t DIABLO_VERSION = 0;

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

int fetchEngineState(const std::string& host, uint16_t port, int timeout_sec = 2) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0)
        return 0;

    struct timeval tv;
    tv.tv_sec = timeout_sec;
    tv.tv_usec = 0;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
        close(sock);
        return 0;
    }

    if (connect(sock, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        close(sock);
        return 0;
    }

    std::string req =
        "GET /api/engine_state HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n";
    ssize_t sent = send(sock, req.data(), req.size(), 0);
    if (sent != static_cast<ssize_t>(req.size())) {
        close(sock);
        return 0;
    }

    std::string resp;
    char buf[512];
    ssize_t n;
    while ((n = recv(sock, buf, sizeof(buf) - 1, 0)) > 0) {
        buf[n] = '\0';
        resp += buf;
    }
    close(sock);

    std::regex re(R"("engineState"\s*:\s*(\d+))");
    std::smatch m;
    if (std::regex_search(resp, m, re)) {
        try {
            return std::stoi(m[1].str()) & 0xFF;
        } catch (...) {
        }
    }
    return 0;
}

void parseUrl(const std::string& url, std::string& host, uint16_t& port, std::string& path) {
    host = "127.0.0.1";
    port = 8082;
    path = "/api/engine_state";

    std::regex re(R"(https?://([^:/]+)(?::(\d+))?(/.*)?)");
    std::smatch m;
    if (std::regex_search(url, m, re)) {
        host = m[1].str();
        if (m[2].matched && !m[2].str().empty()) {
            try {
                port = static_cast<uint16_t>(std::stoi(m[2].str()));
            } catch (...) {
            }
        }
        if (m[3].matched && !m[3].str().empty())
            path = m[3].str();
    }
}

std::vector<uint8_t> buildHeartbeatPacket(int engine_state) {
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
        static_cast<uint8_t>(engine_state & 0xFF),
    };
}

}  // namespace

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::string backend_url = "http://127.0.0.1:8082";
    int interval_ms = 1000;
    std::string broadcast_ip = "192.168.2.255";
    uint16_t broadcast_port = 5005;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--backend-url" && i + 1 < argc) {
            backend_url = argv[++i];
        } else if (arg == "--interval-ms" && i + 1 < argc) {
            interval_ms = std::max(100, std::atoi(argv[++i]));
        } else if (arg == "--broadcast-ip" && i + 1 < argc) {
            broadcast_ip = argv[++i];
        } else if (arg == "--broadcast-port" && i + 1 < argc) {
            broadcast_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0]
                      << " [--config PATH] [--backend-url URL] [--interval-ms MS] "
                         "[--broadcast-ip IP] [--broadcast-port PORT]\n";
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

    if (!config_content.empty()) {
        std::string val = getTomlValue(config_content, "heartbeat_service", "backend_url", "");
        if (!val.empty())
            backend_url = val;
        val = getTomlValue(config_content, "heartbeat_service", "interval_ms", "");
        if (!val.empty()) {
            try {
                interval_ms = std::max(100, std::stoi(val));
            } catch (...) {
            }
        }
        val = getTomlValue(config_content, "heartbeat_service", "broadcast_ip",
                           getTomlValue(config_content, "server_heartbeat", "broadcast_ip", ""));
        if (!val.empty())
            broadcast_ip = val;
        val = getTomlValue(config_content, "heartbeat_service", "broadcast_port",
                           getTomlValue(config_content, "server_heartbeat", "broadcast_port", ""));
        if (!val.empty()) {
            try {
                broadcast_port = static_cast<uint16_t>(std::stoi(val));
            } catch (...) {
            }
        }
    }

    std::string host;
    uint16_t port;
    std::string path;
    parseUrl(backend_url, host, port, path);

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "[HeartbeatService] socket() failed" << std::endl;
        return 1;
    }

    int opt = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &opt, sizeof(opt));

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
    std::cout << "[HeartbeatService] Engine state from " << host << ":" << port << path
              << std::endl;

    unsigned long count = 0;
    auto last_log = std::chrono::steady_clock::now();

    while (g_running) {
        int engine_state = fetchEngineState(host, port);
        auto pkt = buildHeartbeatPacket(engine_state);
        ssize_t sent = sendto(sock, pkt.data(), pkt.size(), 0,
                              reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
        if (sent == static_cast<ssize_t>(pkt.size()))
            count++;

        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - last_log).count() >= 10.0) {
            std::cout << "[HeartbeatService] Sent " << count
                      << " heartbeats (engine_state=" << engine_state << ")" << std::endl;
            last_log = now;
        }

        for (int i = 0; g_running && i < interval_ms; i += 100)
            usleep(100000);
    }

    close(sock);
    std::cout << "[HeartbeatService] Stopped." << std::endl;
    return 0;
}
