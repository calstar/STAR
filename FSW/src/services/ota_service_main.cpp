/**
 * OTA Service — Ethernet firmware flash for DiabloAvionics ESP32-S3 boards.
 *
 * Listens on TCP port 9997 for commands:
 *   OTA_FLASH:<board_ip>:<firmware_path>   — flash .bin to board:3232
 *
 * Replies: "OK\n" or "ERR:<reason>\n"
 *
 * Protocol (matches ota-flash.ts):
 *   1. TCP connect to board_ip:3232
 *   2. Send 4-byte firmware size (big-endian)
 *   3. Send .bin in 4 KB chunks
 *   4. Read "OK" in response before board reboots
 *
 * Usage: ./ota_service [--port PORT]
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {
std::atomic<bool> g_running{true};

void signalHandler(int /*sig*/) {
    std::cout << "\n[OTAService] Shutting down..." << std::endl;
    g_running = false;
}

std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

// ── OTA Flash ────────────────────────────────────────────────────────────────

static constexpr uint16_t OTA_PORT       = 3232;
static constexpr size_t   CHUNK_SIZE     = 4096;
static constexpr int      CONNECT_TIMEOUT_S  = 5;
static constexpr int      TRANSFER_TIMEOUT_S = 60;

bool flashFirmware(const std::string& ip, const std::string& bin_path, std::string& error) {
    // Read firmware file
    std::ifstream f(bin_path, std::ios::binary | std::ios::ate);
    if (!f.is_open()) {
        error = "cannot open file: " + bin_path;
        return false;
    }
    std::streamsize file_size = f.tellg();
    if (file_size <= 0 || file_size > 0x200000) {
        error = "invalid firmware size: " + std::to_string(file_size) + " bytes";
        return false;
    }
    f.seekg(0);
    std::vector<uint8_t> firmware(static_cast<size_t>(file_size));
    if (!f.read(reinterpret_cast<char*>(firmware.data()), file_size)) {
        error = "failed to read firmware file";
        return false;
    }

    // TCP connect to board:3232
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) { error = "socket() failed"; return false; }

    {
        struct timeval tv{ .tv_sec = CONNECT_TIMEOUT_S, .tv_usec = 0 };
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    }

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(OTA_PORT);
    if (inet_pton(AF_INET, ip.c_str(), &addr.sin_addr) != 1) {
        close(sock);
        error = "invalid IP: " + ip;
        return false;
    }
    if (connect(sock, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        close(sock);
        error = "connect to " + ip + ":3232 failed";
        return false;
    }

    // Set longer transfer timeout now that we're connected
    {
        struct timeval tv{ .tv_sec = TRANSFER_TIMEOUT_S, .tv_usec = 0 };
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    }

    // Send 4-byte big-endian firmware size
    uint32_t size_be = htonl(static_cast<uint32_t>(file_size));
    if (send(sock, &size_be, 4, 0) != 4) {
        close(sock);
        error = "failed to send size header";
        return false;
    }

    // Send firmware in 4 KB chunks
    size_t sent = 0;
    int last_pct = -1;
    while (sent < firmware.size()) {
        size_t chunk = std::min(CHUNK_SIZE, firmware.size() - sent);
        ssize_t n = send(sock, firmware.data() + sent, chunk, 0);
        if (n <= 0) {
            close(sock);
            error = "send failed at offset " + std::to_string(sent);
            return false;
        }
        sent += static_cast<size_t>(n);
        int pct = static_cast<int>((sent * 100) / firmware.size());
        if (pct != last_pct) {
            std::cout << "[OTAService] Flash " << ip << ": " << pct << "% ("
                      << sent << "/" << file_size << " bytes)" << std::endl;
            last_pct = pct;
        }
    }

    // Wait for "OK" response
    char resp[64]{};
    ssize_t n = recv(sock, resp, sizeof(resp) - 1, 0);
    close(sock);

    if (n <= 0) {
        error = "no response from board (may have rebooted normally)";
        // Not necessarily a failure — ESP32 sometimes reboots before sending OK
        return true;
    }
    std::string resp_str = trim(std::string(resp, static_cast<size_t>(n)));
    if (resp_str.find("OK") == std::string::npos) {
        error = "unexpected response: " + resp_str;
        return false;
    }
    return true;
}

// ── TCP command handler ───────────────────────────────────────────────────────

void handleClient(int client_fd) {
    struct timeval tv{ .tv_sec = 30, .tv_usec = 0 };
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    auto sendReply = [&](const std::string& msg) {
        send(client_fd, msg.c_str(), msg.size(), MSG_NOSIGNAL);
    };

    std::string buf;
    buf.reserve(512);
    char c;
    while (g_running && recv(client_fd, &c, 1, 0) == 1) {
        if (c == '\n') break;
        if (buf.size() < 1024) buf += c;
    }
    const std::string cmd = trim(buf);

    if (cmd.compare(0, 10, "OTA_FLASH:") == 0) {
        const std::string rest = cmd.substr(10);
        const size_t colon = rest.find(':');
        if (colon == std::string::npos || colon == 0 || colon + 1 >= rest.size()) {
            sendReply("ERR:bad OTA_FLASH format — use OTA_FLASH:<ip>:<path>\n");
        } else {
            const std::string ip   = trim(rest.substr(0, colon));
            const std::string path = trim(rest.substr(colon + 1));
            std::cout << "[OTAService] Flashing " << ip << " with " << path << std::endl;
            std::string err;
            if (flashFirmware(ip, path, err)) {
                std::cout << "[OTAService] Flash " << ip << " OK" << std::endl;
                sendReply("OK\n");
            } else {
                std::cerr << "[OTAService] Flash " << ip << " failed: " << err << std::endl;
                sendReply("ERR:" + err + "\n");
            }
        }
    } else if (!cmd.empty()) {
        sendReply("ERR:unknown command (use OTA_FLASH:<ip>:<path>)\n");
    }

    close(client_fd);
}

}  // namespace

int main(int argc, char* argv[]) {
    uint16_t listen_port = 9997;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            listen_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0] << " [--port PORT]\n"
                      << "  Commands: OTA_FLASH:<board_ip>:<firmware_path>\n";
            return 0;
        }
    }

    signal(SIGINT,  signalHandler);
    signal(SIGTERM, signalHandler);
    signal(SIGPIPE, SIG_IGN);

    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        std::cerr << "[OTAService] socket() failed" << std::endl;
        return 1;
    }
    {
        int opt = 1;
        setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    }
    {
        struct sockaddr_in addr{};
        addr.sin_family      = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port        = htons(listen_port);
        if (bind(listen_fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
            std::cerr << "[OTAService] bind() failed on port " << listen_port << std::endl;
            close(listen_fd);
            return 1;
        }
    }
    if (listen(listen_fd, 5) < 0) {
        std::cerr << "[OTAService] listen() failed" << std::endl;
        close(listen_fd);
        return 1;
    }

    std::cout << "[OTAService] Listening on port " << listen_port << std::endl;
    std::cout << "[OTAService] Commands: OTA_FLASH:<board_ip>:<firmware_path>" << std::endl;

    while (g_running) {
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(listen_fd, &rd);
        struct timeval tv{ .tv_sec = 1, .tv_usec = 0 };
        if (select(listen_fd + 1, &rd, nullptr, nullptr, &tv) <= 0) continue;

        int client_fd = accept(listen_fd, nullptr, nullptr);
        if (client_fd < 0) continue;

        std::thread([client_fd]() { handleClient(client_fd); }).detach();
    }

    close(listen_fd);
    std::cout << "[OTAService] Stopped." << std::endl;
    return 0;
}
