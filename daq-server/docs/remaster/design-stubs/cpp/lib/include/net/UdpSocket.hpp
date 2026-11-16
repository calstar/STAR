// DESIGN STUB (DESIGN-WP8 §2.2) — not compiled. Becomes diablo_server/lib/include/net/UdpSocket.hpp
// (+ lib/src/net/UdpSocket.cpp in fsw_daq_lib).
//
// The two statement sequences B1's UDP senders share: create a datagram socket (optionally
// broadcast-enabled) and fill an IPv4 destination.
//
// Owns:       nothing. openUdpSocket returns a raw fd and the caller owns it: where and when it is
//             closed is observable (heartbeat closes before joining its Elodin thread;
//             AbortBroadcaster opens and closes one per send), so there is no owning type
//             (STYLE-S21; RAII rejected, DESIGN-WP8 amendment A).
// Threads:    the caller's. No locks.
// Errors:     openUdpSocket: -1 with errno from socket() untouched; the SO_BROADCAST setsockopt
//             result is ignored, as today. ipv4Destination: returns inet_pton(...) == 1. Neither
//             logs: each caller keeps its own text and exit code (`[<Tag>] socket() failed` + exit
//             1; `Invalid broadcast IP: …`; config_broadcast counts tx_bad_addr and skips).
// Must not know: SO_SNDTIMEO (AbortBroadcaster sets it after its bind, in its own code), the DAQ
//             NIC (callers call bindToDaqInterface themselves and keep ignoring or checking its
//             result as today: `// Kept: D-BIND` in pass 2), packet formats (B4 parked).
// Contract:   UDP bytes and destinations — packets/golden/service_{heartbeat,stacklight,
//             config_broadcast,abort}.txt; lifecycle/golden/startup.txt.
#pragma once

#include <netinet/in.h>

#include <cstdint>
#include <string>

namespace fsw::net {

/** socket(AF_INET, SOCK_DGRAM, 0); if `broadcast`, setsockopt(SO_BROADCAST, 1), result ignored. */
int openUdpSocket(bool broadcast);

/** Zero `out`; sin_family = AF_INET; sin_port = htons(port); inet_pton(AF_INET, ip, &sin_addr).
 *  Returns whether inet_pton returned 1. */
bool ipv4Destination(const std::string& ip, uint16_t port, sockaddr_in& out);

}  // namespace fsw::net
