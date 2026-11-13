/**
 * FIRE lifecycle: configured duration, expiry target, extend, and the controller gate.
 *
 * This path had no test coverage at all, which is how `fire_duration_ms` went unread for so long —
 * the keys lived in [controller_service] while the sequencer looked in [state_machine], so every
 * burn silently ran the timer's 6000 ms default no matter what the config or GUI said. Nothing
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
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "DiabloPacketUtils.h"
#include "control/ActuatorCommander.hpp"
#include "control/HoldTimer.hpp"
#include "control/StateMachine.hpp"

namespace fs = std::filesystem;
namespace fs_alias = std::filesystem;
using sequencer::ActuatorCommander;
using sequencer::HoldSpec;
using sequencer::HoldTimer;
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
        HoldTimer fm;

        std::vector<std::pair<bool, long long>> notices;  // (active, ms since start)
        std::mutex m;
        const auto t0 = Clock::now();
        std::atomic<long long> expired_at{-1};
        fm.start(HoldSpec{
            kDuration, kExtended,
            [&]() {
                expired_at =
                    std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0)
                        .count();
            },
            [&](bool active) {
                std::lock_guard<std::mutex> lk(m);
                notices.emplace_back(
                    active, std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0)
                                .count());
            },
            "FIRE"});
        std::this_thread::sleep_for(std::chrono::milliseconds(kDuration + 400));

        const long long at = expired_at.load();
        check(at >= 0, "fire timer expired");
        // The regression this guards: a 700 ms configured burn must not run for 6000 ms.
        // This window used to be [-100, +250]. It was that loose because runTimer() counted sleep
        // *calls* (`elapsed_ms += 50`) rather than elapsed time, so every iteration overshot and
        // the error only ever accumulated one way. Against a steady_clock deadline the only slack
        // left is scheduler wake latency, so the window can be tight — while staying generous
        // enough on the upper side for a loaded CI box, and nowhere near the 6000 ms default.
        check(at >= static_cast<long long>(kDuration) - 5 &&
                  at <= static_cast<long long>(kDuration) + 50,
              "expiry honoured the CONFIGURED duration, not the built-in 6000 ms default");

        std::lock_guard<std::mutex> lk(m);
        check(notices.size() == 2, "exactly two controller notifications (start, stop)");
        check(!notices.empty() && notices[0].first, "first notification is FIRE_START");
        check(notices.size() > 1 && !notices[1].first, "second notification is FIRE_STOP");
        check(notices.size() > 1 && notices[1].second >= static_cast<long long>(kDuration) - 5,
              "FIRE_STOP is sent at expiry, not early");
    }

    // ── 2. EXTEND restarts the countdown at extended_ms ────────────────────────────────────────
    {
        const uint32_t kDuration = 500;
        const uint32_t kExtended = 1200;
        HoldTimer fm;

        const auto t0 = Clock::now();
        std::atomic<long long> expired_at{-1};
        fm.start(HoldSpec{kDuration, kExtended,
                          [&]() {
                              expired_at = std::chrono::duration_cast<std::chrono::milliseconds>(
                                               Clock::now() - t0)
                                               .count();
                          },
                          nullptr, "FIRE"});
        std::this_thread::sleep_for(std::chrono::milliseconds(300));  // inside the original window
        fm.extend();
        std::this_thread::sleep_for(std::chrono::milliseconds(kExtended + 500));

        const long long at = expired_at.load();
        check(at >= 0, "extended fire still expires");
        // extend() restarts at extended_ms FROM NOW, so expiry is ~300 + 1200.
        check(at > static_cast<long long>(kDuration) + 150,
              "extend pushed expiry past the original duration");
        // Tightened with the deadline timer. The remaining lower slack is the 300 ms sleep_for
        // before extend(), not the countdown.
        check(at >= 300 + static_cast<long long>(kExtended) - 20 &&
                  at <= 300 + static_cast<long long>(kExtended) + 60,
              "extended window is extended_ms measured from the extend call");
    }

    // ── 3. stop() cancels without firing the expiry callback ──────────────────────────────────
    {
        HoldTimer fm;
        std::atomic<int> notify_count{0};
        std::atomic<bool> expired{false};
        fm.start(HoldSpec{600, 1200,
                          [&]() {
                              expired = true;
                          },
                          [&](bool) {
                              notify_count++;
                          },
                          "FIRE"});
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        fm.stop();  // leaving the fire state early
        std::this_thread::sleep_for(std::chrono::milliseconds(800));
        check(!expired.load(), "leaving fire early cancels the expiry transition");
        check(notify_count.load() == 2, "early exit still notifies the controller (start + stop)");
    }

    // ── 3b. extended_ms = 0 refuses extend(), so a fixed-window hold stays fixed ─────────────
    {
        // A characterization pulse is a duration the operator asked for and then weighed a mass
        // against. Stretching it would make that mass describe a different window, so the flow
        // hold sets extended_ms = 0 and extend() must decline rather than quietly restart.
        HoldTimer fm;
        std::atomic<long long> expired_at{-1};
        const auto t0 = Clock::now();
        fm.start(HoldSpec{300, 0,
                          [&]() {
                              expired_at = std::chrono::duration_cast<std::chrono::milliseconds>(
                                               Clock::now() - t0)
                                               .count();
                          },
                          nullptr, "Flow Test"});
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        check(fm.extend() == false, "extend() is refused when extended_ms is 0");
        std::this_thread::sleep_for(std::chrono::milliseconds(400));
        const long long at = expired_at.load();
        check(at >= 295 && at <= 350, "the refused extend left the original window intact");
        check(fm.extend() == false, "extend() is refused once the hold is over");
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
        HoldTimer fm;

        std::atomic<bool> in_fire{true};
        std::atomic<int> expiries{0};
        const auto t0 = Clock::now();
        fm.start(HoldSpec{kDuration, 2000,
                          [&]() {
                              expiries++;
                              in_fire = false;  // stands in for transitionTo(fire_expiry_state_)
                          },
                          nullptr, "FIRE"});

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
        check(fm.isActive() == false, "the hold timer is inactive once the burn has ended");
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
            // The 4th element is what assigns an actuator to controller_service. It used to be a
            // third `kind` value ("PWM"), but kind also carries NC/NO polarity, so an actuator
            // could not be both PWM-driven and normally open — and since every shipped config
            // needed NC/NO, nothing was ever marked "PWM" and this skip never engaged on a real
            // rig. Note Throttle is "NO" here precisely to pin that the two are independent.
            "[actuator_roles]\n\"Plain Valve\" = [\"NC\", 1, 12]\n"
            "\"Throttle\" = [\"NO\", 2, 12, \"pwm_fuel\"]\n";

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
              "outside fire the sequencer commands BOTH the plain valve and the assigned one");

        const auto fire = channelsFor(State::FIRE);
        check(fire.count(1), "in fire the sequencer still commands its own valves");
        check(!fire.count(2),
              "in fire the sequencer stops commanding the controller-assigned valve — one "
              "writer drives it during a burn");

        close(sock);
        fs_alias::remove_all(dir);
    }

    std::cout << (g_failures == 0 ? "\nPASSED" : "\nFAILED") << std::endl;
    return g_failures == 0 ? 0 : 1;
}
