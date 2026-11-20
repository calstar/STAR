// DESIGN STUB (DESIGN-WP10 §4.3, commit 1) — not compiled. Becomes
// diablo_server/daq_bridge/BackendLogForwarder.hpp, header-only (the class is all-inline today:
// daq_bridge_main.cpp 49-90 moves verbatim, leaving its anonymous namespace for the global one).
// This stub shows the declarations; the real header keeps today's inline bodies.
//
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

#include <netinet/in.h>

#include <cstdint>
#include <string>

class BackendLogForwarder {
public:
    BackendLogForwarder(const std::string& host, uint16_t port);
    ~BackendLogForwarder();
    bool ready() const;
    void forward(uint8_t board_id, uint8_t flags, const uint8_t* text, uint16_t text_len);

private:
    int sock_ = -1;
    sockaddr_in dest_{};
};
