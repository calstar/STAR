#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "comms/CommsMessage.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "control/SequencerService.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "net/DaqInterface.hpp"

namespace sequencer {

// ─────────────────────────────────────────────────────────────────────────────
static std::string readFile(const std::string& path) {
    std::ifstream f(path);
    if (!f.is_open())
        return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

bool SequencerService::loadConfig(const std::string& path) {
    const char* fallbacks[] = {
        "config/config.toml",
        "../config/config.toml",
        "../../config/config.toml",
    };

    config_content_ = readFile(path);
    config_path_ = path;

    if (config_content_.empty()) {
        for (const char* fb : fallbacks) {
            if (std::string(fb) == path)
                continue;
            config_content_ = readFile(fb);
            if (!config_content_.empty()) {
                config_path_ = fb;
                break;
            }
        }
    }

    if (config_content_.empty())
        std::cerr << "[SequencerService] config.toml not found; using defaults" << std::endl;
    else
        std::cout << "[SequencerService] Loaded config: " << config_path_ << std::endl;

    return true;  // non-fatal: service can start without config
}

std::string SequencerService::configDir() const {
    // Scripts live beside the config that names them, so they follow it through whichever fallback
    // path loadConfig() actually found — resolving them against the cwd instead would work from
    // build/ and silently fail from anywhere else.
    const size_t slash = config_path_.find_last_of('/');
    if (slash == std::string::npos)
        return ".";
    return config_path_.substr(0, slash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a relative path against a list of candidate prefixes; returns first
// existing match or the original path (so callers still get the error).
static std::string resolveDataPath(const std::string& rel) {
    const char* prefixes[] = {
        "",        // cwd = repo root (launched from repo root)
        "../",     // cwd = build/  (e.g. manual run)
        "../../",  // cwd = build/bin/
    };
    for (const char* pfx : prefixes) {
        std::string candidate = std::string(pfx) + rel;
        if (std::ifstream(candidate).good())
            return candidate;
    }
    return rel;  // original — caller will get the open error
}

// ─────────────────────────────────────────────────────────────────────────────
// applyConfig — everything a config load has to apply, in the one order that works.
// Kept separate from init() so the order is stated once, in one place, rather than inline.
// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::applyConfig(const fsw::config::Config& cfg) {
    // Adopt [[states]] BEFORE anything resolves a state name. Both CSVs are parsed by name through
    // StateMachine::fromName(), which prefers the config's by_name map and falls back to the
    // compiled enum. This call used to sit below both loads, so the transition table was built
    // against the fallback numbering and every later fromName() answered from the config's — the
    // table said Armed(2) -> Press Standby(20) while a command for Press Standby resolved to 3,
    // and the transition was refused. Only ids identical in both numberings survived, which is why
    // Idle <-> Armed worked and nothing else did.
    StateMachine::loadStatesFromConfig(config_content_);

    // State machine CSV — path from config.toml (canonical: daq-server/config/).
    std::string sm_csv = resolveDataPath(cfg.state_machine.transitions_csv);
    if (!state_machine_.load(sm_csv)) {
        std::cerr
            << "[SequencerService] Failed to load state_transitions.csv (tried relative to cwd: "
            << sm_csv << ")" << std::endl;
        return false;
    }

    // Actuator commander — path from config.toml (canonical: daq-server/config/).
    std::string act_csv = resolveDataPath(cfg.state_machine.actuator_csv);
    // Pass the delays path explicitly. It was declared in config and read by nobody — the commander
    // guessed it from the positions filename instead, so a renamed positions file silently disabled
    // every staged delay on the stand.
    std::string delay_csv = resolveDataPath(cfg.state_machine.actuator_delay_csv);
    if (!actuator_commander_.load(config_content_, act_csv, delay_csv)) {
        std::cerr << "[SequencerService] Failed to load state_machine_actuators.csv (tried: "
                  << act_csv << ")" << std::endl;
        return false;
    }

    // Which NIC board traffic leaves from. Resolved once, here, and handed to both UDP senders:
    // the actuator commander and the abort broadcaster. See net/DaqInterface.hpp for why the
    // sequencer cannot simply let the kernel choose.
    {
        const auto nic = fsw::net::resolveDaqBindAddress(cfg, "Sequencer");
        if (!nic.ok)
            return false;
        daq_bind_address_ = nic.address;
        actuator_commander_.setDefaultBindAddress(daq_bind_address_);
    }

    // Abort destination and port from config. Previously the broadcaster was default-constructed
    // and never told anything, so it sent to 255.255.255.255:5005 regardless of what the rig was
    // configured for. [server_heartbeat] is the section that already names where board broadcasts
    // go, and every shipped profile sets it.
    if (!abort_broadcaster_.configure(cfg.server_heartbeat.broadcast_ip,
                                      cfg.server_heartbeat.broadcast_port, kAbortDoneDelayMs,
                                      daq_bind_address_)) {
        std::cerr << "[SequencerService] [server_heartbeat].broadcast_ip is not a valid address"
                  << std::endl;
        return false;
    }

    // ── [fire]: which state burns, and where its timer lands ─────────────────────────────────
    // Names, not enumerators. `state_val == 16` in ControllerService and a stringified
    // State::ARMED here were the two places a rename or renumber silently broke ignition.
    State fire_state = State::UNKNOWN;
    State fire_expiry = State::UNKNOWN;
    {
        const std::string fs = cfg.fire.state;
        if (fs.empty()) {
            // No fire state configured → the fire timer never arms (nothing to auto-transition out
            // of). UNKNOWN never equals a real state in transitionTo's `to == fire_state_` check.
            fire_state = State::UNKNOWN;
        } else {
            const State s = StateMachine::fromName(fs);
            if (s == State::UNKNOWN) {
                // Every branch assigns. This used to log "falling back to Fire" and then leave the
                // member at its State::FIRE initializer — id 16, which a profile that renumbered
                // its states need not even have, and which on another might be a completely
                // different state that would then arm the burn timer. On a reload it additionally
                // kept whatever the PREVIOUS config had resolved to. Disabling is the safe answer.
                std::cerr << "[SequencerService] [fire] state \"" << fs
                          << "\" is not a known state — the fire timer is DISABLED" << std::endl;
            } else {
                fire_state = s;
            }
        }
        const std::string ft = cfg.fire.expiry_target;
        if (!ft.empty()) {
            const State s = StateMachine::fromName(ft);
            if (s == State::UNKNOWN)
                // Same rule as the fire state: an undeclared name disables auto-expiry (leaves
                // UNKNOWN, so the isAllowed check below warns) rather than falling back to a
                // compiled Armed, which names a different state on a renumbered rig.
                std::cerr << "[SequencerService] [fire] expiry_target \"" << ft
                          << "\" is not a declared state — fire auto-expiry disabled" << std::endl;
            else
                fire_expiry = s;
        }
    }
    fire_state_ = fire_state;
    fire_expiry_state_ = fire_expiry;
    fire_duration_ms_ = cfg.fire.duration_ms;
    fire_extended_ms_ = cfg.fire.extended_ms;
    actuator_commander_.setFireState(fire_state);

    if (fire_state == State::UNKNOWN) {
        std::cout << "[SequencerService] Fire state: (none) — fire timer disabled" << std::endl;
    } else {
        std::cout << "[SequencerService] Fire state: " << StateMachine::name(fire_state)
                  << " → expires to " << StateMachine::name(fire_expiry) << " after "
                  << cfg.fire.duration_ms << " ms (extended " << cfg.fire.extended_ms << " ms)"
                  << std::endl;
        // The expiry transition goes through the same isAllowed() gate as any other, so a
        // target the fire state cannot reach leaves the system sitting in FIRE with a dead
        // timer. Say so at startup rather than at T-0.
        if (!state_machine_.isAllowed(fire_state, fire_expiry))
            std::cerr << "[SequencerService] WARNING: " << StateMachine::name(fire_state) << " → "
                      << StateMachine::name(fire_expiry)
                      << " is not an allowed transition — the fire timer will expire into a "
                         "refused transition and the system will stay in fire."
                      << std::endl;
    }

    // ── Hold rules ───────────────────────────────────────────────────────────────────────────
    // Exactly two things create entries, and both write `gui_settable` as a literal. It is never
    // read from config, so no config edit — deliberate or accidental — can make a burn window
    // settable by a client.
    std::map<State, HoldRule> rules;

    if (fire_state != State::UNKNOWN) {
        HoldRule r;
        r.default_ms = cfg.fire.duration_ms;
        r.max_ms = cfg.fire.duration_ms;
        r.extended_ms = cfg.fire.extended_ms;
        r.return_state = fire_expiry;
        r.gui_settable = false;  // a burn length comes from config, reviewed and in git. Always.
        r.gate_actuator = cfg.fire.gate_actuator;
        if (!r.gate_actuator.empty()) {
            const double din =
                actuator_commander_.delayForRole(StateMachine::name(fire_state), r.gate_actuator);
            const double dout =
                actuator_commander_.delayForRole(StateMachine::name(fire_expiry), r.gate_actuator);
            r.gate_open_delay_ms = static_cast<uint32_t>(din * 1000.0 + 0.5);
            r.gate_close_delay_ms = static_cast<uint32_t>(dout * 1000.0 + 0.5);
            std::cout << "[SequencerService] Fire gate: \"" << r.gate_actuator << "\" opens +"
                      << r.gate_open_delay_ms << " ms, closes +" << r.gate_close_delay_ms
                      << " ms; burn window = " << r.default_ms << " ms of THAT valve being open"
                      << std::endl;
        } else {
            // Catch the trap rather than let it burn short: a staggered fire column with the window
            // measured from the transition burns for (duration - stagger), and equal values do not
            // burn at all.
            for (const auto& [role, pos] :
                 actuator_commander_.positionsForState(StateMachine::name(fire_state))) {
                if (pos != 1)
                    continue;
                const double d =
                    actuator_commander_.delayForRole(StateMachine::name(fire_state), role);
                if (d > 0.0)
                    std::cerr << "[SequencerService] WARNING: fire opens \"" << role << "\" " << d
                              << " s after entry, but no [fire].gate_actuator is set — the "
                                 "burn window is measured from the TRANSITION, so that valve is "
                                 "open for "
                              << (static_cast<double>(r.default_ms) / 1000.0 - d) << " s, not "
                              << (static_cast<double>(r.default_ms) / 1000.0) << " s." << std::endl;
            }
        }
        rules[fire_state] = r;
    }

    // ── [flow]: the characterization hold ────────────────────────────────────────────────────
    // WHICH state this is comes from the is_flow flag on a [[states]] entry, never from a name in
    // [flow]. That is the one thing [fire] gets wrong: `[fire] state = "Fire"` is resolved by
    // string, so renaming the state orphans it. Here the operator can rename it, delete it, or
    // move the flag to a different state and everything follows.
    State flow_state = State::UNKNOWN;
    for (const auto& sd : cfg.states) {
        if (!sd.is_flow || sd.id < 0 || sd.id > 255 || sd.name.empty())
            continue;
        const State s = static_cast<State>(static_cast<uint8_t>(sd.id));
        if (flow_state == State::UNKNOWN) {
            flow_state = s;  // first wins, as with is_boot in loadStatesFromConfig
        } else {
            std::cerr << "[SequencerService] More than one state carries is_flow — ignoring \""
                      << sd.name << "\", using \"" << StateMachine::name(flow_state) << "\""
                      << std::endl;
        }
    }

    if (flow_state != State::UNKNOWN) {
        // Every rejection below leaves the state NOT holdable, which makes the transition refuse
        // up front so the valve never opens. That is deliberate and is stricter than the fire path
        // above, which only warns: this hold exists solely to close a valve on a timer, so a hold
        // that cannot close its valve has no safe degraded mode.
        const std::string& rt = cfg.flow.return_target;
        const State ret = rt.empty() ? State::UNKNOWN : StateMachine::fromName(rt);

        if (flow_state == fire_state) {
            std::cerr << "[SequencerService] ERROR: is_flow is set on the fire state — REFUSED. "
                         "A burn window must not become client-settable."
                      << std::endl;
        } else if (cfg.flow.duration_ms == 0) {
            std::cerr << "[SequencerService] ERROR: \"" << StateMachine::name(flow_state)
                      << "\" is marked is_flow but [flow].duration_ms is unset — NOT holdable."
                      << std::endl;
        } else if (ret == flow_state) {
            // The diagonal is 1 in most transition matrices, so this is reachable by a plausible
            // config edit — and it would be a hold that expires into itself, re-arming forever with
            // the valve held open. There is no "close" in that loop at all.
            std::cerr
                << "[SequencerService] ERROR: [flow].return_target is the flow state itself — "
                   "the hold would re-arm forever with its valves open. NOT holdable."
                << std::endl;
        } else if (ret == State::UNKNOWN) {
            std::cerr << "[SequencerService] ERROR: [flow].return_target \"" << rt
                      << "\" is not a known state — \"" << StateMachine::name(flow_state)
                      << "\" is NOT holdable. Its valves cannot be stranded open because the "
                         "transition into it is now refused."
                      << std::endl;
        } else if (!state_machine_.isAllowed(flow_state, ret)) {
            std::cerr << "[SequencerService] ERROR: " << StateMachine::name(flow_state) << " → "
                      << StateMachine::name(ret)
                      << " is not an allowed transition — the hold would expire into a refused "
                         "transition and leave its valves open. NOT holdable."
                      << std::endl;
        } else {
            HoldRule r;
            r.default_ms = cfg.flow.duration_ms;
            r.max_ms = cfg.flow.max_ms ? cfg.flow.max_ms : cfg.flow.duration_ms;
            r.extended_ms = 0;  // a measured pulse is a fixed window; extend() must not stretch it
            r.return_state = ret;
            r.gui_settable = true;
            r.gate_actuator = cfg.flow.gate_actuator;
            if (!r.gate_actuator.empty()) {
                // The delay this valve already waits, from the delays CSV. Read rather than
                // configured twice: the stagger is declared in one place and the hold follows it,
                // so editing the CSV cannot silently desynchronise the window from the valve.
                const double din = actuator_commander_.delayForRole(StateMachine::name(flow_state),
                                                                    r.gate_actuator);
                const double dout =
                    actuator_commander_.delayForRole(StateMachine::name(ret), r.gate_actuator);
                r.gate_open_delay_ms = static_cast<uint32_t>(din * 1000.0 + 0.5);
                r.gate_close_delay_ms = static_cast<uint32_t>(dout * 1000.0 + 0.5);
            }
            rules[flow_state] = r;
            std::cout << "[SequencerService] Flow hold: " << StateMachine::name(flow_state) << " "
                      << r.default_ms << " ms (max " << r.max_ms << ") → "
                      << StateMachine::name(ret) << std::endl;
            if (!r.gate_actuator.empty()) {
                std::cout << "[SequencerService] Flow gate: \"" << r.gate_actuator << "\" opens +"
                          << r.gate_open_delay_ms << " ms after entry, closes +"
                          << r.gate_close_delay_ms << " ms after expiry; hold = requested + "
                          << r.gate_open_delay_ms << " - " << r.gate_close_delay_ms
                          << " ms, so the requested duration is how long IT is open" << std::endl;
                if (r.gate_close_delay_ms >= r.gate_open_delay_ms + r.default_ms)
                    std::cerr << "[SequencerService] WARNING: the gate closes later than the hold "
                                 "would end — the window cannot be honoured and will be clamped."
                              << std::endl;
            }

            // A warning, not a refusal: the transition is legal, so the machine does leave the
            // hold. What this catches is a return column that leaves one of the held valves
            // energised — the hold closes its valves only because the return state's CSV says
            // CLOSE, and nothing else is going to.
            const auto opens =
                actuator_commander_.positionsForState(StateMachine::name(flow_state));
            const auto closes = actuator_commander_.positionsForState(StateMachine::name(ret));
            for (const auto& [role, pos] : opens) {
                if (pos != 1)
                    continue;
                const auto it = closes.find(role);
                if (it == closes.end() || it->second != 0)
                    std::cerr << "[SequencerService] WARNING: " << StateMachine::name(flow_state)
                              << " opens \"" << role << "\" but " << StateMachine::name(ret)
                              << " does not close it — the hold will end with that valve still open"
                              << std::endl;
            }
        }
    }

    // ── Dynamic states: scripts ───────────────────────────────────────────────────────────────
    //
    // Resolved last, because every refusal branch needs something the steps above established:
    // [[states]] adopted (so a name resolves), the transitions CSV loaded (so a transition_to
    // target can be checked), the actuator CSV loaded (so a state's column can be confirmed), and
    // [fire] resolved (so a script cannot be attached to the burn).
    //
    // A refused state goes into refused_states_ and doTransitionTo rejects it up front, in the
    // same validation block that rejects a disallowed transition — before the abort broadcast,
    // before overrides are cleared, before a single valve is commanded. That is the whole point:
    // a script that does not hold up produces an unavailable button, never an open valve.
    {
        ScriptLoadContext sctx;
        sctx.config_dir = configDir();
        sctx.state_machine = &state_machine_;
        sctx.fire_state = fire_state;
        sctx.has_actuator_column = [this](const std::string& name) {
            return !actuator_commander_.positionsForState(name).empty();
        };
        ScriptLoadResult loaded = load_dynamic_states(cfg, config_content_, sctx);

        for (const auto& [st, why] : loaded.refused)
            std::cerr << "[SequencerService] ERROR: dynamic state REFUSED — " << why
                      << ". It is not enterable." << std::endl;

        for (auto& [st, ds] : loaded.dynamic) {
            // The timeout reuses HoldTimer through hold_rules_ rather than a second timer object.
            // Three properties fall out free: gui_settable=false refuses a client-supplied
            // duration on this state, extended_ms=0 means EXTEND_FIRE cannot stretch it, and
            // re-entering the state restarts the window rather than stacking a second one,
            // because HoldTimer::start() stops first.
            HoldRule r;
            r.default_ms = ds.timeout_ms;
            r.max_ms = ds.timeout_ms;
            r.extended_ms = 0;
            r.return_state = ds.timeout_target;
            r.gui_settable = false;
            rules[st] = r;

            std::cout << "[SequencerService] Dynamic state: " << ds.name << " — "
                      << ds.program.stmts.size() << " statement(s), timeout " << ds.timeout_ms
                      << " ms -> " << StateMachine::name(ds.timeout_target) << ", ends -> "
                      << StateMachine::name(ds.return_target);
            if (!ds.pressure_roles.empty()) {
                std::cout << ", reads";
                for (const auto& role : ds.pressure_roles)
                    std::cout << " \"" << role << "\"";
            }
            std::cout << std::endl;
        }

        // Subscribe to exactly the roles the loaded scripts read, and nothing else. Elodin has no
        // wildcard, and deriving the list from the ASTs is what makes it structurally impossible
        // to subscribe to the wrong table for a role — there is no id range to filter, the way
        // ControllerService filters board 2 out of existence.
        std::set<std::string> roles;
        for (const auto& [st, ds] : loaded.dynamic)
            roles.insert(ds.pressure_roles.begin(), ds.pressure_roles.end());
        if (!roles.empty()) {
            pressure_feed_.start(cfg, {roles.begin(), roles.end()}, elodin_host_,
                                 cfg.database.port);
        }

        std::lock_guard<std::mutex> lk(config_mutex_);
        dynamic_states_ = std::move(loaded.dynamic);
        refused_states_ = std::move(loaded.refused);
    }

    {
        std::lock_guard<std::mutex> lk(config_mutex_);
        hold_rules_ = std::move(rules);
    }

    // Controller service endpoint for FIRE_START / FIRE_STOP.
    // Read from config; defaults to 127.0.0.1:8000
    controller_host_ = cfg.controller_service.host;
    controller_port_ = cfg.controller_service.port;
    sequencer_owns_valves_ = cfg.controller_service.sequencer_owns_valves;
    std::cout << "[SequencerService] Fire valve ownership: "
              << (sequencer_owns_valves_
                      ? "sequencer (controller_service is never told a burn started)"
                      : "controller_service (FIRE_START / FIRE_STOP sent)")
              << std::endl;
    return true;
}

}  // namespace sequencer
