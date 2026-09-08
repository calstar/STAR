/**
 * The physical ABORT broadcast must not queue behind the sequencer's own housekeeping.
 *
 * transitionTo() used to fire abort_broadcaster_.triggerAbort() near the END of the function,
 * after stopContinuousLoop() (joins the republish thread, up to ~100 ms), after
 * fire_manager_.stop() — which notifies controller_service over TCP — and after a full actuator
 * batch. None of that is a precondition for telling the boards to abort, and the controller leg
 * was the worst of it: connect() on a blocking socket with no connect timeout, so a controller
 * host that drops SYNs rather than refusing them (powered off but routable, or a partition) held
 * the abort for the kernel's full SYN retry budget. Measured on this machine: 133,348 ms.
 *
 * The abort broadcast is now the first thing transitionTo() does. This test pins that ordering by
 * making the controller unreachable in exactly the way that used to hurt, and asserting the ABORT
 * datagram still lands promptly.
 *
 * ── Why 192.0.2.1 ──────────────────────────────────────────────────────────────────────────────
 * TEST-NET-1 (RFC 5737) is guaranteed not to be routed anywhere, so SYNs are dropped rather than
 * refused. A closed port on localhost is NOT a substitute: it answers RST immediately, so
 * connect() fails fast and the regression is invisible.
 *
 * ── Destination, not just ordering ─────────────────────────────────────────────────────────────
 * The broadcaster now takes its destination and port from [server_heartbeat] rather than sending
 * to the limited broadcast 255.255.255.255 on a hardcoded 5005. This test writes those keys and
 * binds what it wrote, so it also covers the routing: if configure() were skipped, or the address
 * plumbed through wrongly, the datagram would go to the shipped default 192.168.2.255 and never
 * arrive here.
 *
 * A high port is used rather than 5005 so the test does not collide with a real board stack (or
 * another service) on the developer's machine.
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#include "control/SequencerService.hpp"
#include "control/StateMachine.hpp"

using sequencer::SequencerService;
using sequencer::StateMachine;
using Clock = std::chrono::steady_clock;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

// PacketType::ABORT — the first header byte of the broadcast.
static constexpr uint8_t kAbortPacketType = 7;
static constexpr uint16_t kAbortPort = 15005;
// Loopback, so the packet is observable on a box with no board LAN — which is every dev box and
// every CI runner.
static constexpr const char* kAbortIp = "127.0.0.1";

int main() {
    std::cout << "=== Abort ordering (abort must not wait on controller_service) ===" << std::endl;

    // Listener for the abort broadcast, on the address the config below tells the sequencer to
    // send to.
    int udp = socket(AF_INET, SOCK_DGRAM, 0);
    int opt = 1;
    setsockopt(udp, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    struct sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = INADDR_ANY;
    a.sin_port = htons(kAbortPort);
    if (bind(udp, reinterpret_cast<struct sockaddr*>(&a), sizeof(a)) < 0) {
        std::cerr << "SKIP: cannot bind UDP " << kAbortPort << " (" << strerror(errno)
                  << ") — another process is using the abort port" << std::endl;
        close(udp);
        return 0;  // environmental, not a code failure
    }

    std::atomic<bool> got_abort{false};
    std::atomic<long long> abort_at_ms{-1};
    std::atomic<bool> listening{true};
    const auto t0 = Clock::now();
    std::thread listener([&]() {
        while (listening) {
            struct timeval tv{.tv_sec = 0, .tv_usec = 100000};
            setsockopt(udp, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
            uint8_t buf[64];
            ssize_t n = recv(udp, buf, sizeof(buf), 0);
            if (n > 0 && buf[0] == kAbortPacketType && !got_abort.exchange(true)) {
                abort_at_ms =
                    std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0)
                        .count();
            }
        }
    });

    // Controller pointed at a blackhole; a burn configured so we can abort out of FIRE, which is
    // the path that calls fire_manager_.stop() -> notifyControllerFire().
    const std::string cfg_path = "test_abort_ordering_cfg.toml";
    {
        std::ofstream f(cfg_path);
        f << "[database]\nhost=\"127.0.0.1\"\nport=1\n\n"
          << "[server_heartbeat]\nbroadcast_ip=\"" << kAbortIp
          << "\"\nbroadcast_port=" << kAbortPort << "\n\n"
          << "[controller_service]\nhost=\"192.0.2.1\"\nport=8000\n\n"
          << "[fire]\nstate=\"Fire\"\nexpiry_target=\"Armed\"\n"
          << "duration_ms=30000\nextended_ms=60000\n";
    }

    SequencerService svc;
    if (!svc.init(cfg_path)) {
        std::cerr << "FAILED: init (run from the build dir, with config/ reachable)" << std::endl;
        listening = false;
        listener.join();
        close(udp);
        std::remove(cfg_path.c_str());
        return 1;
    }
    svc.setDebugMode(true);  // the ordering is the subject here, not the CSV's allowed transitions

    // Enter FIRE. This already pays one blackholed connect (FIRE_START).
    svc.transitionTo(std::string("Fire"));
    got_abort = false;
    abort_at_ms = -1;

    // Now abort out of it. Pre-fix, the broadcast sat behind the republish-thread join, the
    // FIRE_STOP connect, and the actuator batch.
    const auto abort_issued = Clock::now();
    svc.transitionTo(std::string("Engine Abort"));

    // Give the datagram a moment to be seen even on a slow box.
    for (int i = 0; i < 20 && !got_abort; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(50));

    const long long issued_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(abort_issued - t0).count();
    const long long latency = got_abort ? (abort_at_ms.load() - issued_ms) : -1;

    check(got_abort.load(), "ABORT broadcast was sent");
    if (got_abort) {
        std::cout << "       abort latency: " << latency << " ms" << std::endl;
        // Generous bound, but far below what the pre-fix ordering costs with an unreachable
        // controller: the FIRE_STOP connect alone is 300 ms now (and was ~133 s before it was
        // bounded), and it used to happen BEFORE the broadcast.
        check(latency >= 0 && latency < 200,
              "ABORT went out ahead of the controller notification and the actuator batch");
    }

    listening = false;
    listener.join();
    close(udp);
    std::remove(cfg_path.c_str());

    std::cout << (g_failures == 0 ? "✅ PASS" : "❌ FAIL") << std::endl;
    return g_failures == 0 ? 0 : 1;
}
