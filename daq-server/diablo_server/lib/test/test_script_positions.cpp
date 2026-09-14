/**
 * Script positions: a running script layering valve commands on top of its state's CSV column.
 *
 * Three properties, each of which fails silently if it is wrong:
 *
 *  1. A script's valve position SURVIVES the 1 Hz republish. Commanding a valve once and walking
 *     away is the obvious implementation and it works for about a second, after which the
 *     republish re-sends the state's column and puts the valve back. Any script whose valve is
 *     open longer than a republish period would quietly stop working.
 *
 *  2. Valves the script never names still follow their column, stagger included. A script-owned
 *     flag applied too broadly would take the whole column out of the republish.
 *
 *  3. Taking a valve cancels its staged command. The state's own delays column can schedule a
 *     valve to move seconds AFTER the script has already commanded it; the stage lands last and
 *     the valve ends up opposite to what the script said, with nothing logged.
 *
 * Drives ActuatorCommander directly — there is no interpreter yet — and asserts on the wire,
 * because a clock inside the commander is exactly what made the original delay bug invisible.
 */
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#include "BoardListener.hpp"
#include "control/ActuatorCommander.hpp"
#include "control/StateMachine.hpp"

namespace fs = std::filesystem;
using daqtest::BoardListener;
using daqtest::firstCommand;
using sequencer::ActuatorCommander;
using sequencer::State;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** Channel 1 = Vent Valve, channel 2 = Staged Valve (which the Armed column staggers). */
static std::string writeFixture(const fs::path& dir, uint16_t port, double staged_delay_s) {
    {
        std::ofstream act(dir / "state_machine_actuators.csv");
        act << ",Idle,Armed\n";
        act << "Vent Valve,CLOSE,CLOSE\n";   // never opened by the column — only a script can
        act << "Staged Valve,CLOSE,OPEN\n";  // opened by the column, on a delay
    }
    {
        std::ofstream del(dir / "state_machine_actuator_delays.csv");
        del << ",Idle,Armed\n";
        del << "Vent Valve,0,0\n";
        del << "Staged Valve,0," << staged_delay_s << "\n";
    }
    return "[network]\nactuator_cmd_port = " + std::to_string(port) +
           "\n\n[actuator_service]\nbind_address = \"0.0.0.0\"\n\n"
           "[boards.act_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 12\n"
           "enabled = true\nnum_actuators = 10\n\n"
           "[actuator_roles]\n\"Vent Valve\" = [\"NC\", 1, 12]\n"
           "\"Staged Valve\" = [\"NC\", 2, 12]\n";
}

/** How many distinct bursts commanded `ch` to `hw`. */
static int countCommands(const std::vector<daqtest::Burst>& bursts, uint8_t ch, uint8_t hw) {
    int n = 0;
    for (const auto& b : bursts) {
        auto it = b.state.find(ch);
        if (it != b.state.end() && it->second == hw)
            n++;
    }
    return n;
}

int main() {
    std::cout << "=== Script positions vs the republish ===" << std::endl;

    const uint16_t port = 45918;
    const double kStagedDelay = 2.0;  // well past the 1 s republish
    fs::path dir = fs::temp_directory_path() / "daq_script_positions_test";
    fs::remove_all(dir);
    fs::create_directories(dir);
    const std::string cfg = writeFixture(dir, port, kStagedDelay);
    const std::string csv = (dir / "state_machine_actuators.csv").string();

    // ── 1. A script position survives the republish ───────────────────────────────────────────
    {
        BoardListener listener(port);
        if (!listener.start()) {
            std::cerr << "could not bind UDP " << port << std::endl;
            return 1;
        }
        ActuatorCommander ac;
        if (!ac.load(cfg, csv)) {
            std::cerr << "load failed" << std::endl;
            listener.stop();
            return 1;
        }
        // Vent Valve is CLOSE in the Armed column; the script opens it anyway.
        ac.setScriptPosition("Vent Valve", 1);
        ac.startContinuousLoop(State::ARMED, /*allow_delays=*/true);
        std::this_thread::sleep_for(std::chrono::milliseconds(2600));
        ac.stopContinuousLoop();
        listener.stop();

        const auto b = listener.bursts();
        const int opens = countCommands(b, /*ch=*/1, /*hw=*/1);
        const int closes = countCommands(b, /*ch=*/1, /*hw=*/0);
        check(opens >= 3, "the script's OPEN is re-asserted by every republish (saw " +
                              std::to_string(opens) + ")");
        check(closes == 0, "the republish never reverts it to the column's CLOSE");
    }

    // ── 2. Valves the script does not name still follow their column, stagger included ─────────
    {
        BoardListener listener(port);
        listener.start();
        ActuatorCommander ac;
        ac.load(cfg, csv);
        ac.setScriptPosition("Vent Valve", 1);  // script owns ONLY this one
        ac.applyForState(State::ARMED, /*is_transition=*/true);
        ac.startContinuousLoop(State::ARMED, /*allow_delays=*/false);
        std::this_thread::sleep_for(std::chrono::milliseconds(2600));
        ac.stopContinuousLoop();
        listener.stop();

        const auto b = listener.bursts();
        const long long staged_open = firstCommand(b, /*ch=*/2, /*hw=*/1);
        check(staged_open >= 1700 && staged_open <= 2400,
              "an unnamed valve still honours its 2 s stagger (opened at " +
                  std::to_string(staged_open) + " ms)");
    }

    // ── 3. Taking a valve cancels its staged command ──────────────────────────────────────────
    //
    // The Armed column opens Staged Valve at +2 s. The script closes it at ~50 ms. If the stage
    // is not cancelled it lands at 2 s and re-opens a valve the script had deliberately shut.
    {
        BoardListener listener(port);
        listener.start();
        ActuatorCommander ac;
        ac.load(cfg, csv);
        ac.applyForState(State::ARMED, /*is_transition=*/true);  // arms the +2 s stage
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        ac.setScriptPosition("Staged Valve", 0);  // script takes it and closes it
        ac.sendSingleActuator("Staged Valve", 0);
        ac.startContinuousLoop(State::ARMED, /*allow_delays=*/false);
        std::this_thread::sleep_for(std::chrono::milliseconds(2600));
        ac.stopContinuousLoop();
        listener.stop();

        const auto b = listener.bursts();
        const long long reopened = firstCommand(b, /*ch=*/2, /*hw=*/1, /*after_ms=*/100);
        check(reopened < 0, "the stale +2 s stage never re-opens the valve the script closed");
        check(countCommands(b, /*ch=*/2, /*hw=*/0) >= 2,
              "and the republish keeps re-asserting the script's CLOSE");
    }

    // ── 4. A debug manual override beats a running script ─────────────────────────────────────
    {
        BoardListener listener(port);
        listener.start();
        ActuatorCommander ac;
        ac.load(cfg, csv);
        ac.setScriptPosition("Vent Valve", 1);
        ac.setManualOverride("Vent Valve", 0);  // operator takes it back
        ac.startContinuousLoop(State::ARMED, /*allow_delays=*/true);
        std::this_thread::sleep_for(std::chrono::milliseconds(1200));
        ac.stopContinuousLoop();
        listener.stop();

        const auto b = listener.bursts();
        check(countCommands(b, /*ch=*/1, /*hw=*/1) == 0 &&
                  countCommands(b, /*ch=*/1, /*hw=*/0) >= 1,
              "the operator's override wins over the script's position");
    }

    // ── 5. Clearing script positions hands the valve back to the column ───────────────────────
    {
        BoardListener listener(port);
        listener.start();
        ActuatorCommander ac;
        ac.load(cfg, csv);
        ac.setScriptPosition("Vent Valve", 1);
        ac.startContinuousLoop(State::ARMED, /*allow_delays=*/true);
        std::this_thread::sleep_for(std::chrono::milliseconds(1200));
        ac.clearScriptPositions();
        std::this_thread::sleep_for(std::chrono::milliseconds(1300));
        ac.stopContinuousLoop();
        listener.stop();

        const auto b = listener.bursts();
        check(countCommands(b, /*ch=*/1, /*hw=*/1) >= 1, "it was open while the script held it");
        check(countCommands(b, /*ch=*/1, /*hw=*/0) >= 1,
              "and back to the column's CLOSE once the script's positions were cleared");
    }

    fs::remove_all(dir);
    std::cout << (g_failures == 0 ? "\nAll script-position checks passed.\n"
                                  : "\nFAILURES: " + std::to_string(g_failures) + "\n");
    return g_failures == 0 ? 0 : 1;
}
