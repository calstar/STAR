#include "control/ScriptStates.hpp"

#include <algorithm>
#include <fstream>
#include <set>
#include <sstream>

#include "script/ScriptConfig.hpp"

namespace sequencer {

bool is_valid_script_filename(const std::string& name) {
    // Bare filename only. This value comes from operator-editable config and the web backend
    // writes files at it, so anything that could escape the scripts/ directory is refused rather
    // than sanitised — a sanitiser that silently rewrites a path is a rule nobody can see.
    static const std::string kSuffix = ".script";
    if (name.size() <= kSuffix.size())
        return false;
    if (name.compare(name.size() - kSuffix.size(), kSuffix.size(), kSuffix) != 0)
        return false;
    const std::string stem = name.substr(0, name.size() - kSuffix.size());
    if (stem.empty())
        return false;
    for (char c : stem) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                        (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok)
            return false;
    }
    return true;
}

namespace {

bool readFile(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open())
        return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

std::string joinPath(const std::string& dir, const std::string& leaf) {
    if (dir.empty())
        return leaf;
    if (dir.back() == '/')
        return dir + leaf;
    return dir + "/" + leaf;
}

/** One diagnostic rendered the way an operator should see it on the panel. */
std::string renderDiag(const std::string& file, const fsw::script::Diagnostic& d) {
    return file + " line " + std::to_string(d.line) + ": " + d.message;
}

}  // namespace

ScriptLoadResult load_dynamic_states(const fsw::config::Config& cfg, const std::string& config_text,
                                     const ScriptLoadContext& ctx) {
    ScriptLoadResult out;
    (void)config_text;  // states already parsed into cfg; kept for symmetry with other loaders

    // Slug tables are built once and shared: every script validates against the same view of the
    // rig that the pressure subscriber will later resolve roles through.
    auto build = fsw::script::build_slug_tables(cfg);

    // A name that cannot become a slug, or two names in one namespace that collide, makes EVERY
    // script unresolvable rather than just one. Refuse every dynamic state with that reason rather
    // than letting scripts fail one at a time with a confusing message apiece.
    std::string config_level_problem;
    for (const auto& b : build.bad)
        config_level_problem += (config_level_problem.empty() ? "" : "; ") + b.where + " \"" +
                                b.canonical + "\" has no usable slug (got \"" + b.slug + "\")";
    for (const auto& c : build.collisions)
        config_level_problem += (config_level_problem.empty() ? "" : "; ") + c.where + "s \"" +
                                c.first + "\" and \"" + c.second + "\" both slug to " + c.slug;

    for (const auto& sd : cfg.states) {
        if (sd.script_file.empty())
            continue;  // not dynamic
        if (sd.id < 0 || sd.id > 255 || sd.name.empty())
            continue;  // malformed entry; loadStatesFromConfig already skipped it
        const State self = static_cast<State>(static_cast<uint8_t>(sd.id));

        auto refuse = [&](const std::string& why) {
            out.refused[self] = sd.name + ": " + why;
        };

        if (!config_level_problem.empty()) {
            refuse("config cannot be resolved to script names — " + config_level_problem);
            continue;
        }

        // ── 11 / 12: a script must not share a state with the other two owners of its lifetime ──
        if (sd.is_flow) {
            refuse(
                "carries both is_flow and a script — the characterization hold and a script "
                "would both own this state's timer");
            continue;
        }
        if (self == ctx.fire_state) {
            refuse("is the [fire] state and cannot also run a script");
            continue;
        }
        if (sd.is_abort) {
            refuse(
                "is an abort state and cannot run a script — an abort must reach the valves "
                "immediately, never behind an interpreter");
            continue;
        }

        // ── 6: the filename, before anything touches the filesystem ─────────────────────────────
        if (!is_valid_script_filename(sd.script_file)) {
            refuse("script_file \"" + sd.script_file +
                   "\" is not a bare <name>.script filename (letters, digits, _ and - only)");
            continue;
        }

        // ── 1 / 13: a bounded lifetime ──────────────────────────────────────────────────────────
        if (sd.script_timeout_ms == 0) {
            refuse(
                "has a script but no script_timeout_ms — an unbounded script has no safe "
                "degraded mode");
            continue;
        }
        if (sd.script_timeout_ms > kMaxScriptTimeoutMs) {
            refuse("script_timeout_ms is " + std::to_string(sd.script_timeout_ms) +
                   " ms, above the " + std::to_string(kMaxScriptTimeoutMs) +
                   " ms ceiling — a typo must not arm a long valve-open window");
            continue;
        }

        // ── 2-5: both landing states, each resolved and each reachable ──────────────────────────
        if (sd.script_return_target.empty()) {
            refuse(
                "has a script but no script_return_target — where it lands when the script "
                "runs off its end must be stated, not defaulted");
            continue;
        }
        if (sd.script_timeout_target.empty()) {
            refuse(
                "has a script but no script_timeout_target — where it lands when the timeout "
                "expires must be stated, not defaulted");
            continue;
        }
        struct Target {
            const char* key;
            const std::string& name;
            State resolved;
        };
        Target targets[] = {
            {"script_return_target", sd.script_return_target,
             StateMachine::fromName(sd.script_return_target)},
            {"script_timeout_target", sd.script_timeout_target,
             StateMachine::fromName(sd.script_timeout_target)},
        };
        bool target_bad = false;
        for (const Target& t : targets) {
            if (t.resolved == State::UNKNOWN) {
                refuse(std::string(t.key) + " \"" + t.name + "\" is not a known state");
                target_bad = true;
                break;
            }
            if (t.resolved == self) {
                // [flow]'s ret == flow_state branch, and for the same reason: a state that lands
                // in itself re-arms forever with its valves wherever the script left them, and
                // there is no close anywhere in that loop.
                refuse(std::string(t.key) + " is this state itself — it would re-arm forever");
                target_bad = true;
                break;
            }
            if (ctx.state_machine != nullptr && !ctx.state_machine->isAllowed(self, t.resolved)) {
                refuse(std::string(t.key) + " \"" + t.name +
                       "\" is not an allowed transition from here — the state would have no way "
                       "out");
                target_bad = true;
                break;
            }
        }
        if (target_bad)
            continue;

        // ── 10: the CSV column the script layers onto ───────────────────────────────────────────
        if (ctx.has_actuator_column && !ctx.has_actuator_column(sd.name)) {
            refuse(
                "has no column in state_machine_actuators.csv — a dynamic state still needs "
                "one, because entry applies it first to put every valve in a defined position "
                "before the script runs");
            continue;
        }

        // ── 6: the file itself ──────────────────────────────────────────────────────────────────
        const std::string path = joinPath(joinPath(ctx.config_dir, "scripts"), sd.script_file);
        std::string text;
        if (!readFile(path, text)) {
            refuse("cannot read " + path +
                   " — the script did not deploy with the profile, or the name is wrong");
            continue;
        }

        // ── 7: parse, with every cap ────────────────────────────────────────────────────────────
        fsw::script::ParseResult parsed = fsw::script::parse(text);
        if (!parsed.ok()) {
            refuse(renderDiag(sd.script_file, parsed.diagnostics.front()));
            continue;
        }
        if (parsed.program.empty()) {
            refuse(sd.script_file + " is empty — a dynamic state must actually do something");
            continue;
        }

        // ── 8 / 9: names, and every transition_to target against the matrix ─────────────────────
        fsw::script::SlugTables tables = build.tables;
        if (ctx.state_machine != nullptr) {
            for (const auto& other : cfg.states) {
                if (other.name.empty())
                    continue;
                const State to = StateMachine::fromName(other.name);
                if (to != State::UNKNOWN && ctx.state_machine->isAllowed(self, to))
                    tables.allowed_transitions.insert(fsw::script::slugify(other.name));
            }
        }
        const auto issues = fsw::script::validate(parsed.program, tables);
        if (!issues.empty()) {
            refuse(renderDiag(sd.script_file, issues.front()));
            continue;
        }

        // ── Usable. Collect the PT roles it reads, for the subscribe list. ──────────────────────
        DynamicState ds;
        ds.state = self;
        ds.name = sd.name;
        ds.program = std::move(parsed.program);
        ds.timeout_ms = sd.script_timeout_ms;
        ds.return_target = targets[0].resolved;
        ds.timeout_target = targets[1].resolved;

        std::set<std::string> roles;
        for (const auto& ref : ds.program.slugs) {
            if (ref.ns != fsw::script::Ns::PtSensor)
                continue;
            auto it = tables.sensors.find(ref.slug);
            if (it != tables.sensors.end())
                roles.insert(it->second);  // canonical config name, not the slug
        }
        ds.pressure_roles.assign(roles.begin(), roles.end());

        out.dynamic[self] = std::move(ds);
    }

    return out;
}

}  // namespace sequencer
