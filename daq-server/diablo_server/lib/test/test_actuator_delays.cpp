/**
 * Actuator delay scheduling vs the 1 Hz republish.
 *
 * The delicate part of per-actuator delays is not the timer, it is the interaction with
 * ActuatorCommander's continuous loop, which re-sends every actuator's position once a second so a
 * rebooted board recovers. Two ways that fights a delayed command, both of which this pins:
 *
 *   1. The republish must NOT send the delayed actuator's settled position while its delay is
 *      pending — otherwise any delay longer than the republish period is unobservable, because the
 *      final value has already gone out. (Boards latch their last command, so the actuator is
 *      simply omitted and holds its pre-transition position.)
 *   2. The republish must NOT cancel the pending schedule. Cancellation is keyed to real state
 *      transitions only; an earlier version bumped the generation on every apply and the delayed
 *      stage never fired.
 *
 * Drives the real ActuatorCommander over loopback UDP and asserts on what the "boards" receive.
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "DiabloPacketUtils.h"
#include "control/ActuatorCommander.hpp"
#include "control/StateMachine.hpp"

namespace fs = std::filesystem;
using sequencer::ActuatorCommander;
using sequencer::State;
using Clock = std::chrono::steady_clock;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** One received command burst: when it arrived (ms since t0) and which channels it carried. */
struct Burst {
    long long at_ms;
    std::set<uint8_t> channels;
};

/** Collects UDP actuator packets, folding the 3x retransmit of one batch into a single burst. */
class BoardListener {
public:
    explicit BoardListener(uint16_t port) : port_(port) {}

    bool start() {
        sock_ = socket(AF_INET, SOCK_DGRAM, 0);
        if (sock_ < 0)
            return false;
        int reuse = 1;
        setsockopt(sock_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        struct sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port_);
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
        if (bind(sock_, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
            close(sock_);
            sock_ = -1;
            return false;
        }
        struct timeval tv{.tv_sec = 0, .tv_usec = 50000};
        setsockopt(sock_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        running_ = true;
        t0_ = Clock::now();
        thread_ = std::thread([this]() { run(); });
        return true;
    }

    void stop() {
        running_ = false;
        if (thread_.joinable())
            thread_.join();
        if (sock_ >= 0)
            close(sock_);
    }

    std::vector<Burst> bursts() {
        std::lock_guard<std::mutex> lk(mutex_);
        return bursts_;
    }

private:
    void run() {
        uint8_t buf[1024];
        while (running_) {
            ssize_t n = recv(sock_, buf, sizeof(buf), 0);
            if (n <= 0)
                continue;
            daq::PacketHeader header;
            std::vector<daq::ActuatorCommand> cmds;
            if (!daq::parse_actuator_command_packet(buf, static_cast<size_t>(n), header, cmds))
                continue;
            std::set<uint8_t> chans;
            for (const auto& c : cmds)
                chans.insert(c.actuator_id);
            const long long at =
                std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0_).count();

            std::lock_guard<std::mutex> lk(mutex_);
            // The same batch is retransmitted 3x ~1 ms apart; fold identical content arriving
            // within 50 ms into one burst so assertions talk about batches, not packets.
            if (!bursts_.empty() && bursts_.back().channels == chans &&
                at - bursts_.back().at_ms < 50) {
                continue;  // a retransmit of the burst we already recorded
            }
            bursts_.push_back({at, chans});
        }
    }

    uint16_t port_;
    int sock_ = -1;
    std::atomic<bool> running_{false};
    std::thread thread_;
    std::mutex mutex_;
    std::vector<Burst> bursts_;
    Clock::time_point t0_;
};

static std::string writeFixture(const fs::path& dir, uint16_t port, double slow_delay_s) {
    std::ofstream act(dir / "state_machine_actuators.csv");
    act << ",Idle,Armed\n";
    act << "Fast Valve,CLOSE,OPEN\n";
    act << "Slow Valve,CLOSE,OPEN\n";
    act.close();

    std::ofstream del(dir / "state_machine_actuator_delays.csv");
    del << ",Idle,Armed\n";
    del << "Fast Valve,0,0\n";
    del << "Slow Valve,0," << slow_delay_s << "\n";
    del.close();

    return "[network]\nactuator_cmd_port = " + std::to_string(port) +
           "\n\n[actuator_service]\nbind_address = \"0.0.0.0\"\n\n"
           "[boards.act_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 12\n"
           "enabled = true\nnum_actuators = 10\n\n"
           "[actuator_roles]\n\"Fast Valve\" = [\"NC\", 1, 12]\n\"Slow Valve\" = [\"NC\", 2, 12]\n";
}

int main() {
    std::cout << "=== Actuator delay / republish interaction ===" << std::endl;

    const uint16_t port = 45911;
    const double kDelay = 1.4;  // longer than the 1 s republish, so a republish lands mid-wait
    fs::path dir = fs::temp_directory_path() / "daq_delay_test";
    fs::remove_all(dir);
    fs::create_directories(dir);
    const std::string cfg = writeFixture(dir, port, kDelay);

    // ── 1. A delayed actuator is withheld at t=0 and by the republish, then fires on time ──────
    {
        BoardListener listener(port);
        if (!listener.start()) {
            std::cerr << "could not bind UDP " << port << " — is something else using it?"
                      << std::endl;
            return 1;
        }

        ActuatorCommander ac;
        if (!ac.load(cfg, (dir / "state_machine_actuators.csv").string())) {
            std::cerr << "ActuatorCommander::load failed" << std::endl;
            listener.stop();
            return 1;
        }
        ac.startContinuousLoop(State::ARMED, /*allow_delays=*/true);
        std::this_thread::sleep_for(std::chrono::milliseconds(2600));
        ac.stopContinuousLoop();
        listener.stop();

        const auto b = listener.bursts();
        check(b.size() >= 3, "at least three bursts (entry, republish, delayed stage)");

        bool entry_excludes_slow = !b.empty() && b[0].channels.count(1) && !b[0].channels.count(2);
        check(entry_excludes_slow, "t=0 burst carries Fast Valve but NOT the delayed Slow Valve");

        // Any burst before the delay elapses must still exclude channel 2.
        bool early_leak = false;
        for (const auto& x : b)
            if (x.at_ms < static_cast<long long>(kDelay * 1000) - 150 && x.channels.count(2))
                early_leak = true;
        check(!early_leak, "no burst before the delay contains the delayed actuator");

        // The republish that lands mid-wait must still have happened (proving it did not cancel
        // the schedule and did not send the settled position).
        bool mid_republish = false;
        for (const auto& x : b)
            if (x.at_ms > 800 && x.at_ms < 1300 && x.channels.count(1) && !x.channels.count(2))
                mid_republish = true;
        check(mid_republish, "republish at ~1 s re-sent Fast Valve and still skipped Slow Valve");

        // The delayed stage fires near its deadline, carrying only the delayed actuator.
        bool fired_on_time = false;
        for (const auto& x : b) {
            const long long target = static_cast<long long>(kDelay * 1000);
            if (x.channels.count(2) && !x.channels.count(1) && x.at_ms > target - 200 &&
                x.at_ms < target + 400)
                fired_on_time = true;
        }
        check(fired_on_time, "delayed stage fired within tolerance carrying only Slow Valve");

        // After firing, the republish covers both again.
        bool settled = false;
        for (const auto& x : b)
            if (x.at_ms > static_cast<long long>(kDelay * 1000) + 100 && x.channels.count(1) &&
                x.channels.count(2))
                settled = true;
        check(settled, "republish resumes covering both actuators once the stage has fired");
    }

    // ── 2. A new transition inside the delay window abandons the pending stage ────────────────
    {
        BoardListener listener(port);
        if (!listener.start()) {
            std::cerr << "could not re-bind UDP " << port << std::endl;
            return 1;
        }

        ActuatorCommander ac;
        ac.load(cfg, (dir / "state_machine_actuators.csv").string());
        ac.startContinuousLoop(State::ARMED, /*allow_delays=*/true);
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        // Idle has no delays, so this entry is entirely immediate — and must strand Armed's stage.
        ac.startContinuousLoop(State::IDLE, /*allow_delays=*/true);
        std::this_thread::sleep_for(std::chrono::milliseconds(2200));
        ac.stopContinuousLoop();
        listener.stop();

        // Armed commands Slow Valve OPEN (hw 1 for an NC valve); Idle commands it CLOSE (hw 0).
        // If the abandoned stage had fired we would see a lone channel-2 burst after the switch.
        bool stale_stage = false;
        for (const auto& x : listener.bursts())
            if (x.at_ms > 500 && x.channels.count(2) && !x.channels.count(1))
                stale_stage = true;
        check(!stale_stage, "stage from the abandoned state never fires after a new transition");
    }

    fs::remove_all(dir);
    std::cout << (g_failures == 0 ? "\nPASSED" : "\nFAILED") << std::endl;
    return g_failures == 0 ? 0 : 1;
}
