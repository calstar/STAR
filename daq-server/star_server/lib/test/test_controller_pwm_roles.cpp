/**
 * Which actuators the controller PWMs, resolved from config alone.
 *
 * An [actuator_roles] entry's optional 4th element — "pwm_fuel" or "pwm_ox" — assigns that
 * actuator to controller_service. It is the single statement of what the controller drives, and
 * the same fact makes ActuatorCommander stop commanding the actuator during a burn, so the two
 * cannot disagree about who owns a valve.
 *
 * Before this was config-driven, controller_main matched the literal names "Fuel Press"/"LOX Press"
 * and every step had a fallback: a missing role became CH3/CH8 on board 12, an undeclared board
 * became "192.168.2.<board_id>", an empty board table became a synthesized 11-14, and two roles on
 * two boards silently shared the first one's IP. Each drove PWM at whatever hardware happened to
 * sit on the guessed channel, behind a warning in a log nobody reads.
 *
 * So what is pinned here is mostly the *absence* of fallbacks: every unresolvable input must be
 * reported rather than substituted, because the caller turns a report into a disabled fire gate.
 *
 * Pure resolution — no sockets, no files, no dependence on the host's interfaces.
 */
#include <iostream>
#include <map>
#include <string>

#include "config/Config.hpp"
#include "control/PWMTargets.hpp"

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** `assign` maps an actuator name to its 4th element; a name absent from it is unassigned. */
static fsw::config::Config makeConfig(const std::map<std::string, std::string>& assign,
                                      bool declare_board_14 = true) {
    std::string toml;
    toml += "[boards.act]\ntype = \"ACTUATOR\"\nip = \"192.0.2.12\"\nboard_id = 12\n";
    toml += "enabled = true\n\n";
    if (declare_board_14) {
        toml += "[boards.act2]\ntype = \"ACTUATOR\"\nip = \"192.0.2.14\"\nboard_id = 14\n";
        toml += "enabled = true\n\n";
    }
    auto role = [&](const char* name, const char* kind, int ch, int board) {
        const auto it = assign.find(name);
        std::string line = std::string("\"") + name + "\" = [\"" + kind + "\", " +
                           std::to_string(ch) + ", " + std::to_string(board);
        if (it != assign.end())
            line += ", \"" + it->second + "\"";
        return line + "]\n";
    };
    toml += "[actuator_roles]\n";
    toml += role("Fuel Press", "NC", 3, 12);
    toml += role("LOX Press", "NO", 8, 12);
    toml += role("Far Side Press", "NC", 2, 14);
    return fsw::config::load_from_string(toml);
}

int main() {
    std::cout << "=== controller PWM actuator resolution ===" << std::endl;

    // 1. The happy path: one actuator assigned to each output.
    {
        const auto r = fsw::control::resolvePWMTargets(
            makeConfig({{"Fuel Press", "pwm_fuel"}, {"LOX Press", "pwm_ox"}}));
        check(r.ok(), "both outputs resolve with no issues");
        check(r.fuel.resolved() && r.fuel.channel == 3 && r.fuel.board_ip == "192.0.2.12",
              "fuel resolves to the channel and board its actuator declares");
        check(r.ox.resolved() && r.ox.channel == 8 && r.ox.board_ip == "192.0.2.12",
              "ox resolves to the channel and board its actuator declares");
        check(r.fuel.actuator_name == "Fuel Press",
              "the target carries the actuator name, so logs can say which valve");
    }

    // 2. The assignment, not the name, is what binds. Renaming an actuator in the editor moves
    //    the assignment with it — the whole point of not matching a literal "Fuel Press".
    {
        const auto r = fsw::control::resolvePWMTargets(
            makeConfig({{"Far Side Press", "pwm_fuel"}, {"LOX Press", "pwm_ox"}}));
        check(r.ok(), "any actuator can serve an output, whatever it is called");
        check(r.fuel.channel == 2 && r.fuel.board_ip == "192.0.2.14",
              "fuel follows the assignment to that actuator's own board and channel");
    }

    // 3. Nothing assigned to an output. The old code printed a warning and drove CH3 anyway.
    {
        const auto r = fsw::control::resolvePWMTargets(makeConfig({{"LOX Press", "pwm_ox"}}));
        check(!r.ok(), "an unassigned fuel output is reported");
        check(!r.fuel.resolved(), "an unassigned fuel output resolves to nothing (no CH3 default)");
        check(r.fuel.channel == 0, "unresolved target keeps channel 0 so it cannot be addressed");
        check(r.ox.resolved(), "the other output still resolves independently");
        check(r.issues.size() == 1 && r.issues[0].find("pwm_fuel") != std::string::npos,
              "the reported issue names the output that has no actuator");
    }

    // 4. Two actuators claiming one output. Taking the first would put PWM on a valve the operator
    //    did not intend — the same class of failure as the old name-matching fallbacks, so it is
    //    an error rather than a silent pick.
    {
        const auto r = fsw::control::resolvePWMTargets(makeConfig(
            {{"Fuel Press", "pwm_fuel"}, {"Far Side Press", "pwm_fuel"}, {"LOX Press", "pwm_ox"}}));
        check(!r.ok(), "a duplicate assignment is reported");
        check(!r.fuel.resolved(),
              "a duplicated output resolves to nothing rather than picking one");
        check(r.issues.size() == 1 && r.issues[0].find("Fuel Press") != std::string::npos &&
                  r.issues[0].find("Far Side Press") != std::string::npos,
              "the reported issue names both claimants");
    }

    // 5. An actuator on a board no [boards.*] declares an ip for. The old code synthesized
    //    "192.168.2.<board_id>", guessing both the addressing scheme and the subnet — and the
    //    guess is routable, so it can reach a real board that is not the intended one.
    {
        const auto r = fsw::control::resolvePWMTargets(
            makeConfig({{"Fuel Press", "pwm_fuel"}, {"Far Side Press", "pwm_ox"}},
                       /*declare_board_14=*/false));
        check(!r.ok(), "an actuator on an undeclared board is reported");
        check(!r.ox.resolved(), "no IP is synthesized from the board_id");
        check(r.issues.size() == 1 && r.issues[0].find("board_id 14") != std::string::npos,
              "the reported issue names the board that has no ip");
    }

    // 6. Nothing assigned at all. The controller reports both and its caller disables the fire
    //    gate — correct for a process whose job is to drive PWM. (The config editor deliberately
    //    treats the same state as valid, since a rig that does not use the controller must still
    //    be saveable; see validateControllerPwmActuators in shared/types.ts.)
    {
        const auto r = fsw::control::resolvePWMTargets(makeConfig({}));
        check(r.issues.size() == 2, "both unassigned outputs are reported together");
        check(!r.fuel.resolved() && !r.ox.resolved(), "neither target is invented");
    }

    // 7. Two actuators on two different boards is a legal rig, not an error: PWMConfig carries an
    //    IP per target, and sendActuationPWM splits the datagram. The old code warned and used the
    //    fuel board's IP for both, so LOX PWM went to the wrong board.
    {
        const auto r = fsw::control::resolvePWMTargets(
            makeConfig({{"Fuel Press", "pwm_fuel"}, {"Far Side Press", "pwm_ox"}}));
        check(r.ok(), "actuators on different boards are not an error");
        check(r.fuel.board_ip == "192.0.2.12" && r.ox.board_ip == "192.0.2.14",
              "each target keeps its own board IP");
    }

    // 8. No [boards.*] at all. The old code invented boards 11-14 on 192.168.2.x.
    {
        const auto cfg = fsw::config::load_from_string(
            "[actuator_roles]\n\"Fuel Press\" = [\"NC\", 3, 12, \"pwm_fuel\"]\n"
            "\"LOX Press\" = [\"NO\", 8, 12, \"pwm_ox\"]\n");
        const auto r = fsw::control::resolvePWMTargets(cfg);
        check(!r.ok(), "no declared boards is reported, not filled in from a default table");
        check(!r.fuel.resolved() && !r.ox.resolved(), "neither target is invented");
    }

    // 9. The assignment slot is independent of polarity — the reason it is a 4th element rather
    //    than a third value of `kind`. "LOX Press" is NO *and* controller-driven; if the two ever
    //    share a slot again, a PWM assignment would silently drop the normally-open inversion.
    {
        const auto cfg = makeConfig({{"Fuel Press", "pwm_fuel"}, {"LOX Press", "pwm_ox"}});
        check(cfg.actuator_roles.at("LOX Press").is_no,
              "an assigned actuator keeps its NO polarity");
        check(cfg.actuator_roles.at("LOX Press").controller_role == "pwm_ox",
              "...and its controller assignment at the same time");
        check(cfg.actuator_roles.at("Far Side Press").controller_role.empty(),
              "an unassigned actuator has no controller role");
    }

    std::cout << (g_failures ? "FAILED" : "PASSED") << ": " << g_failures << " failure(s)"
              << std::endl;
    return g_failures ? 1 : 0;
}
