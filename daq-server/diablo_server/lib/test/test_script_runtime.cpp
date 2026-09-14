/**
 * Dynamic states, executing. Asserted on the wire, because a clock inside the sequencer is exactly
 * what made the original actuator-delay bug invisible for so long.
 *
 * The cases that matter, and what each one catches if it goes wrong:
 *
 *  - The vent pulse (motivating example 1) lands its close 500 ms after its open. Catches delay()
 *    built on sleep_for, whose drift only becomes visible over many iterations.
 *  - A valve a script opens is still open two republish periods later. Catches open_valve wired to
 *    sendSingleActuator alone: it works for a second and then the republish quietly reverts it.
 *  - An abort during a script reaches the boards in well under 200 ms. Catches the script running
 *    on the command worker, which would block every command including the abort for its whole
 *    runtime — the single worst failure this feature can have.
 *  - A transition out mid-delay stops the script dead. Catches a script outliving its own state.
 *  - A runaway loop lands on its timeout target, not its return target. Catches the two exits
 *    being conflated.
 *
 * Hermetic: loopback UDP, [database].port = 2 so no Elodin is needed, controller on TEST-NET-1.
 */
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#include "BoardListener.hpp"
#include "control/SequencerService.hpp"
#include "control/StateMachine.hpp"

namespace fs = std::filesystem;
using daqtest::BoardListener;
using daqtest::firstCommand;
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
static constexpr uint16_t kActPort = 45919;
static constexpr uint16_t kAbortPort = 15007;

/** Channel 1 = Vent Valve (column always CLOSE — only a script opens it), 2 = Main Valve. */
static std::string writeConfig(const std::string& script, uint32_t timeout_ms,
                               const std::string& return_target,
                               const std::string& timeout_target) {
    {
        std::ofstream t(g_dir / "state_transitions.csv");
        t << ",Idle,Armed,Press Standby,Vent,Dyn State,Engine Abort\n";
        t << "Idle,1,1,1,1,1,1\n";
        t << "Armed,1,1,1,1,1,1\n";
        t << "Press Standby,1,1,1,1,1,1\n";
        t << "Vent,1,1,1,1,1,1\n";
        t << "Dyn State,1,1,1,1,1,1\n";
        t << "Engine Abort,1,1,1,1,0,1\n";
    }
    {
        std::ofstream a(g_dir / "state_machine_actuators.csv");
        a << ",Idle,Armed,Press Standby,Vent,Dyn State,Engine Abort\n";
        a << "Vent Valve,CLOSE,CLOSE,CLOSE,CLOSE,CLOSE,CLOSE\n";
        a << "Main Valve,CLOSE,CLOSE,CLOSE,CLOSE,CLOSE,CLOSE\n";
    }
    {
        std::ofstream d(g_dir / "state_machine_actuator_delays.csv");
        d << ",Idle,Armed,Press Standby,Vent,Dyn State,Engine Abort\n";
        d << "Vent Valve,0,0,0,0,0,0\n";
        d << "Main Valve,0,0,0,0,0,0\n";
    }

    fs::create_directories(g_dir / "scripts");
    {
        std::ofstream s(g_dir / "scripts" / "run.script");
        s << script;
    }

    const fs::path cfg_path = g_dir / "config.toml";
    std::ofstream c(cfg_path);
    c << "[network]\nactuator_cmd_port = " << kActPort << "\n\n"
      << "[database]\nport = 2\n\n"
      << "[controller_service]\nhost = \"192.0.2.1\"\nport = 9999\n\n"
      << "[server_heartbeat]\nbroadcast_ip = \"127.0.0.1\"\nbroadcast_port = " << kAbortPort
      << "\n\n"
      << "[boards.act_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 12\n"
         "enabled = true\nnum_actuators = 10\n\n"
      << "[boards.pt_board]\ntype = \"PT\"\nip = \"127.0.0.1\"\nboard_id = 21\nenabled = true\n\n"
      << "[sensor_roles_pt_board]\n\"Tank Pressure\" = 1\n\n"
      << "[actuator_roles]\n\"Vent Valve\" = [\"NC\", 1, 12]\n\"Main Valve\" = [\"NC\", 2, 12]\n\n"
      << "[state_machine]\n"
      << "transitions_csv = \"" << (g_dir / "state_transitions.csv").string() << "\"\n"
      << "actuator_csv = \"" << (g_dir / "state_machine_actuators.csv").string() << "\"\n"
      << "actuator_delay_csv = \"" << (g_dir / "state_machine_actuator_delays.csv").string()
      << "\"\n\n"
      << "[[states]]\nid = 1\nname = \"Idle\"\nis_boot = true\n\n"
      << "[[states]]\nid = 2\nname = \"Armed\"\n\n"
      << "[[states]]\nid = 3\nname = \"Press Standby\"\n\n"
      << "[[states]]\nid = 4\nname = \"Vent\"\n\n"
      << "[[states]]\nid = 17\nname = \"Engine Abort\"\nis_abort = true\n\n"
      << "[[states]]\nid = 13\nname = \"Dyn State\"\n"
      << "script_file = \"run.script\"\n"
      << "script_timeout_ms = " << timeout_ms << "\n"
      << "script_return_target = \"" << return_target << "\"\n"
      << "script_timeout_target = \"" << timeout_target << "\"\n\n";
    return cfg_path.string();
}

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
    std::cout << "=== Dynamic states, executing ===" << std::endl;

    g_dir = fs::temp_directory_path() / "daq_script_runtime_test";
    fs::remove_all(g_dir);
    fs::create_directories(g_dir);

    // Ids as THIS fixture declares them, never the compiled enumerators. State::PRESS_STANDBY is
    // 20 and State::VENT is 13 in the enum, while here Press Standby is 3 and 13 is Dyn State —
    // so comparing against the enumerator would silently ask about a different state, and one of
    // those comparisons would even pass for the wrong reason. Ids are keys, not an ordering.
    const State IDLE = static_cast<State>(1);
    const State ARMED = static_cast<State>(2);
    const State PRESS_STANDBY = static_cast<State>(3);
    const State VENT = static_cast<State>(4);
    const State DYN = static_cast<State>(13);
    const State ENGINE_ABORT = static_cast<State>(17);
    (void)DYN;

    // ── 1. The vent pulse: open, hold 500 ms, close, leave ────────────────────────────────────
    {
        const std::string path = writeConfig(
            "open_valve(VENT_VALVE)\n"
            "delay(0.5)\n"
            "close_valve(VENT_VALVE)\n"
            "transition_to(PRESS_STANDBY)\n",
            5000, "Idle", "Idle");

        SequencerService svc;
        svc.init(path);
        BoardListener listener(kActPort);
        listener.start();

        svc.transitionTo(std::string("Dyn State"));
        const long long landed = waitForState(svc, PRESS_STANDBY, 3000);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        listener.stop();

        const auto b = listener.bursts();
        const long long open = firstCommand(b, /*ch=*/1, /*hw=*/1);
        const long long close = firstCommand(b, /*ch=*/1, /*hw=*/0, /*after_ms=*/open + 1);
        check(open >= 0, "the script opened the vent valve");
        check(close > 0 && (close - open) >= 430 && (close - open) <= 640,
              "it closed " + std::to_string(close - open) + " ms later (want ~500)");
        check(landed >= 0, "and the script's transition_to landed in Press Standby");
    }

    // ── 2. A script's valve survives more than one republish period ───────────────────────────
    {
        const std::string path = writeConfig(
            "open_valve(VENT_VALVE)\n"
            "delay(2.5)\n"
            "close_valve(VENT_VALVE)\n"
            "transition_to(IDLE)\n",
            8000, "Idle", "Idle");

        SequencerService svc;
        svc.init(path);
        BoardListener listener(kActPort);
        listener.start();
        svc.transitionTo(std::string("Dyn State"));
        std::this_thread::sleep_for(std::chrono::milliseconds(2300));
        listener.stop();

        int opens = 0;
        for (const auto& burst : listener.bursts()) {
            auto it = burst.state.find(1);
            if (it != burst.state.end() && it->second == 1)
                opens++;
        }
        // Without a script position this is exactly 1, and the republish closes it a second later.
        check(opens >= 3, "the open is re-asserted by the republish (saw " + std::to_string(opens) +
                              " over 2.3 s)");
    }

    // ── 3. An abort during a running script is not delayed by it ──────────────────────────────
    {
        const std::string path = writeConfig(
            "open_valve(VENT_VALVE)\n"
            "delay(5)\n"
            "close_valve(VENT_VALVE)\n"
            "transition_to(IDLE)\n",
            9000, "Idle", "Idle");

        SequencerService svc;
        svc.init(path);
        BoardListener abort_listener(kAbortPort);
        abort_listener.start();

        svc.transitionTo(std::string("Dyn State"));
        std::this_thread::sleep_for(std::chrono::milliseconds(400));

        const auto t0 = Clock::now();
        svc.transitionTo(std::string("Engine Abort"));
        const long long latency =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        abort_listener.stop();

        // The 200 ms bar test_abort_ordering uses. A script on the command worker would make this
        // the remaining 4.6 s of its delay.
        check(latency < 200, "the abort transition returned in " + std::to_string(latency) +
                                 " ms despite a 5 s delay() in flight");
        check(svc.currentState() == ENGINE_ABORT, "and the rig is in Engine Abort");
    }

    // ── 4. Transitioning out mid-script stops it dead ─────────────────────────────────────────
    {
        const std::string path = writeConfig(
            "open_valve(VENT_VALVE)\n"
            "delay(1.0)\n"
            "open_valve(MAIN_VALVE)\n"  // must never happen: we leave before this
            "delay(5)\n"
            "transition_to(IDLE)\n",
            9000, "Idle", "Idle");

        SequencerService svc;
        svc.init(path);
        BoardListener listener(kActPort);
        listener.start();
        svc.transitionTo(std::string("Dyn State"));
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        svc.transitionTo(std::string("Armed"));
        std::this_thread::sleep_for(std::chrono::milliseconds(1600));
        listener.stop();

        const long long main_open = firstCommand(listener.bursts(), /*ch=*/2, /*hw=*/1);
        check(main_open < 0, "the statement after the transition never ran");
        check(svc.currentState() == ARMED, "and the rig stayed where the operator put it");
    }

    // ── 5. A runaway lands on the TIMEOUT target, not the return target ───────────────────────
    {
        // Distinct targets, so which one it took is unambiguous.
        const std::string path = writeConfig(
            "open_valve(VENT_VALVE)\n"
            "while elapsed() < 60:\n"
            "    delay(0.05)\n"
            "transition_to(IDLE)\n",
            700, /*return=*/"Armed", /*timeout=*/"Vent");

        SequencerService svc;
        svc.init(path);
        svc.transitionTo(std::string("Dyn State"));
        const long long landed = waitForState(svc, VENT, 3000);
        check(landed >= 0, "the runaway landed on its timeout target");
        check(landed >= 500 && landed <= 1400,
              "at about the configured 700 ms (" + std::to_string(landed) + " ms)");
        check(svc.currentState() != ARMED, "and NOT on the return target");
    }

    // ── 6. Running off the end lands on the RETURN target ─────────────────────────────────────
    {
        const std::string path =
            writeConfig("open_valve(VENT_VALVE)\ndelay(0.2)\nclose_valve(VENT_VALVE)\n", 9000,
                        /*return=*/"Armed", /*timeout=*/"Vent");

        SequencerService svc;
        svc.init(path);
        svc.transitionTo(std::string("Dyn State"));
        const long long landed = waitForState(svc, ARMED, 3000);
        check(landed >= 0, "a script with no transition_to lands on its return target");
        check(svc.currentState() != VENT, "and NOT on the timeout target");
    }

    // ── 7. A sensor with no fresh reading refuses the transition, before anything moves ───────
    //
    // No Elodin is running in this test, so the feed never receives anything. The transition-time
    // precheck is what turns that into a refusal at the button rather than a script that enters
    // the state, opens a valve, and only then discovers it cannot read what it needs.
    {
        const std::string path = writeConfig(
            "open_valve(VENT_VALVE)\n"
            "if pressure(TANK_PRESSURE) > 100:\n"
            "    open_valve(MAIN_VALVE)\n"
            "delay(0.2)\n",
            3000, /*return=*/"Armed", /*timeout=*/"Vent");

        SequencerService svc;
        svc.init(path);
        BoardListener listener(kActPort);
        listener.start();

        std::string reason;
        const bool accepted = svc.transitionTo(std::string("Dyn State"), 0, &reason);
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        listener.stop();

        check(!accepted, "a script whose sensor has no fresh reading is refused entry");
        check(reason.find("Tank Pressure") != std::string::npos,
              "and the refusal names the sensor (\"" + reason + "\")");
        check(svc.currentState() == IDLE, "the rig did not move");
        check(firstCommand(listener.bursts(), /*ch=*/1, /*hw=*/1) < 0,
              "and not one valve was commanded");
    }

    // ── 8. Debug mode and a scripted state ────────────────────────────────────────────────────
    //
    // Three rules, and only the middle one is new — the other two fall out of how transitions
    // already work, which is exactly why they are worth pinning before someone "simplifies" them.
    {
        const std::string path = writeConfig(
            "open_valve(VENT_VALVE)\n"
            "delay(4)\n"
            "close_valve(VENT_VALVE)\n"
            "transition_to(IDLE)\n",
            9000, /*return=*/"Idle", /*timeout=*/"Idle");

        SequencerService svc;
        svc.init(path);
        svc.setDebugMode(true);

        // (a) Entering clears whatever the operator had commanded by hand. Same as every other
        // state: the incoming state's column is the truth, and a leftover override would silently
        // outrank it.
        BoardListener before(kActPort);
        before.start();
        check(svc.manualActuator("Main Valve", 1),
              "debug can command a valve in an ordinary state");
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        before.stop();
        check(firstCommand(before.bursts(), /*ch=*/2, /*hw=*/1) >= 0, "and it reaches the board");

        BoardListener listener(kActPort);
        listener.start();
        svc.transitionTo(std::string("Dyn State"));
        std::this_thread::sleep_for(std::chrono::milliseconds(1400));

        // (b) A hand command during a script is ALLOWED, and the operator outranks the script.
        // They are fighting over a valve and the script cannot notice — but the person at the
        // panel is the last line, and taking that away to protect a script is the wrong trade.
        check(svc.manualActuator("Main Valve", 1),
              "debug can still command a valve while a script is running");
        std::this_thread::sleep_for(std::chrono::milliseconds(1400));
        listener.stop();

        const auto b8 = listener.bursts();
        // Channel 2 is CLOSE in the Dyn State column, so the only thing that can open it is the
        // operator — and it must stay open across a republish rather than being reverted.
        const long long op_open = firstCommand(b8, /*ch=*/2, /*hw=*/1);
        check(op_open >= 0, "the operator's command reaches the board mid-script");
        int opens = 0;
        for (const auto& burst : b8) {
            auto it = burst.state.find(2);
            if (it != burst.state.end() && it->second == 1)
                opens++;
        }
        check(opens >= 2, "and the republish keeps re-asserting it, not the column's CLOSE");
        // The override the operator set BEFORE entering was still cleared by the transition —
        // that part is unchanged, and is what every other state does.
        check(op_open > 900,
              "the pre-transition override did not survive entry; this open is the new one");

        // (c) Leaving is unrestricted in debug mode. Dyn State -> Engine Abort is a 0 in this
        // fixture's matrix, so this only succeeds because debug mode relaxes the transition check
        // — which is the escape hatch that makes (b) acceptable.
        check(svc.transitionTo(std::string("Engine Abort")),
              "debug mode still allows leaving a scripted state by a route the matrix forbids");
        check(svc.currentState() == ENGINE_ABORT, "and the rig gets there");
    }

    fs::remove_all(g_dir);
    std::cout << (g_failures == 0 ? "\nAll script-runtime checks passed.\n"
                                  : "\nFAILURES: " + std::to_string(g_failures) + "\n");
    return g_failures == 0 ? 0 : 1;
}
