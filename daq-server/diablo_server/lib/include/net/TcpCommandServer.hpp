// The accept loop two command ports share with identical syscalls and branches: the sequencer's
// :9998 (services/sequencer/sequencer_main.cpp) and the controller's :9999 fire gate
// (services/controller/controller_main.cpp). The Conn/reap_finished block, the loop and the
// shutdown/join tail moved here from the sequencer's main; the controller's copy was deleted. The
// one textual change is the spawn lambda: it calls on_client(fd) where the mains called
// handleClient(fd, svc) / handleControlClient(fd, svc). Unobservable (DESIGN-WP8 §2.2).
// Listener setup is NOT here: each main opens, binds, listens on and closes its own socket; a
// callee that closes on bind failure would invert the caller's log -> close order (DESIGN-WP8 §0,
// Rejected: openTcpListener).
//
// Owns:       the Conn vector (on the calling thread's stack) and one tracked thread per client,
//             all joined before it returns. It BORROWS listen_fd and never closes it — the main
//             does, after this returns.
// Threads:    runs on the caller's thread (sequencer: main; controller: its detached control
//             thread, which stays detached — C4-5's >3 s exit). It touches the Conn vector only
//             from that thread; client threads publish completion via Conn::done (atomic).
//             on_client runs on the client thread and owns the client fd: it closes it (the mains'
//             handlers do, as their last statement). on_client outlives every client thread
//             (joined before return), so a [&svc] capture of a stack object is safe.
// Order:      while (running) { reap; select(listen_fd, 10 ms); accept; reap; if (conns >= max)
//             { send "ERR:too many connections\n" with MSG_NOSIGNAL; cerr << busy_log_prefix <<
//             "client limit (" << max << ") reached — refusing connection" << endl; close;
//             continue; } spawn on_client(fd) then done = true }. After the loop: shutdown(fd,
//             SHUT_RDWR) for EVERY tracked connection, then join every thread. Joining before
//             shutting down would wait out each client's 5 s SO_RCVTIMEO; keep the order.
//             Frozen race (LEDGER D-FD): a finished-but-unreaped client already closed its fd,
//             which may have been reused; shutdown() is still called on that number. Fix shape
//             and owner: DESIGN-WP8 §8 (not WP8's).
// Errors:     none returned. select/accept errors: continue, as before. Nothing is logged here
//             except the busy line, whose prefix is the caller's (STYLE-S12).
// Literals:   the mains' one literal "[Sequencer] client limit (" / "[ControllerService] ⚠️
//             client limit (" became prefix + "client limit (" — the STYLE-S15 literal multiset
//             changed and the adoption commits say so (DESIGN-WP8 §2.2).
// Must not know: fsw::service (`running` is the caller's atomic — each main passes its g_running,
//             the namespace-scope reference to fsw::service::running(); this TU does not include
//             StopSignals.hpp); the line protocol, read discipline (512-byte lines / first 64
//             bytes stay in each main), reply texts, any service object. on_client reaches a
//             service only through its public, enqueueing API (SequencerService's
//             transitionTo/setDebugMode/manualActuator/extendFire/scriptStatusReport;
//             ControllerService::setFireActive): never a do* body (D42 binding 1).
// Contract:   test/characterization/sequencer/golden/* (every reply, CRLF, two commands per
//             write, oversize close, the 65th client's busy reply and log bytes on both ports),
//             sequencer/golden/controller__*, lifecycle/golden/shutdown.txt ("command port still
//             accepting: False"; exit within [0, 1] s with an idle client held).
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
