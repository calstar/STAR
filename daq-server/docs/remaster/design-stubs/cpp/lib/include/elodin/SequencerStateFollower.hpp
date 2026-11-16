// DESIGN STUB (DESIGN-WP8 §2.4; name AMENDED per D43(2)/STYLE-S1) — not compiled. Becomes
// diablo_server/lib/include/elodin/SequencerStateFollower.hpp (+
// lib/src/elodin/SequencerStateFollower.cpp).
//
// The subscriber loop heartbeat_service and stacklight_service share: follow [0x50,0x00]
// (_SEQUENCER_STATE) and report current_state on every row.
//
// Owns:       its ElodinClient (on its own stack) for the duration of the call; nothing else.
// Threads:    the thread the main creates for it (heartbeat_service_main.cpp:271, stacklight 295),
//             joined where it is joined today (296, 344-345). Runs until `running` is false; it
//             notices only between reads, so exit latency is ≤ recv_timeout_ms (heartbeat 3000,
//             stacklight 500: the lifecycle shutdown bounds cite the mains' constants by name, so
//             those constants stay in the mains, DESIGN-WP8 §5). EINTR on the SO_RCVTIMEO read is
//             retried inside the transport, as today (research §0.2).
// Errors:     connect failure → 2 s sleep, retry. subscribe failure → text.subscribe_failed to
//             cerr, disconnect, retry at once. read error → text.read_failed_prefix <<
//             client.last_error() << ") — reconnecting" to cerr (heartbeat), or silently
//             (nullptr, stacklight); then disconnect. n < 8: continue. Nothing is fatal.
// Must not know: what a state means (on_state decides: heartbeat maps it to an engine state,
//             stacklight stores it), the services' sockets and send loops. Not a generic
//             SubscriberLoop (rejected, DESIGN-WP8 §0): one table, one layout, these two users.
// Contract:   the subscribe request bytes (len=6 ty=0 id=[0x11,0x0d] payload 50 00) and the
//             state→output map — packets/golden/service_{heartbeat,stacklight}.txt;
//             lifecycle/golden/startup.txt; DESIGN-WP8 §7.2 gap 7 (reconnect, refused).
// Static init: none.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

namespace fsw::elodin {

struct SequencerStateFollowerText {
    const char* subscribe_failed;    // cerr, whole line
    const char* connected;           // cout, whole line
    const char* read_failed_prefix;  // cerr prefix; nullptr = drop the socket silently
};

/** heartbeat_service_main.cpp:103-152 statement for statement: connect → subscribe_tables({[0x50,
 *  0x00]}) → set_recv_timeout_ms(recv_timeout_ms) → log connected → read_packet into a 4096-byte
 *  stack buffer; buf[5]/buf[6] == 0x50/0x00 and n >= 17 → on_state(buf[16]). */
void follow_sequencer_state(const std::string& host, uint16_t port,
                            const std::atomic<bool>& running, int recv_timeout_ms,
                            const SequencerStateFollowerText& text,
                            const std::function<void(uint8_t)>& on_state);

}  // namespace fsw::elodin
