// Forwards parsed board LOG text to the Node backend over loopback UDP. Envelope (little-endian):
// [board_id:u8][flags:u8][text_len:u16][text bytes]. Board logs deliberately do NOT go to Elodin.
//
// Owns:       one UDP socket fd (opened in the constructor, closed in the destructor — RAII is
//             today's behaviour here, so it stays) and the destination address.
// Threads:    daq_bridge's single thread.
// Errors:     socket() failure → ready() false (main logs it at 486-490); inet_pton's result is
//             ignored (as today); a failed sendto is ignored. Never throws.
// Must not know: Elodin, board identity (main resolves board_id), the backend's parsing.
// Contract:   log envelope bytes — packets/golden/service_daq_bridge.txt.
// Cleanup:    none for the socket: WP8 shares no UDP helper (its openUdpSocket / ipv4Destination
//             were dropped by the WP8 debate verdict, D54), so socket creation and the destination
//             fill stay here verbatim; the ignored inet_pton result must stay ignored.
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

// Forwards parsed board-log text to the Node backend over UDP (loopback). The
// backend caches it in memory and pushes it to the GUI — logs deliberately do
// NOT go to Elodin (no need to replay board logs for past runs).
//
// Envelope (little-endian): [board_id:u8][flags:u8][text_len:u16][text bytes].
class BackendLogForwarder {
public:
    BackendLogForwarder(const std::string& host, uint16_t port) {
        sock_ = socket(AF_INET, SOCK_DGRAM, 0);
        std::memset(&dest_, 0, sizeof(dest_));
        dest_.sin_family = AF_INET;
        dest_.sin_port = htons(port);
        inet_pton(AF_INET, host.c_str(), &dest_.sin_addr);
    }
    ~BackendLogForwarder() {
        if (sock_ >= 0)
            close(sock_);
    }

    bool ready() const {
        return sock_ >= 0;
    }

    void forward(uint8_t board_id, uint8_t flags, const uint8_t* text, uint16_t text_len) {
        if (sock_ < 0)
            return;
        std::vector<uint8_t> env;
        env.reserve(4u + text_len);
        env.push_back(board_id);
        env.push_back(flags);
        env.push_back(static_cast<uint8_t>(text_len & 0xFF));
        env.push_back(static_cast<uint8_t>((text_len >> 8) & 0xFF));
        if (text && text_len)
            env.insert(env.end(), text, text + text_len);
        sendto(sock_, env.data(), env.size(), 0, reinterpret_cast<sockaddr*>(&dest_),
               sizeof(dest_));
    }

private:
    int sock_ = -1;
    sockaddr_in dest_{};
};
