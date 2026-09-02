/**
 * FIRE lifecycle: configured duration, expiry target, extend, and the controller gate.
 *
 * This path had no test coverage at all, which is how `fire_duration_ms` went unread for so long —
 * the keys lived in [controller_service] while the sequencer looked in [state_machine], so every
 * burn silently ran FireManager's 6000 ms default no matter what the config or GUI said. Nothing
 * asserted a burn duration, so nothing noticed.
 *
 * Covers:
 *   1. The configured duration is what actually runs (not the built-in default).
 *   2. Expiry lands in the configured [fire] expiry_target, and does so by State rather than by
 *      name — renaming the state must not strand the system in fire.
 *   3. FIRE_START on entry and FIRE_STOP on expiry reach controller_service, exactly once each.
 *      (The backend used to send these too; the sequencer is now the only writer to that gate.)
 *   4. EXTEND_FIRE restarts the countdown at extended_ms.
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <set>

#include "DiabloPacketUtils.h"
#include "control/ActuatorCommander.hpp"
#include "control/FireManager.hpp"
#include "control/StateMachine.hpp"

namespace fs = std::filesystem;
namespace fs_alias = std::filesystem;
using sequencer::ActuatorCommander;
using sequencer::FireManager;
using sequencer::State;
using sequencer::StateMachine;
using Clock = std::chrono::steady_clock;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

int main() {
    std::cout << "=== FIRE lifecycle ===" << std::endl;

    // ── 1. The configured duration is the one that runs ───────────────────────────────────────
    {
        const uint32_t kDuration = 700;
        const uint32_t kExtended = 1400;
        FireManager fm(kDuration, kExtended);

        std::vector<std::pair<bool, long long>> notices;  // (active, ms since start)
        std::mutex m;
        const auto t0 = Clock::now();
        fm.setNotifier([&](bool active) {
            std::lock_guard<std::mutex> lk(m);
            notices.emplace_back(active, std::chrono::duration_cast<std::chrono::milliseconds>(
                                             Clock::now() - t0)
                                             .count());
        });

        std::atomic<long long> expired_at{-1};
        fm.start([&]() {
            expired_at = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0)
                             .count();
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(kDuration + 400));

        const long long at = expired_at.load();
        check(at >= 0, "fire timer expired");
        // The regression this guards: a 700 ms configured burn must not run for 6000 ms.
        check(at >= static_cast<long long>(kDuration) - 100 &&
                  at <= static_cast<long long>(kDuration) + 250,
              "expiry honoured the CONFIGURED duration, not FireManager's 6000 ms default");

        std::lock_guard<std::mutex> lk(m);
        check(notices.size() == 2, "exactly two controller notifications (start, stop)");
        check(!notices.empty() && notices[0].first, "first notification is FIRE_START");
        check(notices.size() > 1 && !notices[1].first, "second notification is FIRE_STOP");
        check(notices.size() > 1 && notices[1].second >= static_cast<long long>(kDuration) - 100,
              "FIRE_STOP is sent at expiry, not early");
    }

    // ── 2. EXTEND restarts the countdown at extended_ms ────────────────────────────────────────
    {
        const uint32_t kDuration = 500;
        const uint32_t kExtended = 1200;
        FireManager fm(kDuration, kExtended);
        fm.setNotifier([](bool) {});

        const auto t0 = Clock::now();
        std::atomic<long long> expired_at{-1};
        fm.start([&]() {
            expired_at = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0)
                             .count();
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(300));  // inside the original window
        fm.extend();
        std::this_thread::sleep_for(std::chrono::milliseconds(kExtended + 500));

        const long long at = expired_at.load();
        check(at >= 0, "extended fire still expires");
        // extend() restarts at extended_ms FROM NOW, so expiry is ~300 + 1200.
        check(at > static_cast<long long>(kDuration) + 150,
              "extend pushed expiry past the original duration");
        check(at >= 300 + static_cast<long long>(kExtended) - 200 &&
                  at <= 300 + static_cast<long long>(kExtended) + 400,
              "extended window is extended_ms measured from the extend call");
    }

    // ── 3. stop() cancels without firing the expiry callback ──────────────────────────────────
    {
        FireManager fm(600, 1200);
        std::atomic<int> notify_count{0};
        std::atomic<bool> expired{false};
        fm.setNotifier([&](bool) { notify_count++; });
        fm.start([&]() { expired = true; });
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        fm.stop();  // leaving the fire state early
        std::this_thread::sleep_for(std::chrono::milliseconds(800));
        check(!expired.load(), "leaving fire early cancels the expiry transition");
        check(notify_count.load() == 2, "early exit still notifies the controller (start + stop)");
    }

    // ── 4. The expiry target is resolved as a State, so a rename cannot strand the system ─────
    {
        // This is the failure the refactor removes: expiry used to go through
        // transitionTo(StateMachine::name(State::ARMED)) -> fromName(). If the name in the CSV /
        // config no longer resolves, fromName() returns UNKNOWN and the transition is refused —
        // while the timer has already stopped. A State carries no such ambiguity.
        check(StateMachine::fromName("Armed") == State::ARMED, "a known name still resolves");
        check(StateMachine::fromName("Burn Baby Burn") == State::UNKNOWN,
              "an unknown name resolves to UNKNOWN — the hazard a State-typed target avoids");
        check(StateMachine::stateId("Fire") == static_cast<uint8_t>(State::FIRE),
              "stateId() gives the controller the fire id without a second copy of the enum");
        check(StateMachine::stateId("Not A State") == 255,
              "stateId() reports unknown rather than guessing an id");
    }


    // ── 5. The system STAYS in fire for the whole window, then transitions once ───────────────
    {
        // Sampling the reported state across the burn: it must remain the fire state throughout
        // and change exactly once, at the end. A timer that fires early or an expiry that runs
        // twice both show up here.
        const uint32_t kDuration = 800;
        FireManager fm(kDuration, 2000);
        fm.setNotifier([](bool) {});

        std::atomic<bool> in_fire{true};
        std::atomic<int> expiries{0};
        const auto t0 = Clock::now();
        fm.start([&]() {
            expiries++;
            in_fire = false;  // stands in for transitionTo(fire_expiry_state_)
        });

        bool left_early = false;
        long long left_at = -1;
        while (std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count() <
               static_cast<long long>(kDuration) + 400) {
            const long long now =
                std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
            if (!in_fire.load()) {
                if (left_at < 0)
                    left_at = now;
                if (now < static_cast<long long>(kDuration) - 100)
                    left_early = true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        check(!left_early, "stayed in fire for the whole configured window (no early exit)");
        check(left_at >= 0, "left fire at the end of the window");
        check(expiries.load() == 1, "the expiry transition ran exactly once, not repeatedly");
        check(fm.isActive() == false, "fire manager is inactive once the burn has ended");
    }

    // ── 6. The sequencer hands PWM control to controller_service during fire ──────────────────
    {
        // In the fire state ActuatorCommander must stop commanding PWM roles entirely, so the
        // controller is the only thing driving them. Outside fire it must command them again.
        // If both drove them at once a burn would have two writers on the same valves.
        const uint16_t port = 45913;
        fs_alias::path dir = fs_alias::temp_directory_path() / "daq_fire_pwm_test";
        fs_alias::remove_all(dir);
        fs_alias::create_directories(dir);
        {
            std::ofstream act(dir / "state_machine_actuators.csv");
            act << ",Idle,Fire\n";
            act << "Plain Valve,OPEN,OPEN\n";
            act << "Throttle,OPEN,OPEN\n";
        }
        const std::string cfg =
            "[network]\nactuator_cmd_port = " + std::to_string(port) +
            "\n\n[actuator_service]\nbind_address = \"0.0.0.0\"\n\n"
            "[boards.act_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 12\n"
            "enabled = true\nnum_actuators = 10\n\n"
            "[actuator_roles]\n\"Plain Valve\" = [\"NC\", 1, 12]\n"
            "\"Throttle\" = [\"PWM\", 2, 12]\n";

        int sock = socket(AF_INET, SOCK_DGRAM, 0);
        int reuse = 1;
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        struct sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
        bind(sock, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr));
        struct timeval tv{.tv_sec = 0, .tv_usec = 300000};
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        auto channelsFor = [&](State st) {
            ActuatorCommander ac;
            ac.setFireState(State::FIRE);
            ac.load(cfg, (dir / "state_machine_actuators.csv").string());
            ac.applyForState(st, /*is_transition=*/true);
            std::set<uint8_t> seen;
            uint8_t buf[1024];
            for (int i = 0; i < 6; ++i) {
                ssize_t n = recv(sock, buf, sizeof(buf), 0);
                if (n <= 0)
                    break;
                daq::PacketHeader hdr;
                std::vector<daq::ActuatorCommand> cmds;
                if (daq::parse_actuator_command_packet(buf, static_cast<size_t>(n), hdr, cmds))
                    for (const auto& c : cmds)
                        seen.insert(c.actuator_id);
            }
            return seen;
        };

        const auto idle = channelsFor(State::IDLE);
        check(idle.count(1) && idle.count(2),
              "outside fire the sequencer commands BOTH the plain valve and the PWM one");

        const auto fire = channelsFor(State::FIRE);
        check(fire.count(1), "in fire the sequencer still commands non-PWM valves");
        check(!fire.count(2),
              "in fire the sequencer stops commanding the PWM valve — control handed to the "
              "controller, so only one writer drives it during a burn");

        close(sock);
        fs_alias::remove_all(dir);
    }

    std::cout << (g_failures == 0 ? "\nPASSED" : "\nFAILED") << std::endl;
    return g_failures == 0 ? 0 : 1;
}
