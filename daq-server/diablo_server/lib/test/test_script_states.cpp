/**
 * Dynamic-state refusals: a script that does not hold up makes its state NOT ENTERABLE, and the
 * refusal happens before anything moves.
 *
 * The second half is the part a boolean cannot prove. `transitionTo() == false` would also pass an
 * implementation that applied the state's actuator column, armed a timer, and only then noticed
 * the script was broken — which is exactly the failure [flow]'s refusal branches exist to prevent
 * ("Its valves cannot be stranded open because the transition into it is now refused",
 * SequencerService.cpp). So every refusal case here asserts on the wire via BoardListener that the
 * boards received NOTHING.
 *
 * Hermetic: loopback UDP on a port of its own, [database].port = 2 so no Elodin is needed, and
 * [controller_service].host on TEST-NET-1 so nothing can reach a real controller.
 */
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#include "BoardListener.hpp"
#include "control/ScriptStates.hpp"
#include "control/SequencerService.hpp"
#include "control/StateMachine.hpp"

namespace fs = std::filesystem;
using sequencer::SequencerService;
using sequencer::State;
using sequencer::StateMachine;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

static fs::path g_dir;
static constexpr uint16_t kActPort = 45917;

/** Everything a case may vary. Defaults describe a perfectly good dynamic state. */
struct Cfg {
    std::string script_file = "good.script";
    std::string script_body =
        "open_valve(VENT_VALVE)\n"
        "delay(0.5)\n"
        "close_valve(VENT_VALVE)\n"
        "transition_to(PRESS_STANDBY)\n";
    bool write_script = true;
    uint32_t timeout_ms = 5000;
    std::string return_target = "Press Standby";
    std::string timeout_target = "Idle";
    bool is_flow = false;
    bool is_abort = false;
    /** Put the script on the Fire state instead of Dyn State. */
    bool on_fire_state = false;
    /** Omit the dynamic state's column from state_machine_actuators.csv. */
    bool drop_actuator_column = false;
};

static std::string writeConfig(const Cfg& f) {
    const std::string dyn = f.on_fire_state ? "Fire" : "Dyn State";

    {
        std::ofstream t(g_dir / "state_transitions.csv");
        t << ",Idle,Armed,Press Standby,Fire,Dyn State\n";
        t << "Idle,1,1,1,0,1\n";
        t << "Armed,1,1,1,0,1\n";
        t << "Press Standby,1,1,1,1,1\n";
        t << "Fire,0,1,0,1,0\n";
        // Dyn State may reach Idle and Press Standby, but NOT Armed — so a script naming Armed is
        // a transition the matrix forbids, which is its own case below.
        t << "Dyn State,1,0,1,0,1\n";
    }
    {
        std::ofstream a(g_dir / "state_machine_actuators.csv");
        if (f.drop_actuator_column) {
            a << ",Idle,Armed,Press Standby,Fire\n";
            a << "Vent Valve,CLOSE,CLOSE,CLOSE,CLOSE\n";
            a << "Main Valve,CLOSE,CLOSE,CLOSE,OPEN\n";
        } else {
            // Main Valve is OPEN in the Dyn State column and CLOSED everywhere else. That is the
            // tell: nothing but entering Dyn State can command channel 2 open, so "did the
            // transition move anything?" is answerable without having to separate the attempt from
            // the 1 Hz republish of the state the rig is already sitting in.
            a << ",Idle,Armed,Press Standby,Fire,Dyn State\n";
            a << "Vent Valve,CLOSE,CLOSE,CLOSE,CLOSE,CLOSE\n";
            a << "Main Valve,CLOSE,CLOSE,CLOSE,OPEN,OPEN\n";
        }
    }
    {
        std::ofstream d(g_dir / "state_machine_actuator_delays.csv");
        if (f.drop_actuator_column) {
            d << ",Idle,Armed,Press Standby,Fire\n";
            d << "Vent Valve,0,0,0,0\n";
            d << "Main Valve,0,0,0,0\n";
        } else {
            d << ",Idle,Armed,Press Standby,Fire,Dyn State\n";
            d << "Vent Valve,0,0,0,0,0\n";
            d << "Main Valve,0,0,0,0,0\n";
        }
    }

    fs::create_directories(g_dir / "scripts");
    fs::remove(g_dir / "scripts" / "good.script");
    if (f.write_script && !f.script_file.empty()) {
        // A traversal-shaped name must be refused before anything opens it, so do not try to
        // create a file for one.
        if (f.script_file.find('/') == std::string::npos &&
            f.script_file.find("..") == std::string::npos) {
            std::ofstream s(g_dir / "scripts" / f.script_file);
            s << f.script_body;
        }
    }

    const fs::path cfg_path = g_dir / "config.toml";
    std::ofstream c(cfg_path);
    c << "[network]\nactuator_cmd_port = " << kActPort << "\n\n"
      << "[database]\nport = 2\n\n"
      // TEST-NET-1: SYNs are dropped rather than refused, so nothing here can reach a controller
      // and a stray notify cannot masquerade as success.
      << "[controller_service]\nhost = \"192.0.2.1\"\nport = 9999\n\n"
      << "[boards.act_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 12\n"
         "enabled = true\nnum_actuators = 10\n\n"
      << "[boards.pt_board]\ntype = \"PT\"\nip = \"127.0.0.1\"\nboard_id = 21\nenabled = true\n\n"
      << "[sensor_roles_pt_board]\n\"Tank Pressure\" = 1\n\"Bottle Pressure\" = 2\n\n"
      << "[actuator_roles]\n\"Vent Valve\" = [\"NC\", 1, 12]\n"
         "\"Main Valve\" = [\"NC\", 2, 12]\n\n"
      << "[state_machine]\n"
      << "transitions_csv = \"" << (g_dir / "state_transitions.csv").string() << "\"\n"
      << "actuator_csv = \"" << (g_dir / "state_machine_actuators.csv").string() << "\"\n"
      << "actuator_delay_csv = \"" << (g_dir / "state_machine_actuator_delays.csv").string()
      << "\"\n\n"
      << "[fire]\nstate = \"Fire\"\nexpiry_target = \"Armed\"\nduration_ms = 800\n\n"
      << "[[states]]\nid = 1\nname = \"Idle\"\nis_boot = true\n\n"
      << "[[states]]\nid = 2\nname = \"Armed\"\n\n"
      << "[[states]]\nid = 3\nname = \"Press Standby\"\n\n";

    auto scriptKeys = [&](std::ofstream& o) {
        if (!f.script_file.empty())
            o << "script_file = \"" << f.script_file << "\"\n";
        if (f.timeout_ms != 0)
            o << "script_timeout_ms = " << f.timeout_ms << "\n";
        if (!f.return_target.empty())
            o << "script_return_target = \"" << f.return_target << "\"\n";
        if (!f.timeout_target.empty())
            o << "script_timeout_target = \"" << f.timeout_target << "\"\n";
    };

    c << "[[states]]\nid = 12\nname = \"Fire\"\n";
    if (f.on_fire_state)
        scriptKeys(c);
    c << "\n";

    c << "[[states]]\nid = 13\nname = \"Dyn State\"\n";
    if (!f.on_fire_state)
        scriptKeys(c);
    if (f.is_flow)
        c << "is_flow = true\n";
    if (f.is_abort)
        c << "is_abort = true\n";
    c << "\n";

    // [flow] needs a return target when is_flow is set, or the flow branch refuses first and the
    // case would be measuring the wrong refusal.
    if (f.is_flow)
        c << "[flow]\nreturn_target = \"Idle\"\nduration_ms = 500\n\n";

    return cfg_path.string();
}

/**
 * Bring a service up on `cfg`, try to enter Dyn State, and report what happened.
 * `moved` is true if ANY actuator command reached the boards during the attempt.
 */
struct Attempt {
    bool accepted = false;
    bool moved = false;
    State landed = State::UNKNOWN;
    std::string reason;
};

static Attempt attemptEntry(const std::string& cfg_path, const char* target = "Dyn State") {
    Attempt a;
    SequencerService svc;
    if (!svc.init(cfg_path)) {
        a.reason = "init failed";
        return a;
    }

    // The listener starts AFTER init, so the boot state's own republish is outside the window and
    // "moved" means exactly "the attempt to enter this state commanded something". BoardListener
    // has no reset(), and adding one would be a second way to express the same thing.
    //
    // The 1 Hz republish of the state the rig is already in would eventually land here too, so the
    // observation window is kept well under a second.
    daqtest::BoardListener listener(kActPort);
    listener.start();

    a.accepted = svc.transitionTo(std::string(target), 0, &a.reason);
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    a.landed = svc.currentState();

    listener.stop();
    // Channel 2 (Main Valve) is OPEN only in the target state's column, so seeing it commanded
    // open is proof the transition got as far as applying actuators. Asserting "no bursts at all"
    // would be wrong: the republish of the state the rig is ALREADY in keeps ticking throughout,
    // and a refusal is not supposed to stop that.
    a.moved = daqtest::firstCommand(listener.bursts(), /*ch=*/2, /*hw=*/1) >= 0;
    return a;
}

/** A refusal case: the state must not be enterable AND no board may hear anything. */
static void refuses(const Cfg& f, const std::string& what) {
    const std::string path = writeConfig(f);
    const Attempt a = attemptEntry(path);
    const bool ok = !a.accepted && a.landed == State::IDLE && !a.moved;
    check(ok, what);
    if (!ok) {
        std::cout << "         accepted=" << a.accepted
                  << " landed=" << StateMachine::name(a.landed) << " moved=" << a.moved
                  << " reason=\"" << a.reason << "\"" << std::endl;
    }
}

int main() {
    std::cout << "=== Dynamic-state refusals ===" << std::endl;

    g_dir = fs::temp_directory_path() / "daq_script_states_test";
    fs::remove_all(g_dir);
    fs::create_directories(g_dir);

    // ── The control: a good dynamic state IS enterable ────────────────────────────────────────
    {
        const std::string path = writeConfig(Cfg{});
        const Attempt a = attemptEntry(path);
        // By name, never by enumerator: id 13 is State::VENT in the compiled enum, which is a
        // different state from the "Dyn State" this config declares at that id. Resolving through
        // the config's own table is the whole reason ids are not the authority.
        const State dyn = StateMachine::fromName("Dyn State");
        check(a.accepted && a.landed == dyn, "a valid dynamic state is enterable");
        check(a.moved,
              "entering it applies its actuator column (the baseline the script layers on)");
        if (!a.accepted)
            std::cout << "         reason=\"" << a.reason << "\"" << std::endl;
    }

    // ── Bounded lifetime ──────────────────────────────────────────────────────────────────────
    {
        Cfg f;
        f.timeout_ms = 0;
        refuses(f, "no script_timeout_ms — refused, nothing moved");
    }
    {
        Cfg f;
        f.timeout_ms = sequencer::kMaxScriptTimeoutMs + 1;
        refuses(f, "script_timeout_ms above the ceiling — refused, nothing moved");
    }

    // ── Both landing states, each resolved and each reachable ─────────────────────────────────
    {
        Cfg f;
        f.return_target = "";
        refuses(f, "no script_return_target — refused, nothing moved");
    }
    {
        Cfg f;
        f.timeout_target = "";
        refuses(f, "no script_timeout_target — refused, nothing moved");
    }
    {
        Cfg f;
        f.return_target = "Nowhere";
        refuses(f, "script_return_target names no known state — refused, nothing moved");
    }
    {
        Cfg f;
        f.timeout_target = "Dyn State";
        refuses(f, "script_timeout_target is the state itself — refused, nothing moved");
    }
    {
        // Dyn State -> Armed is a 0 in the matrix.
        Cfg f;
        f.return_target = "Armed";
        refuses(f, "script_return_target is not an allowed transition — refused, nothing moved");
    }

    // ── The script file ───────────────────────────────────────────────────────────────────────
    {
        Cfg f;
        f.write_script = false;
        refuses(f, "script file missing (did not deploy) — refused, nothing moved");
    }
    {
        Cfg f;
        f.script_file = "../../etc/passwd";
        refuses(f, "script_file with path separators — refused, nothing moved");
    }
    {
        Cfg f;
        f.script_file = "notes.txt";
        refuses(f, "script_file without the .script suffix — refused, nothing moved");
    }
    {
        Cfg f;
        f.script_body = "";
        refuses(f, "empty script — refused, nothing moved");
    }

    // ── The script's content ──────────────────────────────────────────────────────────────────
    {
        Cfg f;
        f.script_body = "open_valve(VENT_VALVE)\ndelay(0.5\n";
        refuses(f, "script does not parse — refused, nothing moved");
    }
    {
        Cfg f;
        f.script_body = "open_valve(VNET_VALVE)\ndelay(0.5)\n";
        refuses(f, "script names an unknown valve — refused, nothing moved");
    }
    {
        Cfg f;
        f.script_body = "x = pressure(NO_SUCH_SENSOR)\ndelay(x)\n";
        refuses(f, "script names an unknown sensor — refused, nothing moved");
    }
    {
        // Dyn State -> Armed is forbidden by the matrix, and this one is buried in an if so it is
        // only found by checking EVERY transition_to target, not just the configured fallbacks.
        Cfg f;
        f.script_body =
            "if pressure(TANK_PRESSURE) > 100:\n"
            "    transition_to(ARMED)\n"
            "delay(1)\n";
        refuses(f, "a nested transition_to the matrix forbids — refused, nothing moved");
    }
    {
        Cfg f;
        f.script_body = "while pressure(TANK_PRESSURE) < 100:\n    open_valve(VENT_VALVE)\n";
        refuses(f, "a loop that never delays — refused, nothing moved");
    }

    // ── One state, one owner ──────────────────────────────────────────────────────────────────
    {
        Cfg f;
        f.is_flow = true;
        refuses(f, "is_flow and a script on one state — refused, nothing moved");
    }
    {
        Cfg f;
        f.is_abort = true;
        refuses(f, "an abort state with a script — refused, nothing moved");
    }
    {
        Cfg f;
        f.on_fire_state = true;
        const std::string path = writeConfig(f);
        const Attempt a = attemptEntry(path, "Fire");
        check(!a.accepted && !a.moved, "the fire state with a script — refused, nothing moved");
    }

    // ── The CSV column the script layers onto ─────────────────────────────────────────────────
    {
        Cfg f;
        f.drop_actuator_column = true;
        refuses(f, "no actuator column for the dynamic state — refused, nothing moved");
    }

    // ── The refusal is reported, with a reason an operator can act on ─────────────────────────
    {
        Cfg f;
        f.script_body = "open_valve(VNET_VALVE)\ndelay(0.5)\n";
        const std::string path = writeConfig(f);
        SequencerService svc;
        svc.init(path);
        const std::string report = svc.scriptStatusReport();

        check(report.find("REFUSED") != std::string::npos, "SCRIPTS reports the state as REFUSED");
        check(report.find("VNET_VALVE") != std::string::npos,
              "the reason names the offending slug, so the panel can show it on hover");
        check(report.find("line 1") != std::string::npos, "the reason carries the line number");
        check(report.find("END") != std::string::npos, "the report is terminated");
    }
    {
        const std::string path = writeConfig(Cfg{});
        SequencerService svc;
        svc.init(path);
        const std::string report = svc.scriptStatusReport();
        check(report.find(":OK:") != std::string::npos, "SCRIPTS reports a good script as OK");
    }

    fs::remove_all(g_dir);
    std::cout << (g_failures == 0 ? "\nAll dynamic-state refusal checks passed.\n"
                                  : "\nFAILURES: " + std::to_string(g_failures) + "\n");
    return g_failures == 0 ? 0 : 1;
}
