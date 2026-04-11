/**
 * OTA Service — Ethernet firmware flash for DiabloAvionics ESP32-S3 boards.
 *
 * Listens on TCP port 9997 for commands:
 *   OTA_FLASH:<board_ip>:<firmware_path>   — flash existing .bin to board:3232
 *   OTA_BUILD_FLASH|board_ip|abs_project_dir|board_id
 *       — run `pio run` in abs_project_dir (board_id 1–254 sets
 *       PLATFORMIO_BUILD_FLAGS=-DTEMP_HARDCODE_BOARD_ID=N; 0 = no flag), then flash
 * .pio/build/<env>/firmware.bin
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
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
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

static constexpr uint16_t OTA_PORT = 3232;
static constexpr size_t CHUNK_SIZE = 4096;
static constexpr int CONNECT_TIMEOUT_S = 5;
static constexpr int TRANSFER_TIMEOUT_S = 60;

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
    if (sock < 0) {
        error = "socket() failed";
        return false;
    }

    {
        struct timeval tv {
            .tv_sec = CONNECT_TIMEOUT_S, .tv_usec = 0
        };
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    }

    struct sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(OTA_PORT);
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
        struct timeval tv {
            .tv_sec = TRANSFER_TIMEOUT_S, .tv_usec = 0
        };
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
            std::cout << "[OTAService] Flash " << ip << ": " << pct << "% (" << sent << "/"
                      << file_size << " bytes)" << std::endl;
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

// ── PlatformIO build (pio run) ───────────────────────────────────────────────

std::string readFirstPioEnv(const std::string& iniPath) {
    std::ifstream f(iniPath);
    if (!f.is_open())
        return "adafruit_feather_esp32s3";
    std::string line;
    while (std::getline(f, line)) {
        if (line.size() > 6 && line.compare(0, 5, "[env:") == 0) {
            size_t end = line.find(']');
            if (end != std::string::npos && end > 5)
                return trim(line.substr(5, end - 5));
        }
    }
    return "adafruit_feather_esp32s3";
}

void sanitizeOneLine(std::string& s) {
    for (char& c : s) {
        if (c == '\n' || c == '\r')
            c = ' ';
    }
    if (s.size() > 4000)
        s.resize(4000);
}

/** Run pio in projectDir; capture combined stdout/stderr into buildLog. */
bool runPioBuild(const std::string& projectDir, int boardId, std::string& buildLog,
                 std::string& error) {
    const std::string ini = projectDir + "/platformio.ini";
    std::ifstream check(ini);
    if (!check.is_open()) {
        error = "no platformio.ini in " + projectDir;
        return false;
    }
    check.close();

    int pipefd[2];
    if (pipe(pipefd) < 0) {
        error = "pipe() failed";
        return false;
    }

    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        error = "fork() failed";
        return false;
    }

    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);

        if (chdir(projectDir.c_str()) != 0) {
            perror("chdir");
            _exit(126);
        }
        if (boardId > 0 && boardId <= 254) {
            const std::string fl = "-DTEMP_HARDCODE_BOARD_ID=" + std::to_string(boardId);
            setenv("PLATFORMIO_BUILD_FLAGS", fl.c_str(), 1);
        } else {
            unsetenv("PLATFORMIO_BUILD_FLAGS");
        }

        execlp("pio", "pio", "run", (char*)nullptr);
        execlp("platformio", "platformio", "run", (char*)nullptr);
        _exit(127);
    }

    close(pipefd[1]);
    buildLog.clear();
    char buf[4096];
    ssize_t n;
    while ((n = read(pipefd[0], buf, sizeof(buf) - 1)) > 0 && buildLog.size() < 65536) {
        buf[n] = '\0';
        buildLog += buf;
    }
    close(pipefd[0]);

    int st = 0;
    if (waitpid(pid, &st, 0) < 0) {
        error = "waitpid failed";
        return false;
    }
    if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) {
        int code = WIFEXITED(st) ? WEXITSTATUS(st) : -1;
        error = "pio run failed (exit " + std::to_string(code) + "): " + buildLog;
        sanitizeOneLine(error);
        return false;
    }
    return true;
}

bool buildAndFlash(const std::string& ip, const std::string& projectDir, int boardId,
                   std::string& error, std::string& buildOutput) {
    std::string blog;
    if (!runPioBuild(projectDir, boardId, blog, error)) {
        buildOutput = blog;
        return false;
    }
    buildOutput = blog;
    // Successful builds previously had no console output; print captured pio log before flash.
    if (!blog.empty()) {
        std::cout << "[OTAService] pio run output:\n" << blog;
        if (blog.back() != '\n')
            std::cout << '\n';
    }
    const std::string envName = readFirstPioEnv(projectDir + "/platformio.ini");
    const std::string binPath = projectDir + "/.pio/build/" + envName + "/firmware.bin";
    std::ifstream bf(binPath);
    if (!bf.is_open()) {
        error = "firmware.bin missing after build: " + binPath;
        sanitizeOneLine(error);
        return false;
    }
    bf.close();
    return flashFirmware(ip, binPath, error);
}

// ── TCP command handler ───────────────────────────────────────────────────────

void handleClient(int client_fd) {
    struct timeval tv {
        .tv_sec = 30, .tv_usec = 0
    };
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    auto sendReply = [&](const std::string& msg) {
        send(client_fd, msg.c_str(), msg.size(), MSG_NOSIGNAL);
    };

    std::string buf;
    buf.reserve(512);
    char c;
    while (g_running && recv(client_fd, &c, 1, 0) == 1) {
        if (c == '\n')
            break;
        if (buf.size() < 8192)
            buf += c;
    }
    const std::string cmd = trim(buf);

    if (cmd.compare(0, 10, "OTA_FLASH:") == 0) {
        const std::string rest = cmd.substr(10);
        const size_t colon = rest.find(':');
        if (colon == std::string::npos || colon == 0 || colon + 1 >= rest.size()) {
            sendReply("ERR:bad OTA_FLASH format — use OTA_FLASH:<ip>:<path>\n");
        } else {
            const std::string ip = trim(rest.substr(0, colon));
            const std::string path = trim(rest.substr(colon + 1));
            std::cout << "[OTAService] Flashing " << ip << " with " << path << std::endl;
            std::string err;
            if (flashFirmware(ip, path, err)) {
                std::cout << "[OTAService] Flash " << ip << " OK" << std::endl;
                sendReply("OK\n");
            } else {
                std::cerr << "[OTAService] Flash " << ip << " failed: " << err << std::endl;
                sanitizeOneLine(err);
                sendReply("ERR:" + err + "\n");
            }
        }
    } else if (cmd.compare(0, 16, "OTA_BUILD_FLASH|") == 0) {
        // OTA_BUILD_FLASH|ip|abs_project_dir|board_id  (path must not contain '|')
        std::istringstream iss(cmd);
        std::string token;
        std::vector<std::string> parts;
        while (std::getline(iss, token, '|')) {
            parts.push_back(trim(token));
        }
        if (parts.size() != 4 || parts[0] != "OTA_BUILD_FLASH") {
            sendReply(
                "ERR:bad OTA_BUILD_FLASH — use OTA_BUILD_FLASH|ip|abs_project_dir|board_id\n");
        } else {
            const std::string& ip = parts[1];
            const std::string& proj = parts[2];
            int bid = std::atoi(parts[3].c_str());
            if (ip.empty() || proj.empty()) {
                sendReply("ERR:empty ip or project path\n");
            } else {
                std::cout << "[OTAService] Build+flash " << ip << " project " << proj
                          << " board_id " << bid << std::endl;
                std::string err;
                std::string buildOut;
                if (buildAndFlash(ip, proj, bid, err, buildOut)) {
                    std::cout << "[OTAService] Build+flash " << ip << " OK" << std::endl;
                    sendReply("OK\n");
                } else {
                    std::cerr << "[OTAService] Build+flash failed: " << err << std::endl;
                    sanitizeOneLine(err);
                    sendReply("ERR:" + err + "\n");
                }
            }
        }
    } else if (!cmd.empty()) {
        sendReply("ERR:unknown command\n");
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
            std::cout
                << "Usage: " << argv[0] << " [--port PORT]\n"
                << "  OTA_FLASH:<ip>:<firmware.bin>\n"
                << "  OTA_BUILD_FLASH|ip|abs_platformio_project_dir|board_id (0=no ID flag)\n";
            return 0;
        }
    }

    signal(SIGINT, signalHandler);
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
        struct sockaddr_in addr {};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(listen_port);
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
    std::cout << "[OTAService] OTA_FLASH:… and OTA_BUILD_FLASH|ip|dir|board_id" << std::endl;

    while (g_running) {
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(listen_fd, &rd);
        struct timeval tv {
            .tv_sec = 1, .tv_usec = 0
        };
        if (select(listen_fd + 1, &rd, nullptr, nullptr, &tv) <= 0)
            continue;

        int client_fd = accept(listen_fd, nullptr, nullptr);
        if (client_fd < 0)
            continue;

        std::thread([client_fd]() {
            handleClient(client_fd);
        }).detach();
    }

    close(listen_fd);
    std::cout << "[OTAService] Stopped." << std::endl;
    return 0;
}
