/**
 * Hold rules: who may set a hold duration, who may not, and what a bad config does.
 *
 * The fire-window path is covered by test_fire_lifecycle, which drives HoldTimer directly. This
 * one drives SequencerService, because the property that matters is not "the timer counts" but
 * "a duration aimed at the burn state is refused AND the rig does not move" — and both halves of
 * that live in transitionTo, not in the timer.
 *
 * The hazard being pinned: a client queues a transition, its socket drops, and the WebSocket layer
 * replays the queued command on reconnect. If a duration could ride along with it into the fire
 * state, a stale frame would set a burn length. So the sequencer refuses, and refuses WITHOUT
 * transitioning — a refusal that still changed state would be its own bug.
 */
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#include "BoardListener.hpp"
#include "control/HoldParse.hpp"
#include "control/SequencerService.hpp"
#include "control/StateMachine.hpp"

namespace fs = std::filesystem;
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

static fs::path g_dir;

/** Write a config whose flow hold can be varied per case. */
struct FlowCfg {
    std::string flow_state_name = "Flow Test";
    bool mark_is_flow = true;
    std::string return_target = "Press Standby";
    uint32_t duration_ms = 1000;
    uint32_t max_ms = 5000;
    /** Gate the window on this actuator, staggered by the delays below. Empty = no gate. */
    std::string gate_actuator;
    double gate_open_delay_s = 0.0;   // its delay in the FLOW state's column
    double gate_close_delay_s = 0.0;  // its delay in the RETURN state's column
};

static std::string writeConfig(const FlowCfg& f) {
    // Column order matches the [[states]] order; the loader keys both CSVs by name.
    {
        std::ofstream t(g_dir / "state_transitions.csv");
        t << ",Idle,Armed,Press Standby,Fire," << f.flow_state_name << "\n";
        t << "Idle,1,1,1,0,0\n";
        t << "Armed,1,1,1,0,0\n";
        t << "Press Standby,1,1,1,1,1\n";
        t << "Fire,0,1,0,1,0\n";
        t << f.flow_state_name << ",0,0,1,0,1\n";
    }
    {
        std::ofstream a(g_dir / "state_machine_actuators.csv");
        a << ",Idle,Armed,Press Standby,Fire," << f.flow_state_name << "\n";
        a << "Main Valve,CLOSE,CLOSE,CLOSE,OPEN,OPEN\n";
        // The valve the gate is NOT timed around: it opens on entry with no delay, so the
        // stagger between the two is directly observable on the wire.
        a << "Upstream Valve,CLOSE,CLOSE,CLOSE,OPEN,OPEN\n";
    }
    {
        // ActuatorCommander derives this filename from the actuator CSV's, so it must sit beside
        // it.
        std::ofstream d(g_dir / "state_machine_actuator_delays.csv");
        d << ",Idle,Armed,Press Standby,Fire," << f.flow_state_name << "\n";
        // Column order above: the return state here is always Press Standby, so its delay is the
        // third numeric column and the flow state's is the fifth.
        d << "Main Valve,0,0," << f.gate_close_delay_s << ",0," << f.gate_open_delay_s << "\n";
        d << "Upstream Valve,0,0,0,0,0\n";
    }

    const fs::path cfg_path = g_dir / "config.toml";
    std::ofstream c(cfg_path);
    c << "[network]\nactuator_cmd_port = 45914\n\n"
      << "[database]\nport = 2\n\n"  // nothing listening; the service runs without Elodin
      << "[boards.act_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 12\n"
         "enabled = true\nnum_actuators = 10\n\n"
      << "[actuator_roles]\n\"Main Valve\" = [\"NC\", 1, 12]\n"
         "\"Upstream Valve\" = [\"NC\", 2, 12]\n\n"
      << "[state_machine]\n"
      << "transitions_csv = \"" << (g_dir / "state_transitions.csv").string() << "\"\n"
      << "actuator_csv = \"" << (g_dir / "state_machine_actuators.csv").string()
      << "\"\n"
      // Declared explicitly rather than left to be guessed from the positions filename — that
      // guess is now only a fallback, and a test that relies on it is testing the fallback.
      << "actuator_delay_csv = \"" << (g_dir / "state_machine_actuator_delays.csv").string()
      << "\"\n\n"
      << "[fire]\nstate = \"Fire\"\nexpiry_target = \"Armed\"\n"
         "duration_ms = 800\nextended_ms = 1600\n\n"
      << "[flow]\nreturn_target = \"" << f.return_target << "\"\n"
      << "duration_ms = " << f.duration_ms << "\nmax_ms = " << f.max_ms << "\n"
      << (f.gate_actuator.empty() ? std::string() : "gate_actuator = \"" + f.gate_actuator + "\"\n")
      << "\n"
      << "[[states]]\nid = 1\nname = \"Idle\"\nis_boot = true\n\n"
      << "[[states]]\nid = 2\nname = \"Armed\"\n\n"
      << "[[states]]\nid = 3\nname = \"Press Standby\"\n\n"
      << "[[states]]\nid = 12\nname = \"Fire\"\n\n"
      << "[[states]]\nid = 13\nname = \"" << f.flow_state_name << "\"\n"
      << (f.mark_is_flow ? "is_flow = true\n" : "") << "\n";
    return cfg_path.string();
}

/** Wait for the service to land in `want`; returns ms elapsed, or -1 on timeout. */
static long long waitForState(SequencerService& svc, State want, int timeout_ms) {
    const auto t0 = Clock::now();
    for (;;) {
        const auto ms =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        if (svc.currentState() == want)
            return ms;
        if (ms > timeout_ms)
            return -1;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
}

int main() {
    std::cout << "=== Hold rules ===" << std::endl;

    g_dir = fs::temp_directory_path() / "daq_hold_rules_test";
    fs::remove_all(g_dir);
    fs::create_directories(g_dir);

    // ── parseHoldMs: strict, because the lenient version silently runs the wrong test ─────────
    {
        uint32_t v = 0;
        const char* bad[] = {"0", "-1", "abc", "1e3", "999999999999", "", "1000x", "  ", "+5"};
        bool all_rejected = true;
        for (const char* b : bad)
            if (sequencer::parseHoldMs(b, v))
                all_rejected = false;
        check(all_rejected, "parseHoldMs rejects 0, signs, junk, partial numbers and overflow");

        check(sequencer::parseHoldMs("1000", v) && v == 1000, "parseHoldMs accepts a plain number");
        check(sequencer::parseHoldMs("  1000  ", v) && v == 1000, "parseHoldMs tolerates padding");
        check(!sequencer::parseHoldMs(std::to_string(sequencer::kMaxHoldMs + 1), v),
              "parseHoldMs enforces the wire ceiling");
    }

    const std::string cfg_path = writeConfig(FlowCfg{});

    {
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised from the test config");

        const State kFlow = StateMachine::fromName("Flow Test");
        const State kFire = StateMachine::fromName("Fire");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(kFlow != State::UNKNOWN && kFire != State::UNKNOWN, "test states resolved");

        check(svc.transitionTo(kStandby), "reached the hub state");

        // ── A duration aimed at the burn state is refused, and nothing moves ──────────────────
        {
            std::string why;
            const bool ok = svc.transitionTo(kFire, 1500, &why);
            check(!ok, "a client-supplied duration is refused for the fire state");
            check(why == "duration not permitted for this state", "the refusal says why: " + why);
            // The half that actually matters.
            check(
                svc.currentState() == kStandby,
                "the REFUSED fire hold did not transition — a replayed frame cannot start a burn");
        }

        // ── The same request is honoured for the flow state ───────────────────────────────────
        {
            std::string why;
            const auto t0 = Clock::now();
            check(svc.transitionTo(kFlow, 1500, &why), "a duration IS honoured for the flow state");
            check(svc.currentState() == kFlow, "the rig entered the flow state");
            const long long back = waitForState(svc, kStandby, 4000);
            const long long total =
                std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
            check(back >= 0, "the hold expired back into the return state on its own");
            // Wider than the HoldTimer unit test: this crosses actuator commanding and a real
            // transition on the timer thread.
            check(total >= 1490 && total <= 1600,
                  "the hold ran for the REQUESTED window, not the configured default (" +
                      std::to_string(total) + " ms)");
        }

        // ── Bounds ────────────────────────────────────────────────────────────────────────────
        {
            std::string why;
            check(!svc.transitionTo(kFlow, 9999, &why), "a duration over max_ms is refused");
            check(why.rfind("duration exceeds max", 0) == 0,
                  "the refusal names the ceiling: " + why);
            check(svc.currentState() == kStandby, "an over-max request did not transition");

            why.clear();
            check(!svc.transitionTo(kStandby, 1200, &why),
                  "a duration aimed at a non-holdable state is refused");
            check(why == "state is not holdable", "the refusal says why: " + why);
        }

        // ── No duration supplied → the configured default ─────────────────────────────────────
        {
            const auto t0 = Clock::now();
            check(svc.transitionTo(kFlow), "the flow state is enterable with no duration at all");
            check(waitForState(svc, kStandby, 4000) >= 0, "the default hold expired");
            const long long total =
                std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
            check(total >= 990 && total <= 1100,
                  "it used [flow].duration_ms (" + std::to_string(total) + " ms)");
        }
    }

    // ── A staggered state times the window on the VALVE, not on the state ────────────────────
    {
        // The rig cracks an upstream valve first so a regulator can settle, then opens the main a
        // second later. "1 s" has to mean the MAIN was open for 1 s — if the hold were measured
        // from the transition, a 1 s request would close everything exactly as the main opened and
        // flow for zero seconds.
        writeConfig(
            FlowCfg{"Flow Test", true, "Press Standby", 1000, 5000, "Main Valve", 0.5, 0.0});
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with a gated flow state");
        const State kFlow = StateMachine::fromName("Flow Test");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");

        // Listen on the wire. Everything below this line used to be asserted on the STATE clock
        // alone, which is why a 1 s request that held both valves open for 2 s passed: the
        // arithmetic (1000 + 500) was correct and the valves were commanded together anyway.
        daqtest::BoardListener listener(45914);
        check(listener.start(), "bound the actuator UDP port to watch the wire");

        const auto t0 = Clock::now();
        check(svc.transitionTo(kFlow, 1000), "gated hold accepted");
        check(waitForState(svc, kStandby, 4000) >= 0, "gated hold expired");
        const long long total =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        // State held for requested + open delay = 1000 + 500.
        check(total >= 1480 && total <= 1620,
              "state was held for requested + open-stagger (" + std::to_string(total) + " ms)");

        std::this_thread::sleep_for(std::chrono::milliseconds(50));  // let the close land
        listener.stop();
        const auto b = listener.bursts();

        // 1 = OPEN for an NC valve. Upstream first, main half a second behind it.
        const long long up_open = daqtest::firstCommand(b, /*ch=*/2, /*hw=*/1);
        const long long main_open = daqtest::firstCommand(b, /*ch=*/1, /*hw=*/1);
        const long long main_close =
            main_open < 0 ? -1 : daqtest::firstCommand(b, /*ch=*/1, /*hw=*/0, main_open + 1);

        check(up_open >= 0 && main_open >= 0 && main_close >= 0,
              "saw the upstream open, the main open and the main close on the wire");

        const long long stagger = (up_open >= 0 && main_open >= 0) ? main_open - up_open : -1;
        check(stagger >= 400 && stagger <= 700,
              "the main opened ~500 ms AFTER the upstream, not with it (" +
                  std::to_string(stagger) + " ms)");

        // The whole point of the gate arithmetic: the requested duration is how long the GATE
        // valve is open, not how long the state lasts.
        const long long main_ms = (main_open >= 0 && main_close >= 0) ? main_close - main_open : -1;
        check(main_ms >= 980 && main_ms <= 1150,
              "the main valve was open for the REQUESTED 1000 ms (" + std::to_string(main_ms) +
                  " ms)");
    }

    // ── A stagger on the way OUT shortens the hold by the same amount ─────────────────────────
    {
        // The valve does not close at the expiry transition either: if it lingers 300 ms into the
        // return state, the state must be held 300 ms less or the valve is open too long.
        writeConfig(
            FlowCfg{"Flow Test", true, "Press Standby", 1000, 5000, "Main Valve", 0.5, 0.3});
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with a two-sided stagger");
        const State kFlow = StateMachine::fromName("Flow Test");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");

        const auto t0 = Clock::now();
        check(svc.transitionTo(kFlow, 1000), "two-sided gated hold accepted");
        check(waitForState(svc, kStandby, 4000) >= 0, "two-sided gated hold expired");
        const long long total =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        // hold = 1000 + 500 - 300 = 1200. The valve is still open 1000 ms: it opens at +500 and
        // closes at 1200 + 300 = 1500.
        check(total >= 1180 && total <= 1320,
              "hold = requested + open - close stagger (" + std::to_string(total) + " ms)");
    }

    // ── A close delay that swallows the window is clamped, not wrapped ────────────────────────
    {
        // Unsigned arithmetic here would underflow into a ~49-day hold with the valves open.
        writeConfig(FlowCfg{"Flow Test", true, "Press Standby", 200, 5000, "Main Valve", 0.0, 2.0});
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with an oversized close stagger");
        const State kFlow = StateMachine::fromName("Flow Test");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");
        const auto t0 = Clock::now();
        check(svc.transitionTo(kFlow, 200), "hold accepted");
        const long long back = waitForState(svc, kStandby, 3000);
        const long long total =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        check(back >= 0 && total < 1000, "clamped to a minimal hold instead of underflowing (" +
                                             std::to_string(total) + " ms)");
    }

    // ── The flag, not the name: rename the state and it keeps working ─────────────────────────
    {
        writeConfig(FlowCfg{"Cold Flow", true, "Press Standby", 300, 5000});
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with the flow state renamed");
        const State renamed = StateMachine::fromName("Cold Flow");
        check(renamed != State::UNKNOWN, "the renamed state resolved");
        check(svc.transitionTo(StateMachine::fromName("Press Standby")), "reached the hub");
        std::string why;
        check(svc.transitionTo(renamed, 400, &why),
              "the renamed state is still the flow state — nothing resolved it by name");
    }

    // ── A return target that does not exist makes the state NOT holdable ──────────────────────
    {
        writeConfig(FlowCfg{"Flow Test", true, "Nowhere At All", 300, 5000});
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with a broken return target");
        check(svc.transitionTo(StateMachine::fromName("Press Standby")), "reached the hub");
        std::string why;
        check(!svc.transitionTo(StateMachine::fromName("Flow Test"), 400, &why),
              "a hold whose return target is unresolvable is refused");
        check(why == "state is not holdable", "refused as not holdable: " + why);
        // The point of refusing up front: the valve is never opened, so it cannot be stranded open
        // by an expiry transition that was never going to be allowed.
        check(svc.currentState() == StateMachine::fromName("Press Standby"),
              "the rig never entered the state, so its valve never opened");
    }

    // ── No state flagged is_flow → there is simply no flow hold ───────────────────────────────
    {
        writeConfig(FlowCfg{"Flow Test", false, "Press Standby", 300, 5000});
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with no state marked is_flow");
        check(svc.transitionTo(StateMachine::fromName("Press Standby")), "reached the hub");
        std::string why;
        check(!svc.transitionTo(StateMachine::fromName("Flow Test"), 400, &why),
              "with nothing flagged, a supplied duration has no state to apply to");
        check(why == "state is not holdable", "refused as not holdable: " + why);
    }

    fs::remove_all(g_dir);
    std::cout << (g_failures == 0 ? "\nPASSED" : "\nFAILED") << std::endl;
    return g_failures == 0 ? 0 : 1;
}
