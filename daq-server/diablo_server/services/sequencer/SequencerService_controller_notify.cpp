#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "comms/CommsMessage.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "control/SequencerService.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "net/DaqInterface.hpp"

namespace sequencer {

// How long notifyControllerFire() waits for the controller_service TCP connection before giving
// up. Deliberately short: this is on the state-transition path, and a missed FIRE_START/FIRE_STOP
// is recoverable (the controller also watches the sequencer state packet) while a stalled
// transition is not.
static constexpr int kControllerConnectTimeoutMs = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Elodin publishing
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Tell controller_service the burn gate changed. One TCP connection per message, 1 s send timeout.
 *
 * This lives here rather than in the hold timer so exactly one component talks to the
 * controller — previously the timer opened its own socket AND the backend independently saw the
 * FIRE edge and sent the same messages, so a safety-critical gate had two writers in two processes.
 */
void SequencerService::notifyControllerFire(bool active) {
    if (notifyControllerFireOnce(active))
        return;
    // One retry, driven by evidence rather than blind repetition: we know the first attempt was
    // not acted on, because the controller did not answer. Repeating a command that *was* acted
    // on is harmless here — both commands are idempotent level settings, not edges.
    std::cerr << "[SequencerService] retrying " << (active ? "FIRE_START" : "FIRE_STOP")
              << " to controller_service" << std::endl;
    if (notifyControllerFireOnce(active))
        return;
    std::cerr << "[SequencerService] ❌ controller_service did not acknowledge "
              << (active ? "FIRE_START" : "FIRE_STOP") << " at " << controller_host_ << ":"
              << controller_port_
              << " after 2 attempts — the PWM gate is NOT under sequencer control. The controller "
                 "falls back to the Elodin sequencer-state parity path; verify the burn ended."
              << std::endl;
}

bool SequencerService::notifyControllerFireOnce(bool active) {
    const std::string msg = active ? "FIRE_START\n" : "FIRE_STOP\n";
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0)
        return false;
    struct timeval tv{.tv_sec = 1, .tv_usec = 0};
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(controller_port_);
    if (inet_pton(AF_INET, controller_host_.c_str(), &dest.sin_addr) != 1) {
        close(sock);
        return false;
    }

    // SO_SNDTIMEO above does NOT bound connection establishment. On a blocking socket, connect()
    // to a host that drops SYNs rather than refusing them (powered off but still routable, or a
    // network partition) sits in the kernel's SYN retry budget for ~2 minutes. This runs on
    // whichever thread is performing the state transition — including an operator aborting out of
    // FIRE — so an unreachable controller used to stall the abort itself. Bound it explicitly:
    // non-blocking connect, wait with a deadline, then restore blocking mode for the send.
    const int flags = fcntl(sock, F_GETFL, 0);
    if (flags < 0 || fcntl(sock, F_SETFL, flags | O_NONBLOCK) < 0) {
        close(sock);
        return false;
    }

    bool connected = false;
    if (connect(sock, reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest)) == 0) {
        connected = true;  // immediate (loopback)
    } else if (errno == EINPROGRESS) {
        struct pollfd pfd{.fd = sock, .events = POLLOUT, .revents = 0};
        // Any readiness at all means the attempt resolved — consult SO_ERROR rather than the
        // revents bits. A refused connection can surface as POLLERR/POLLHUP without POLLOUT, and
        // testing for POLLOUT alone would report that as a timeout and lose the real reason in
        // the log. poll() returning 0 is the only genuine timeout.
        if (poll(&pfd, 1, kControllerConnectTimeoutMs) > 0) {
            int err = 0;
            socklen_t len = sizeof(err);
            if (getsockopt(sock, SOL_SOCKET, SO_ERROR, &err, &len) != 0)
                err = errno;
            if (err == 0)
                connected = true;
            else
                errno = err;
        } else {
            errno = ETIMEDOUT;
        }
    }

    bool acked = false;
    if (connected && fcntl(sock, F_SETFL, flags) == 0) {
        ssize_t n = send(sock, msg.c_str(), msg.size(), 0);
        if (n != static_cast<ssize_t>(msg.size())) {
            std::cerr << "[SequencerService] short send to controller_service (" << n << "/"
                      << msg.size() << "): " << strerror(errno) << std::endl;
        } else {
            // Read the ACK. A successful send() proves nothing: the kernel completes the
            // handshake and buffers the bytes whether or not the controller's accept loop is
            // alive to read them, so a wedged controller used to look identical to a healthy one
            // from here — this function logged the command as delivered either way. The
            // controller answers "OK\n" (controller_main.cpp), and that reply is the only
            // evidence the command actually reached the application.
            struct timeval rtv{.tv_sec = 0, .tv_usec = kControllerConnectTimeoutMs * 1000};
            setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &rtv, sizeof(rtv));
            char reply[16] = {0};
            ssize_t r = recv(sock, reply, sizeof(reply) - 1, 0);
            if (r > 0 && std::string(reply, static_cast<size_t>(r)).rfind("OK", 0) == 0) {
                acked = true;
            } else if (r > 0) {
                std::cerr << "[SequencerService] controller_service refused "
                          << (active ? "FIRE_START" : "FIRE_STOP") << ": "
                          << std::string(reply, static_cast<size_t>(r)) << std::endl;
            } else {
                std::cerr << "[SequencerService] no ACK from controller_service for "
                          << (active ? "FIRE_START" : "FIRE_STOP") << " ("
                          << (r == 0 ? "connection closed" : strerror(errno))
                          << ") — the command may not have been acted on" << std::endl;
            }
        }
    } else {
        std::cerr << "[SequencerService] could not reach controller_service at " << controller_host_
                  << ":" << controller_port_ << " for " << (active ? "FIRE_START" : "FIRE_STOP")
                  << " (" << strerror(errno) << ")" << std::endl;
    }
    close(sock);

    if (acked)
        std::cout << "[SequencerService] → controller: " << (active ? "FIRE_START" : "FIRE_STOP")
                  << " (acked)" << std::endl;
    return acked;
}

}  // namespace sequencer
