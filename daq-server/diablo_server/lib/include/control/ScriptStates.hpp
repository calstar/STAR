#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>

#include "config/Config.hpp"
#include "control/StateMachine.hpp"
#include "script/StateScript.hpp"

namespace sequencer {

/**
 * Hard ceiling on script_timeout_ms, independent of per-state config.
 *
 * Same posture as HoldParse's kMaxHoldMs: this is not the real limit — each state carries its own,
 * usually far smaller — it exists so a typo cannot arm a valve-open window measured in hours.
 */
inline constexpr uint32_t kMaxScriptTimeoutMs = 600000;  // 10 minutes

/** One dynamic state, resolved and proven usable. */
struct DynamicState {
    State state = State::UNKNOWN;
    std::string name;
    fsw::script::ScriptProgram program;
    uint32_t timeout_ms = 0;
    /** Where the state lands when the script runs off its end. */
    State return_target = State::UNKNOWN;
    /** Where it lands when timeout_ms expires. May differ from return_target. */
    State timeout_target = State::UNKNOWN;
    /** Canonical PT role names this script reads, deduplicated. The pressure subscriber's
     *  subscribe list is the union of these across every dynamic state — Elodin has no wildcard,
     *  and deriving the list from the AST is what makes it impossible to subscribe to the wrong
     *  table for a role. */
    std::vector<std::string> pressure_roles;

    /**
     * Parallel to program.slugs — what each slug reference resolves to, decided at load.
     *
     * Resolution cannot fail at runtime this way. A lookup performed mid-script would have to have
     * a failure path, and the only honest thing that path could do is abort a script that is
     * holding valves; doing it here means an unresolvable name is a state that never becomes
     * enterable instead.
     *
     * `names` holds the canonical config name for actuator and sensor slugs (empty for states);
     * `states` holds the resolved State for transition targets (UNKNOWN otherwise).
     */
    std::vector<std::string> slug_names;
    std::vector<State> slug_states;
};

/**
 * What a config load made of its dynamic states.
 *
 * A state lands in exactly one of the two maps. `refused` is not an error to be recovered from —
 * it is the answer, and it is the safe one: the sequencer treats a refused state as not enterable,
 * so a script that does not hold up produces an unavailable button rather than an open valve.
 *
 * This mirrors the five refusal branches [flow] already uses (SequencerService.cpp:384-445) and
 * for the same stated reason: a hold that cannot close its valve has no safe degraded mode, so it
 * must not be enterable at all.
 */
struct ScriptLoadResult {
    std::map<State, DynamicState> dynamic;
    std::map<State, std::string> refused;  // state -> operator-readable reason
};

/** Everything load_dynamic_states needs that it cannot get from Config alone. */
struct ScriptLoadContext {
    /** Directory holding config.toml; scripts resolve to <config_dir>/scripts/<script_file>. */
    std::string config_dir;
    /** Transition matrix, already loaded. */
    const StateMachine* state_machine = nullptr;
    /** The [fire] state, so a script cannot be attached to the burn. */
    State fire_state = State::UNKNOWN;
    /** True when the named state has a column in state_machine_actuators.csv. A dynamic state
     *  must have one: the column is the defined baseline the script layers onto, and without it
     *  entry would leave every unmentioned valve wherever the previous state put it. */
    std::function<bool(const std::string& state_name)> has_actuator_column;
};

/**
 * Resolve, load and validate every `[[states]]` entry carrying a script_file.
 *
 * Never throws and never partially applies: a state either comes back fully usable or fully
 * refused with a reason fit to show an operator.
 */
ScriptLoadResult load_dynamic_states(const fsw::config::Config& cfg, const std::string& config_text,
                                     const ScriptLoadContext& ctx);

/** True when `name` is a safe bare script filename: ^[A-Za-z0-9_-]+\.script$, no separators. */
bool is_valid_script_filename(const std::string& name);

}  // namespace sequencer
