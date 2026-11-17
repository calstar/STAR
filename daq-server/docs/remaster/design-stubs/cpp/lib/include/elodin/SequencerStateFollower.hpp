// DESIGN STUB (DESIGN-WP8 §2.3, pass 2; name per D43(2)/STYLE-S1) — not compiled. Becomes
// diablo_server/lib/include/elodin/SequencerStateFollower.hpp (+
// lib/src/elodin/SequencerStateFollower.cpp).
//
// The subscriber loop heartbeat_service and stacklight_service share: follow [0x50,0x00]
// (_SEQUENCER_STATE) and report current_state on every row.
//
// Owns:       its ElodinClient (on its own stack) for the duration of the call; nothing else.
// Call form:  each main keeps its file-static wrapper `elodinThread(std::string host, uint16_t
//             port)` (heartbeat_service_main.cpp:103, stacklight 99) and replaces its body with
//             one call to follow_sequencer_state(host, port, fsw::service::running(), <timeout>,
//             <text>, <on_state>), so the std::thread lines 271 and 295 stay byte-identical. The
//             alternative, std::thread(follow_sequencer_state, host, port,
//             std::ref(fsw::service::running()), …), needs std::ref because std::thread
//             decay-copies its arguments and std::atomic<bool> is non-copyable; not chosen (it
//             edits 271/295).
// Threads:    the thread the main creates for it, joined where it is joined today (296, 344-345).
//             Runs until `running` is false; it notices only between reads, so with the db up the
//             exit latency is ≤ recv_timeout_ms (heartbeat 3000, stacklight 500: the lifecycle
//             shutdown bounds cite the mains' constants by name, so those constants stay in the
//             mains, DESIGN-WP8 §5). EINTR on the SO_RCVTIMEO read is retried inside the
//             transport, as today (research §0.2).
// Back-off:   the 2 s sleep_for on connect failure (heartbeat 109, stacklight 105) is
//             UNINTERRUPTIBLE — not sliced on `running`. With elodin-db down a stop is noticed only
//             between connect attempts, so the exit bound is ≈ 2 s, not recv_timeout_ms;
//             lifecycle/golden/shutdown.txt:7 records stacklight [0, 1.2] s with the db up (it is
//             killed later). A latency fact, not a tunable; kept as is (DESIGN-WP8 team
//             question 5).
// Errors:     connect failure → 2 s sleep, retry. subscribe failure → text.subscribe_failed to
//             cerr, disconnect, retry at once. read error → text.read_failed_prefix <<
//             client.last_error() << ") — reconnecting" to cerr (heartbeat), or silently
//             (nullptr, stacklight); then disconnect. n < 8: continue. Nothing is fatal. The
//             nullptr-or-literal field is data (the shape of StopSignals' `line` and D45's
//             send_msg), not a configuration knob (STYLE-S12, S34).
// Must not know: fsw::service (`running` is the caller's atomic; this TU does not include
//             StopSignals.hpp); what a state means (on_state decides: heartbeat maps it to an
//             engine state, stacklight stores it); the services' sockets and send loops. Not a
//             generic SubscriberLoop (rejected, DESIGN-WP8 §0): one table, one layout, two users.
// Contract:   the subscribe request bytes (len=6 ty=0 id=[0x11,0x0d] payload 50 00) and the
//             state→output map — packets/golden/service_{heartbeat,stacklight}.txt;
//             lifecycle/golden/startup.txt; DESIGN-WP8 §7.2 gap 7 (reconnect, refused; before
//             pass 2, after C1).
// Static init: none. No identifier spelled `main`.
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

/** heartbeat_service_main.cpp:103-152 statement for statement: connect (sleep_for(2 s) on
 *  failure) → subscribe_tables({[0x50, 0x00]}) → set_recv_timeout_ms(recv_timeout_ms) → log
 *  connected → read_packet into a 4096-byte stack buffer; buf[5]/buf[6] == 0x50/0x00 and
 *  n >= 17 → on_state(buf[16]). Runs until `running` is false. */
void follow_sequencer_state(const std::string& host, uint16_t port,
                            const std::atomic<bool>& running, int recv_timeout_ms,
                            const SequencerStateFollowerText& text,
                            const std::function<void(uint8_t)>& on_state);

}  // namespace fsw::elodin
