/**
 * SequencerService under concurrent command load.
 *
 * The bug this guards against: SequencerService had no serialization at all. Fields were atomic,
 * but a transition is a multi-step sequence built out of them — stop the actuator republish loop,
 * apply actuators, restart the loop, assign the state, arm the burn — and atomics on the steps do
 * nothing for the sequence. sequencer_main spawns a thread per TCP client, and FireManager's timer
 * thread calls back into transitionTo when a burn expires, so two threads could run that sequence
 * at once.
 *
 * The concrete failure is in ActuatorCommander::stopContinuousLoop(): `if (loop_thread_.joinable())
 * loop_thread_.join();`. Two threads passing the joinable() check together both call join() on the
 * same std::thread — a double pthread_join, which is undefined behaviour — and then both
 * move-assign a fresh thread onto the handle, which is a std::terminate if the other's assignment
 * landed first.
 *
 * ── How this test actually catches it ──────────────────────────────────────────────────────────
 * A plain -O2 build does NOT reliably crash: a pre-fix binary survived 1016 commands over 65 s,
 * because glibc tolerates a double pthread_join often enough that the window is rarely fatal. That
 * is worse than a crash, not better — in production it silently corrupts thread bookkeeping.
 *
 * Under ThreadSanitizer the same code fails immediately and unambiguously:
 *
 *   ThreadSanitizer: CHECK failed: sanitizer_thread_registry.cpp:348 "((t)) != (0)"
 *     #3 pthread_join
 *     #4 std::thread::join()
 *     #5 ActuatorCommander::stopContinuousLoop()  ActuatorCommander.cpp
 *     #6 SequencerService::transitionTo(State)
 *     #8 handleClient                             sequencer_main.cpp
 *
 * (ConsumeThreadUserId returning 0 = the thread being joined was already consumed by another
 * join.) Pre-fix died 0.2 s in at ~50 commands; post-fix ran 746 commands over 25.9 s clean.
 *
 * So: run this test under TSan to make it a real detector. Without TSan it is still a useful
 * smoke test — it asserts the service stays alive and functional under load, and it would catch
 * a deadlock or a hang, which the command-queue design is the other main risk of.
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "control/SequencerService.hpp"
#include "control/StateMachine.hpp"

using sequencer::SequencerService;
using sequencer::State;
using sequencer::StateMachine;
using Clock = std::chrono::steady_clock;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** Minimal stand-in for controller_service: accept, drain, close. Without it every fire
 *  transition pays notifyControllerFire's connect timeout and the test crawls. */
static void fakeController(int listen_fd, std::atomic<bool>& run) {
    while (run) {
        struct timeval tv{.tv_sec = 0, .tv_usec = 100000};
        setsockopt(listen_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        int c = accept(listen_fd, nullptr, nullptr);
        if (c < 0)
            continue;
        char buf[128];
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        (void)recv(c, buf, sizeof(buf), 0);
        close(c);
    }
}

static int bindEphemeral(uint16_t& out_port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    struct sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    bind(fd, reinterpret_cast<struct sockaddr*>(&a), sizeof(a));
    listen(fd, 8);
    socklen_t len = sizeof(a);
    getsockname(fd, reinterpret_cast<struct sockaddr*>(&a), &len);
    out_port = ntohs(a.sin_port);
    return fd;
}

int main() {
    std::cout << "=== SequencerService concurrency ===" << std::endl;

    uint16_t ctrl_port = 0;
    int ctrl_fd = bindEphemeral(ctrl_port);
    std::atomic<bool> ctrl_run{true};
    std::thread ctrl_thread(fakeController, ctrl_fd, std::ref(ctrl_run));

    // Short burn window so the fire timer expires repeatedly during the storm — the expiry
    // callback is the second thread that enters the state machine, and the one a naive mutex
    // would have deadlocked against.
    const std::string cfg_path = "test_concurrency_cfg.toml";
    {
        std::ofstream f(cfg_path);
        f << "[database]\nhost=\"127.0.0.1\"\nport=1\n\n"
          << "[controller_service]\nhost=\"127.0.0.1\"\nport=" << ctrl_port << "\n\n"
          << "[fire]\nstate=\"Fire\"\nexpiry_target=\"Armed\"\n"
          << "duration_ms=250\nextended_ms=500\n";
    }

    SequencerService svc;
    if (!svc.init(cfg_path)) {
        std::cerr << "FAILED: init (run from the build dir, with config/ reachable)" << std::endl;
        ctrl_run = false;
        ctrl_thread.join();
        close(ctrl_fd);
        std::remove(cfg_path.c_str());
        return 1;
    }
    // Debug mode: this test is about concurrent execution, not about which transitions the CSV
    // permits. Without it most of the storm is rejected before touching the actuator loop, which
    // is exactly the code path under test.
    svc.setDebugMode(true);

    // A fixed number of transitions per thread rather than "hammer for N seconds". Coverage is
    // then identical everywhere, instead of being a function of how fast the box is — which
    // matters because this test is meant to run under TSan, where throughput drops by roughly a
    // third, and on CI runners that are slower again. The pre-fix binary died at ~50 transitions
    // under TSan, so this is comfortable margin.
    constexpr int kThreads = 12;
    constexpr int kIterationsPerThread = 20;
    std::atomic<int> issued{0};
    const char* targets[] = {"Idle", "Armed", "Fire", "Engine Abort"};

    const auto t0 = Clock::now();
    std::vector<std::thread> workers;
    for (int i = 0; i < kThreads; ++i) {
        workers.emplace_back([&, i]() {
            int n = i;
            for (int k = 0; k < kIterationsPerThread; ++k) {
                svc.transitionTo(std::string(targets[n++ % 4]));
                issued++;
            }
        });
    }
    for (auto& w : workers)
        w.join();
    const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();

    // Reaching here at all is the headline assertion: pre-fix, this is where the process died
    // under TSan. A hang instead of a crash is caught by the CTest timeout on this test.
    check(true, "survived concurrent transitions (no double-join / terminate)");
    check(issued.load() == kThreads * kIterationsPerThread,
          "every transition completed (" + std::to_string(issued.load()) + "/" +
              std::to_string(kThreads * kIterationsPerThread) + " in " +
              std::to_string(elapsed_ms) + " ms)");

    // Still functional afterwards — a queue that wedged or deadlocked would fail here rather than
    // crashing, and that is the main risk the command-queue design introduces.
    const bool accepted = svc.transitionTo(std::string("Idle"));
    check(accepted, "service still accepts commands after the storm");
    check(svc.currentState() == StateMachine::fromName("Idle"),
          "reported state matches the last accepted transition");

    ctrl_run = false;
    ctrl_thread.join();
    close(ctrl_fd);
    std::remove(cfg_path.c_str());

    std::cout << (g_failures == 0 ? "✅ PASS" : "❌ FAIL") << std::endl;
    return g_failures == 0 ? 0 : 1;
}
