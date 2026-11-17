// DESIGN STUB (DESIGN-WP8 §2.2, pass 2; re-cut by the WP8 debate verdict) — not compiled. Becomes
// diablo_server/lib/include/net/TcpCommandServer.hpp
// (+ lib/src/net/TcpCommandServer.cpp in fsw_daq_lib).
//
// The accept loop two command ports share statement for statement (sequencer_main.cpp:282-349,
// controller_main.cpp:151-214: the Conn/reap_finished block, the loop, the shutdown/join tail).
// Listener setup is NOT here: each main opens, binds, listens on and closes its own socket as
// today (sequencer 252-276/351, controller 128-147/216, ota 410-434/456); openTcpListener was
// dropped because a callee that closes on bind failure inverts the caller's log → close order at
// all three sites (DESIGN-WP8 §0, Rejected).
//
// Owns:       the Conn vector (on the calling thread's stack; Conn and reap_finished moved
//             verbatim from sequencer_main.cpp:284-301 with their leading comment 282-283, S38;
//             the controller's copy 151-169 is deleted with its comment) and one tracked thread
//             per client, all joined before it returns. It BORROWS listen_fd and never closes it.
//             Both mains lose the whole block: a Conn and a reap_finished left behind with no loop
//             are -Wunused-variable, and baseline_warnings.txt admits no new line.
// Threads:    runs on the caller's thread (sequencer: main; controller: its detached control
//             thread, which stays detached — C4-5's >3 s exit). It touches the Conn vector only
//             from that thread; client threads publish completion via Conn::done (atomic).
//             on_client runs on the client thread and owns the client fd: it closes it (today's
//             handlers do, last statement: sequencer 221, controller 124). on_client outlives
//             every client thread (joined before return), so a [&svc] capture of a stack object
//             is safe, as today.
// Order:      while (running) { reap; select(listen_fd, 10 ms); accept; reap; if (conns ≥ max)
//             { send "ERR:too many connections\n" with MSG_NOSIGNAL; cerr << busy_log_prefix <<
//             "client limit (" << max << ") reached — refusing connection" << endl; close;
//             continue; } spawn on_client(fd) then done = true }. After the loop: shutdown(fd,
//             SHUT_RDWR) for EVERY tracked connection, then join every thread. Joining before
//             shutting down would wait out each client's 5 s SO_RCVTIMEO; keep the order.
//             Frozen race (D-FD): a finished-but-unreaped client already closed its fd, which may
//             have been reused; shutdown() is still called on that number. Fix shape and owner:
//             DESIGN-WP8 §8 (not WP8's).
// Errors:     none returned. select/accept errors: continue, as today. Nothing is logged here
//             except the busy line, whose prefix is the caller's (STYLE-S12).
// Literals:   today's one literal "[Sequencer] client limit (" / "[ControllerService] ⚠️  client
//             limit (" becomes prefix + "client limit (" — the S15 literal multiset changes and
//             the adoption commit lists it (DESIGN-WP8 §2.2).
// Must not know: fsw::service (`running` is the caller's atomic — each main passes its g_running,
//             the namespace-scope reference to fsw::service::running(); this TU does not include
//             StopSignals.hpp); the line protocol, read discipline (512-byte lines / first 64
//             bytes stay in each main), reply texts, any service object. **on_client reaches a
//             service only through its public, enqueueing API** (SequencerService's
//             transitionTo/setDebugMode/manualActuator/extendFire/scriptStatusReport;
//             ControllerService::setFireActive): never a do* body (D42 binding 1; do* are private).
// Contract:   sequencer/golden/* (every reply, CRLF, two commands per write, oversize close),
//             sequencer/golden/controller__*, lifecycle/golden/shutdown.txt ("command port still
//             accepting: False"), DESIGN-WP8 §7.2 gap 5 (busy reply and log bytes, 64 held
//             connections) — the one gate of pass 2, which is pass 2's only piece (D57): gap 5
//             not merged green → pass 2 is not queued, this loop stays in its two mains.
// Static init: none. No identifier spelled `main`.
#pragma once

#include <atomic>
#include <cstddef>
#include <functional>

namespace fsw::net {

struct TcpServeOptions {
    size_t max_clients;           // 64 for both users; the named constants stay in the mains
    const char* busy_log_prefix;  // "[Sequencer] " | "[ControllerService] ⚠️  " (two spaces)
};

/** The shared accept loop (see Order above). The 10 ms select timeout is a constant inside, not
 *  a parameter: both users pass the same value (STYLE-S34). Borrows listen_fd; never closes it. */
void serveTcpClients(int listen_fd, const std::atomic<bool>& running, const TcpServeOptions& opts,
                     const std::function<void(int)>& on_client);

}  // namespace fsw::net
