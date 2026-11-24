/**
 * Per-run valve plans: retiming one entry's valves, and running one tank at a time.
 *
 * Two jobs on the feed-characterization bench that the CSVs cannot do, because config is frozen
 * for the life of a run:
 *
 *   1. Make both mains open together. One valve leads the other by some tens of milliseconds, you
 *      read the lead off the trace, trim it, and shoot again. Through the delays CSV that is a
 *      session stop, a config edit and a session start per trim.
 *   2. Characterize one side at a time. The flow state's column opens both; a plan holds one side
 *      shut so the same state runs with only the other flowing.
 *
 * The property under test is never "the arithmetic is right" — that was true while a staggered
 * send was being shadowed by an unstaged one and every valve moved together anyway. It is what the
 * BOARDS received and when, so everything below asserts on the wire, and the refusals assert that
 * the rig DID NOT MOVE.
 */
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#include "BoardListener.hpp"
#include "control/SequencerService.hpp"
#include "control/StateMachine.hpp"
#include "control/ValvePlan.hpp"

namespace fs = std::filesystem;
using sequencer::SequencerService;
using sequencer::State;
using sequencer::StateMachine;
using sequencer::ValveOverride;
using sequencer::ValvePlan;
using Clock = std::chrono::steady_clock;

static int g_failures = 0;
static constexpr uint16_t kPort = 45916;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

static fs::path g_dir;

/**
 * Two valves the flow state opens together: "Ox Main" on channel 1 and "Fuel Main" on channel 2.
 *
 * Named after the real pair on purpose — this is the LOX/fuel stagger the feature exists for — but
 * nothing in the code keys off the names: [flow].gate_actuator names the gate and the plan names
 * its valves, both as strings out of config.
 */
static std::string writeConfig(double ox_open_delay_s, double ox_close_delay_s,
                               uint32_t duration_ms = 1000) {
    {
        std::ofstream t(g_dir / "state_transitions.csv");
        t << ",Idle,Armed,Press Standby,Fire,Flow Test\n";
        t << "Idle,1,1,1,0,0\n";
        t << "Armed,1,1,1,0,0\n";
        t << "Press Standby,1,1,1,1,1\n";
        t << "Fire,0,1,0,1,0\n";
        t << "Flow Test,0,0,1,0,1\n";
    }
    {
        std::ofstream a(g_dir / "state_machine_actuators.csv");
        a << ",Idle,Armed,Press Standby,Fire,Flow Test\n";
        a << "Ox Main,CLOSE,CLOSE,CLOSE,OPEN,OPEN\n";
        a << "Fuel Main,CLOSE,CLOSE,CLOSE,OPEN,OPEN\n";
        // A valve the flow state SHUTS, so a plan aimed at it can be refused for the right reason.
        a << "Fuel Vent,OPEN,CLOSE,CLOSE,CLOSE,CLOSE\n";
    }
    {
        std::ofstream d(g_dir / "state_machine_actuator_delays.csv");
        d << ",Idle,Armed,Press Standby,Fire,Flow Test\n";
        // Column order above: Press Standby is the return state (3rd numeric column), Flow Test
        // the 5th.
        d << "Ox Main,0,0," << ox_close_delay_s << ",0," << ox_open_delay_s << "\n";
        d << "Fuel Main,0,0,0,0,0\n";
        d << "Fuel Vent,0,0,0,0,0\n";
    }

    const fs::path cfg_path = g_dir / "config.toml";
    std::ofstream c(cfg_path);
    c << "[network]\nactuator_cmd_port = " << kPort << "\n\n"
      << "[database]\nport = 2\n\n"  // nothing listening; the service runs without Elodin
      << "[boards.act_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 12\n"
         "enabled = true\nnum_actuators = 10\n\n"
      << "[actuator_roles]\n\"Ox Main\" = [\"NC\", 1, 12]\n\"Fuel Main\" = [\"NC\", 2, 12]\n"
         "\"Fuel Vent\" = [\"NC\", 3, 12]\n\n"
      << "[state_machine]\n"
      << "transitions_csv = \"" << (g_dir / "state_transitions.csv").string() << "\"\n"
      << "actuator_csv = \"" << (g_dir / "state_machine_actuators.csv").string() << "\"\n"
      << "actuator_delay_csv = \"" << (g_dir / "state_machine_actuator_delays.csv").string()
      << "\"\n\n"
      << "[fire]\nstate = \"Fire\"\nexpiry_target = \"Armed\"\n"
         "duration_ms = 800\nextended_ms = 1600\n\n"
      << "[flow]\nreturn_target = \"Press Standby\"\n"
      << "duration_ms = " << duration_ms << "\nmax_ms = 5000\n"
      << "gate_actuator = \"Ox Main\"\n\n"
      << "[[states]]\nid = 1\nname = \"Idle\"\nis_boot = true\n\n"
      << "[[states]]\nid = 2\nname = \"Armed\"\n\n"
      << "[[states]]\nid = 3\nname = \"Press Standby\"\n\n"
      << "[[states]]\nid = 12\nname = \"Fire\"\n\n"
      << "[[states]]\nid = 13\nname = \"Flow Test\"\nis_flow = true\n";
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

static ValveOverride atMs(uint32_t ms) {
    ValveOverride ov;
    ov.delay_ms = ms;
    return ov;
}

static ValveOverride shut() {
    ValveOverride ov;
    ov.hold_shut = true;
    return ov;
}

int main() {
    std::cout << "=== Valve plans ===" << std::endl;

    g_dir = fs::temp_directory_path() / "daq_valve_plan_test";
    fs::remove_all(g_dir);
    fs::create_directories(g_dir);

    // ── parseValvePlan: strict, because a half-read plan retimes valves nobody asked to retime ──
    {
        ValvePlan p;
        std::string why;
        check(sequencer::parseValvePlan("Ox Main=250,Fuel Main=0", p, &why) && p.size() == 2 &&
                  p["Ox Main"].delay_ms == 250 && !p["Ox Main"].hold_shut &&
                  p["Fuel Main"].delay_ms == 0,
              "parses delays, including an explicit 0 that cancels a configured stagger");

        p.clear();
        check(sequencer::parseValvePlan(" Ox Main = shut , Fuel Main = 120 ", p, &why) &&
                  p["Ox Main"].hold_shut && p["Fuel Main"].delay_ms == 120,
              "tolerates padding and reads \"shut\"; a role name keeps its internal space");

        const char* bad[] = {
            "",                            // empty
            "Ox Main",                     // no value
            "Ox Main=",                    // empty value
            "=250",                        // no role
            "Ox Main=1e3",                 // the atoi() trap: would have become 1 ms
            "Ox Main=250x",                // trailing junk
            "Ox Main=-5",                  // sign
            "Ox Main=open",                // only "shut" is a word
            "Ox Main=250,Ox Main=300",     // the same valve twice
            "Ox Main=250,",                // trailing separator
            "Ox Main=99999999",            // past the wire ceiling
        };
        bool all_rejected = true;
        std::string last;
        for (const char* b : bad) {
            ValvePlan q;
            if (sequencer::parseValvePlan(b, q, &last))
                all_rejected = false;
        }
        check(all_rejected, "rejects empty, nameless, non-numeric, signed, duplicated and "
                            "over-ceiling entries");
        check(!last.empty(), "a refusal carries a reason for the protocol reply");
    }

    // ── 1. A plan cancels a configured stagger: both mains open TOGETHER ─────────────────────
    {
        // The config opens Ox Main half a second after Fuel Main. The operator wants them
        // together, which is a plan that overrides Ox Main's delay to 0.
        const std::string cfg_path = writeConfig(/*ox_open=*/0.5, /*ox_close=*/0.0);
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with a staggered flow column");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");

        daqtest::BoardListener listener(kPort);
        check(listener.start(), "bound the actuator UDP port to watch the wire");

        ValvePlan plan{{"Ox Main", atMs(0)}};
        const auto t0 = Clock::now();
        std::string why;
        check(svc.transitionTo("Flow Test", 1000, plan, &why), "plan accepted: " + why);
        check(waitForState(svc, kStandby, 4000) >= 0, "the hold expired on its own");
        const long long total =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        std::this_thread::sleep_for(std::chrono::milliseconds(50));  // let the close land
        listener.stop();
        const auto b = listener.bursts();

        const long long ox = daqtest::firstCommand(b, /*ch=*/1, /*hw=*/1);
        const long long fuel = daqtest::firstCommand(b, /*ch=*/2, /*hw=*/1);
        check(ox >= 0 && fuel >= 0, "both mains opened");
        const long long skew = (ox >= 0 && fuel >= 0) ? std::llabs(ox - fuel) : -1;
        check(skew >= 0 && skew <= 60,
              "the two mains opened together, not 500 ms apart (" + std::to_string(skew) + " ms)");

        // The hold follows the plan too: the gate no longer waits 500 ms, so the state must not be
        // held 1500. Reading the stagger from the CSV here would have left the valves open half a
        // second longer than asked.
        check(total >= 980 && total <= 1120,
              "the state was held for the requested 1000 ms, not requested + the CSV stagger (" +
                  std::to_string(total) + " ms)");
    }

    // ── 2. A plan introduces a stagger the CSV does not have ────────────────────────────────
    {
        // The mirror image: the valves are configured together and measure 250 ms apart on the
        // trace, so the operator holds the fast one back.
        const std::string cfg_path = writeConfig(/*ox_open=*/0.0, /*ox_close=*/0.0);
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with an unstaggered flow column");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");

        daqtest::BoardListener listener(kPort);
        check(listener.start(), "bound the actuator UDP port");

        ValvePlan plan{{"Ox Main", atMs(250)}};
        const auto t0 = Clock::now();
        check(svc.transitionTo("Flow Test", 1000, plan), "plan accepted");
        check(waitForState(svc, kStandby, 4000) >= 0, "the hold expired");
        const long long total =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        listener.stop();
        const auto b = listener.bursts();

        const long long ox = daqtest::firstCommand(b, 1, 1);
        const long long fuel = daqtest::firstCommand(b, 2, 1);
        const long long ox_close = ox < 0 ? -1 : daqtest::firstCommand(b, 1, 0, ox + 1);
        check(ox >= 0 && fuel >= 0 && ox_close >= 0, "saw both opens and the gate's close");
        check(ox - fuel >= 200 && ox - fuel <= 330,
              "the planned valve opened ~250 ms after the other (" + std::to_string(ox - fuel) +
                  " ms)");
        // The requested duration is how long the GATE is open, and the plan is what the gate's
        // stagger now is: 1000 + 250.
        check(total >= 1230 && total <= 1370,
              "the state was held for requested + the PLAN's stagger (" + std::to_string(total) +
                  " ms)");
        const long long ox_open_ms = ox_close - ox;
        check(ox_open_ms >= 960 && ox_open_ms <= 1130,
              "the gate valve was open for the requested 1000 ms (" + std::to_string(ox_open_ms) +
                  " ms)");
    }

    // ── 3. One tank at a time: the other side is held shut ───────────────────────────────────
    {
        const std::string cfg_path = writeConfig(/*ox_open=*/0.0, /*ox_close=*/0.0);
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");

        daqtest::BoardListener listener(kPort);
        check(listener.start(), "bound the actuator UDP port");

        ValvePlan plan{{"Fuel Main", shut()}};
        check(svc.transitionTo("Flow Test", 1000, plan), "ox-only plan accepted");
        check(waitForState(svc, kStandby, 4000) >= 0, "the hold expired");
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        listener.stop();
        const auto b = listener.bursts();

        const long long ox = daqtest::firstCommand(b, 1, 1);
        check(ox >= 0, "the tank under test opened");
        check(daqtest::firstCommand(b, 2, 1) < 0,
              "the valve held shut was NEVER commanded open — not at entry, and not by the 1 Hz "
              "republish either");
        // It is commanded CLOSED rather than simply omitted, so a board that latched an earlier
        // open does not keep it.
        check(daqtest::firstCommand(b, 2, 0) >= 0, "it was positively commanded closed");
    }

    // ── 4. Holding the GATE shut moves the window to the valve that does open ────────────────
    {
        // [flow].gate_actuator is Ox Main and the column opens it 500 ms late. Characterizing the
        // FUEL side alone holds the gate shut — and a window measured on a valve that never opened
        // would have held the state 1500 ms for a 1000 ms request, with the fuel main open for all
        // of it.
        const std::string cfg_path = writeConfig(/*ox_open=*/0.5, /*ox_close=*/0.0);
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised with the gate staggered");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");

        daqtest::BoardListener listener(kPort);
        check(listener.start(), "bound the actuator UDP port");

        ValvePlan plan{{"Ox Main", shut()}};
        const auto t0 = Clock::now();
        check(svc.transitionTo("Flow Test", 1000, plan), "fuel-only plan accepted");
        check(waitForState(svc, kStandby, 4000) >= 0, "the hold expired");
        const long long total =
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        listener.stop();
        const auto b = listener.bursts();

        check(daqtest::firstCommand(b, 1, 1) < 0, "the gate valve never opened");
        const long long fuel = daqtest::firstCommand(b, 2, 1);
        const long long fuel_close = fuel < 0 ? -1 : daqtest::firstCommand(b, 2, 0, fuel + 1);
        check(fuel >= 0 && fuel_close >= 0, "the side under test opened and closed");
        check(total >= 980 && total <= 1120,
              "the window moved to the valve that opens: held 1000 ms, not 1000 + the absent "
              "gate's 500 (" + std::to_string(total) + " ms)");
        const long long open_ms = fuel_close - fuel;
        check(open_ms >= 960 && open_ms <= 1130,
              "the side under test was open for the requested 1000 ms (" +
                  std::to_string(open_ms) + " ms)");
    }

    // ── 5. Refusals, each leaving the rig exactly where it was ───────────────────────────────
    {
        const std::string cfg_path = writeConfig(/*ox_open=*/0.0, /*ox_close=*/0.0);
        SequencerService svc;
        check(svc.init(cfg_path), "service initialised");
        const State kStandby = StateMachine::fromName("Press Standby");
        check(svc.transitionTo(kStandby), "reached the hub");

        daqtest::BoardListener listener(kPort);
        check(listener.start(), "bound the actuator UDP port");

        // The burn. Its column opens both mains and the transition itself is allowed, so the plan
        // is the only thing standing between a replayed frame and retimed burn valves.
        {
            std::string why;
            ValvePlan plan{{"Ox Main", atMs(100)}};
            check(!svc.transitionTo("Fire", 0, plan, &why), "a plan is refused for the burn state");
            check(why == "valve plan not permitted for this state", "it says why: " + why);
            check(svc.currentState() == kStandby, "the REFUSED plan did not transition");
        }
        // A valve that does not exist. Silently ignoring it would run the shot with the stagger
        // the operator thought they had cancelled.
        {
            std::string why;
            ValvePlan plan{{"No Such Valve", atMs(100)}};
            check(!svc.transitionTo("Flow Test", 1000, plan, &why), "an unknown valve is refused");
            check(why.find("No Such Valve") != std::string::npos, "it names the valve: " + why);
            check(svc.currentState() == kStandby, "nothing moved");
        }
        // A valve the state SHUTS. Retiming that would hold it open inside a state whose column
        // closes it — a flow path the config does not have.
        {
            std::string why;
            ValvePlan plan{{"Fuel Vent", atMs(100)}};
            check(!svc.transitionTo("Flow Test", 1000, plan, &why),
                  "a valve the state does not open is refused");
            check(why.find("Fuel Vent") != std::string::npos, "it names the valve: " + why);
            check(svc.currentState() == kStandby, "nothing moved");
        }
        // Every valve shut is not a test; it is a mass weighed against nothing.
        {
            std::string why;
            ValvePlan plan{{"Ox Main", shut()}, {"Fuel Main", shut()}};
            check(!svc.transitionTo("Flow Test", 1000, plan, &why),
                  "a plan that holds every valve shut is refused");
            check(why.find("every valve shut") != std::string::npos, "it says why: " + why);
            check(svc.currentState() == kStandby, "nothing moved");
        }
        // A delay past the end of the window: the expiry transition abandons the pending stage, so
        // that valve would never open at all and the operator would weigh the catch believing it
        // had.
        {
            std::string why;
            ValvePlan plan{{"Fuel Main", atMs(1000)}};
            check(!svc.transitionTo("Flow Test", 1000, plan, &why),
                  "a delay at or past the end of the window is refused");
            check(why.find("Fuel Main") != std::string::npos, "it names the valve: " + why);
            check(svc.currentState() == kStandby, "nothing moved");
        }
        // The same plan inside a longer window is fine — the refusal above is about the window,
        // not about the number.
        {
            std::string why;
            ValvePlan plan{{"Fuel Main", atMs(1000)}};
            check(svc.transitionTo("Flow Test", 2000, plan, &why),
                  "the same delay is accepted when the window is long enough: " + why);
            check(waitForState(svc, kStandby, 5000) >= 0, "and that hold expired normally");
        }

        listener.stop();
    }

    std::cout << (g_failures == 0 ? "ALL PASS" : "FAILURES: " + std::to_string(g_failures))
              << std::endl;
    return g_failures == 0 ? 0 : 1;
}
