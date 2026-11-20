/**
 * state_script_check — validate a dynamic-state script against a config, and exit 0 or 1.
 *
 * Hermetic. Opens no sockets, touches no boards, starts no services, reads exactly the two files
 * it is given. It is in the same family as cppcheck, not in the family of things
 * daq-server/CLAUDE.md forbids running.
 *
 * This exists so the config editor can say "line 4: unknown actuator" at the operator's desk,
 * between sessions, when no sequencer is running. The web backend spawns it on save. It is early
 * warning only — the sequencer parses the script itself at startup and is the authority on whether
 * a state becomes enterable, so a stale checker binary degrades the editing experience and never
 * the stand.
 *
 *   state_script_check --config <config.toml> --state <"State Name"> [--transitions <csv>] <script>
 *
 * Output is one diagnostic per line: `<line>:<col>: <CODE> <message>`, which is what the backend
 * parses back into the editor's gutter.
 */

#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "config/Config.hpp"
#include "control/StateMachine.hpp"
#include "script/ScriptConfig.hpp"
#include "script/StateScript.hpp"

namespace {

int usage() {
    std::cerr << "usage: state_script_check --config <config.toml> --state <name> "
                 "[--transitions <state_transitions.csv>] <script-file>\n";
    return 2;
}

/**
 * Sends anything written to std::cout to stderr for as long as it is alive.
 *
 * StateMachine logs its "Loaded 20 state(s)" banner on std::cout, which is fine in a service and
 * ruinous here: stdout is this tool's machine-readable channel and the backend parses every line
 * of it into the editor's gutter. Rather than change logging that other services rely on, the two
 * calls that emit it are wrapped.
 */
class CoutToStderr {
public:
    CoutToStderr() : saved_(std::cout.rdbuf(std::cerr.rdbuf())) {
    }
    ~CoutToStderr() {
        std::cout.rdbuf(saved_);
    }

private:
    std::streambuf* saved_;
};

bool readFile(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open())
        return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    std::string config_path, state_name, transitions_path, script_path;

    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        auto next = [&](std::string& dst) {
            if (i + 1 >= argc)
                return false;
            dst = argv[++i];
            return true;
        };
        if (a == "--config") {
            if (!next(config_path))
                return usage();
        } else if (a == "--state") {
            if (!next(state_name))
                return usage();
        } else if (a == "--transitions") {
            if (!next(transitions_path))
                return usage();
        } else if (a == "-h" || a == "--help") {
            return usage();
        } else if (!a.empty() && a[0] == '-') {
            std::cerr << "unknown option " << a << "\n";
            return usage();
        } else {
            script_path = a;
        }
    }
    if (config_path.empty() || state_name.empty() || script_path.empty())
        return usage();

    std::string config_text;
    if (!readFile(config_path, config_text)) {
        std::cerr << "cannot read config: " << config_path << "\n";
        return 2;
    }
    std::string script_text;
    if (!readFile(script_path, script_text)) {
        std::cerr << "cannot read script: " << script_path << "\n";
        return 2;
    }

    const fsw::config::Config cfg = fsw::config::load_from_string(config_text);
    if (cfg.states.empty()) {
        // load_from_string swallows a TOML parse error and hands back a default Config, so "no
        // states" is indistinguishable here from "the file did not parse". Either way the answer
        // the operator needs is the same: this config cannot be checked against.
        std::cerr << "config declares no [[states]] (or failed to parse): " << config_path << "\n";
        return 2;
    }

    auto build = fsw::script::build_slug_tables(cfg);
    for (const auto& b : build.bad)
        std::cerr << "config: " << b.where << " \"" << b.canonical
                  << "\" has no usable slug (got \"" << b.slug << "\") — a script cannot name it\n";
    for (const auto& c : build.collisions)
        std::cerr << "config: " << c.where << "s \"" << c.first << "\" and \"" << c.second
                  << "\" both slug to " << c.slug << " — ambiguous\n";
    if (!build.ok())
        return 2;

    // Which states this one may transition to. Without a transitions CSV every transition_to would
    // be reported as not allowed, which would be a confidently wrong answer — so refuse instead.
    sequencer::StateMachine sm;
    const std::string csv =
        transitions_path.empty() ? cfg.state_machine.transitions_csv : transitions_path;
    bool csv_ok = false;
    {
        CoutToStderr quiet;  // keep StateMachine's banner off the diagnostics channel
        sequencer::StateMachine::loadStatesFromConfig(config_text);
        csv_ok = sm.load(csv);
    }
    if (!csv_ok) {
        std::cerr << "cannot read state_transitions.csv: " << csv
                  << " (pass --transitions to point at it)\n";
        return 2;
    }
    const sequencer::State from = sequencer::StateMachine::fromName(state_name);
    if (from == sequencer::State::UNKNOWN) {
        std::cerr << "config declares no state named \"" << state_name << "\"\n";
        return 2;
    }
    for (const auto& s : cfg.states) {
        if (s.name.empty())
            continue;
        const sequencer::State to = sequencer::StateMachine::fromName(s.name);
        if (to != sequencer::State::UNKNOWN && sm.isAllowed(from, to))
            build.tables.allowed_transitions.insert(fsw::script::slugify(s.name));
    }

    fsw::script::ParseResult parsed = fsw::script::parse(script_text);
    std::vector<fsw::script::Diagnostic> issues = parsed.diagnostics;
    if (issues.empty())
        issues = fsw::script::validate(parsed.program, build.tables);

    for (const auto& d : issues)
        std::cout << d.line << ":" << d.col << ": " << fsw::script::diag_name(d.code) << " "
                  << d.message << "\n";

    return issues.empty() ? 0 : 1;
}
