// DESIGN STUB (DESIGN-WP8 §2.3) — not compiled. Becomes
// diablo_server/lib/include/net/TcpCommandServer.hpp
// (+ lib/src/net/TcpCommandServer.cpp in fsw_daq_lib).
//
// The listen-socket setup three command ports share (sequencer :9998, controller :9999, ota), and
// the accept loop two of them share statement for statement (sequencer_main.cpp:282-351,
// controller_main.cpp:151-216).
//
// Owns:       openTcpListener: nothing on success (the caller owns the fd and closes it after
//             serveTcpClients returns, as today); on socket/bind failure it closes the fd itself.
//             serveTcpClients: the Conn vector (on the calling thread's stack) and one tracked
//             thread per client, all joined before it returns. It does NOT own or close listen_fd.
// Threads:    serveTcpClients runs on the caller's thread (sequencer: main; controller: its
//             detached control thread, which stays detached — C4-5's >3 s exit). It touches the
//             Conn vector only from that thread; client threads publish completion via
//             Conn::done (atomic). on_client runs on the client thread and owns the client fd: it
//             closes it (today's handlers do, last statement).
// Order:      while (running) { reap; select(listen_fd, 10 ms); accept; reap; if (conns ≥ max)
//             { send "ERR:too many connections\n" with MSG_NOSIGNAL; cerr << busy_log_prefix <<
//             "client limit (" << max << ") reached — refusing connection" << endl; close;
//             continue; } spawn on_client(fd) then done = true }. After the loop: shutdown(fd,
//             SHUT_RDWR) for EVERY tracked connection, then join every thread. Joining before
//             shutting down would wait out each client's 5 s SO_RCVTIMEO; keep the order.
//             Frozen race (D-FD, candidate): a finished-but-unreaped client already closed its fd,
//             which may have been reused; shutdown() is still called on that number.
// Errors:     TcpListener::failed + err (errno of the failing call); nothing is logged here. The
//             caller decides (STYLE-S12): sequencer and ota log and exit 1; the controller logs
//             socket/bind failures with strerror(err) and returns from its control thread (the
//             service keeps running without its port), and falls through on kListen with the fd
//             open (`// Kept: D-CTL (D17)` in pass 2). select/accept errors: continue, as today.
// Must not know: the line protocol, read discipline (512-byte lines / first 64 bytes / ota's
//             byte-at-a-time stay in each main), reply texts, any service object. **on_client
//             reaches a service only through its public, enqueueing API** (SequencerService's
//             transitionTo/setDebugMode/manualActuator/extendFire/scriptStatusReport;
//             ControllerService::setFireActive): never a do* body (D42 binding 1; do* are private).
// Contract:   sequencer/golden/* (every reply, CRLF, two commands per write, oversize close),
//             sequencer/golden/controller__*, lifecycle/golden/{ota,shutdown}.txt ("command port
//             still accepting: False"), DESIGN-WP8 §7.2 gaps 5-6 (busy reply and log bytes,
//             listener failure ladders).
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>

namespace fsw::net {

struct TcpListener {
    enum class Failed { kNone, kSocket, kBind, kListen };
    int fd = -1;                    // open unless failed is kSocket or kBind
    Failed failed = Failed::kNone;  // kListen: fd returned OPEN (the controller keeps serving)
    int err = 0;                    // errno of the failing call
};

/** socket(SOCK_STREAM) → SO_REUSEADDR = 1 (result ignored) → bind(INADDR_ANY:port) →
 *  listen(backlog). Backlogs: sequencer 10, controller 4, ota 5. */
TcpListener openTcpListener(uint16_t port, int backlog);

struct TcpServeOptions {
    size_t max_clients;           // 64 for both users
    const char* busy_log_prefix;  // "[Sequencer] " | "[ControllerService] ⚠️  " (two spaces)
};

/** The shared accept loop (see Order above). The 10 ms select timeout is a constant inside, not
 *  a parameter: both users pass the same value (STYLE-S34). */
void serveTcpClients(int listen_fd, const std::atomic<bool>& running, const TcpServeOptions& opts,
                     const std::function<void(int)>& on_client);

}  // namespace fsw::net
