#include "control/SequencerService.hpp"

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
#include "elodin/DatabaseConfig.hpp"
#include "net/DaqInterface.hpp"

namespace sequencer {

// ─────────────────────────────────────────────────────────────────────────────
// Elodin VTable IDs
//   [0x50, 0x00] = 0x5000 — SequencerState (new: state + allowed transitions + debug_mode)
//   [0x43, 0x00] = 0x4300 — StateTransition (legacy: matches Node.js backend publication)
// ─────────────────────────────────────────────────────────────────────────────
static constexpr uint16_t VTABLE_SEQUENCER_STATE = 0x5000;
static constexpr uint16_t VTABLE_STATE_TRANSITION = 0x4300;

// How long notifyControllerFire() waits for the controller_service TCP connection before giving
// up. Deliberately short: this is on the state-transition path, and a missed FIRE_START/FIRE_STOP
// is recoverable (the controller also watches the sequencer state packet) while a stalled
// transition is not.
static constexpr int kControllerConnectTimeoutMs = 300;

// SequencerState: u64 @0 | u8 @8 | pad[3] @9 (align u32) | allowed_bitmask u32 @12 | debug_mode u8
// @16 — 17 bytes
using SequencerStateMsg =
    comms::CommsMessage<uint64_t, uint8_t, std::array<uint8_t, 3>, uint32_t, uint8_t>;

// StateTransition message: timestamp_ns(u64) | from_state(u8) | to_state(u8) | reason(u8)
using StateTransitionMsg = comms::CommsMessage<uint64_t, uint8_t, uint8_t, uint8_t>;

static uint64_t now_ns() {
    using namespace std::chrono;
    return static_cast<uint64_t>(
        duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count());
}

// ─────────────────────────────────────────────────────────────────────────────
SequencerService::~SequencerService() {
    // Drain order matters. Stop accepting work first, then let the worker finish what it holds,
    // and only then tear down the things a command body touches — otherwise the worker can be
    // mid-transition while fire_manager_ is being destroyed under it.
    {
        std::lock_guard<std::mutex> lk(cmd_mutex_);
        cmd_stop_ = true;
    }
    cmd_cv_.notify_all();
    if (cmd_thread_.joinable())
        cmd_thread_.join();

    stopElodinRetry();
    actuator_commander_.stopContinuousLoop();
    hold_timer_.stop();
}

// ─────────────────────────────────────────────────────────────────────────────
// Command queue
// ─────────────────────────────────────────────────────────────────────────────
void SequencerService::commandLoop() {
    for (;;) {
        Command cmd;
        {
            std::unique_lock<std::mutex> lk(cmd_mutex_);
            cmd_cv_.wait(lk, [this] {
                return cmd_stop_ || !cmd_queue_.empty();
            });
            // Shutdown wins over draining: a queue full of transitions is not worth running while
            // the process is going down, and the caller of each is already gone or giving up.
            if (cmd_stop_ && cmd_queue_.empty())
                return;
            if (cmd_queue_.empty())
                continue;
            cmd = std::move(cmd_queue_.front());
            cmd_queue_.pop_front();
        }

        bool ok = false;
        try {
            ok = cmd.fn();
        } catch (const std::exception& e) {
            std::cerr << "[SequencerService] command threw: " << e.what() << std::endl;
        } catch (...) {
            std::cerr << "[SequencerService] command threw an unknown exception" << std::endl;
        }
        // The promise must be fulfilled on every path including a throw, or a caller waiting on
        // the future blocks for the full timeout on what was an immediate failure.
        if (cmd.result)
            cmd.result->set_value(ok);
    }
}

bool SequencerService::enqueueAndWait(std::function<bool()> fn) {
    auto result = std::make_shared<std::promise<bool>>();
    auto future = result->get_future();
    {
        std::lock_guard<std::mutex> lk(cmd_mutex_);
        if (cmd_stop_)
            return false;
        cmd_queue_.push_back(Command{std::move(fn), result});
    }
    cmd_cv_.notify_one();

    if (future.wait_for(std::chrono::seconds(kCommandTimeoutSeconds)) !=
        std::future_status::ready) {
        std::cerr << "[SequencerService] command timed out after " << kCommandTimeoutSeconds
                  << "s waiting for the worker — reporting failure (it may still run)" << std::endl;
        return false;
    }
    return future.get();
}

void SequencerService::enqueueDetached(std::function<bool()> fn) {
    {
        std::lock_guard<std::mutex> lk(cmd_mutex_);
        if (cmd_stop_)
            return;
        cmd_queue_.push_back(Command{std::move(fn), nullptr});
    }
    cmd_cv_.notify_one();
}

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

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::init(const std::string& config_path) {
    loadConfig(config_path);
    const fsw::config::Config cfg = fsw::config::load_from_string(config_content_);

    if (!applyConfig(cfg))
        return false;

    // Snapshot the actuator board list now, while we are reading config for the first and only
    // time. tryConnectElodin() re-registers VTables on every reconnect and must not go back to
    // disk for this (see the comment there).
    {
        const auto boards_map = fsw::config::load_active_boards(config_path_);
        const auto it_act = boards_map.find(fsw::config::ActiveBoardKind::ACTUATOR);
        actuator_boards_ = (it_act != boards_map.end()) ? it_act->second
                                                        : std::vector<fsw::elodin::BoardChannels>{};
    }

    // Elodin — connection is best-effort; service runs without it
    elodin_host_ = "127.0.0.1";
    elodin_port_ = cfg.database.port;
    if (!tryConnectElodin()) {
        std::cerr << "[SequencerService] Cannot connect to Elodin yet — retrying every "
                  << kElodinRetrySeconds << "s in the background" << std::endl;
    }
    // The connect above used to be one-shot. Losing the startup race with elodin-db (systemd
    // starts the units together) meant the ACT_CMD VTables were never registered and
    // publishCommandedState() early-returned forever, so every valve read "undefined" in the GUI
    // while UDP commands still went out — data flowing, dots grey. Retry until it takes.
    startElodinRetry();

    current_state_ = StateMachine::bootState();
    // Publish initial state so any already-connected backend/GUI knows we started at IDLE.
    publishState();
    // Command IDLE actuators and keep resending so manual debug clicks cannot stick vs CSV.
    // is_transition=true because this IS the entry into the boot state; the loop that follows is
    // only the republisher. See the note in transitionTo — the two must not both claim the entry.
    actuator_commander_.applyForState(current_state_.load(), /*is_transition=*/true);
    actuator_commander_.startContinuousLoop(current_state_.load(), /*allow_delays=*/false);

    // Start the command worker last. Everything above runs on the caller's thread before any
    // command can be accepted, so init() needs no serialization of its own — and starting the
    // worker earlier would let a command run against a half-initialized service.
    cmd_stop_ = false;
    cmd_thread_ = std::thread([this]() {
        commandLoop();
    });

    std::cout << "[SequencerService] Initialized. Current state: "
              << StateMachine::name(current_state_.load()) << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::isAbortState(State s) {
    // Config-declared (`is_abort`), falling back to the built-in trio when a config omits them.
    // This used to be a hardcoded three-way enum comparison, which meant a stand that renamed or
    // added an abort state got no physical abort broadcast for it.
    return StateMachine::isAbort(s);
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::transitionTo(const std::string& state_name) {
    return transitionTo(state_name, 0);
}

bool SequencerService::transitionTo(const std::string& state_name, uint32_t requested_hold_ms,
                                    std::string* refusal_reason) {
    // Resolve on the worker, not here. fromName() reads the config-declared state table, which
    // the worker owns — resolving on the caller's thread would read it from an arbitrary thread.
    // enqueueAndWait blocks until the lambda has run, so refusal_reason stays alive throughout.
    return enqueueAndWait([this, state_name, requested_hold_ms, refusal_reason]() {
        State to = StateMachine::fromName(state_name);
        if (to == State::UNKNOWN) {
            std::cerr << "[SequencerService] Unknown state: " << state_name << std::endl;
            if (refusal_reason)
                *refusal_reason = "unknown state";
            return false;
        }
        return doTransitionTo(to, requested_hold_ms, refusal_reason);
    });
}

bool SequencerService::transitionTo(State to) {
    return transitionTo(to, 0);
}

bool SequencerService::transitionTo(State to, uint32_t requested_hold_ms,
                                    std::string* refusal_reason) {
    return enqueueAndWait([this, to, requested_hold_ms, refusal_reason]() {
        return doTransitionTo(to, requested_hold_ms, refusal_reason);
    });
}

bool SequencerService::doTransitionTo(State to, uint32_t requested_hold_ms,
                                      std::string* refusal_reason) {
    State from = current_state_.load();

    HoldRule rule;
    bool has_rule = false;
    {
        std::lock_guard<std::mutex> lk(config_mutex_);
        const auto it = hold_rules_.find(to);
        if (it != hold_rules_.end()) {
            rule = it->second;
            has_rule = true;
        }
    }

    // Validate a client-supplied hold BEFORE anything moves — before the overrides are cleared,
    // before the resend loop stops, before a single actuator is commanded. A refusal has to leave
    // the rig exactly where it was: the WebSocket client queues commands while its socket is down
    // and replays them on reconnect, so a stale "burn for 60 s" must be a no-op, not a transition
    // that then runs for some other length.
    if (requested_hold_ms != 0) {
        const char* why = nullptr;
        if (!has_rule)
            why = "state is not holdable";
        else if (!rule.gui_settable)
            why = "duration not permitted for this state";
        else if (requested_hold_ms > rule.max_ms)
            why = "duration exceeds max";

        if (why) {
            std::cerr << "[SequencerService] Refused " << requested_hold_ms << " ms hold on "
                      << StateMachine::name(to) << ": " << why << std::endl;
            if (refusal_reason) {
                *refusal_reason = why;
                if (std::string(why) == "duration exceeds max")
                    *refusal_reason += " (" + std::to_string(rule.max_ms) + " ms)";
            }
            // Republish so a client that moved its own display in anticipation is corrected —
            // the same courtesy the ordinary refusal path below extends.
            publishState();
            return false;
        }
    }

    if (!debug_mode_) {
        if (!state_machine_.isAllowed(from, to)) {
            if (refusal_reason)
                *refusal_reason = "transition rejected";
            std::cerr << "[SequencerService] Transition " << StateMachine::name(from) << " → "
                      << StateMachine::name(to) << " is not allowed" << std::endl;
            // Republish the state we are actually in. A refusal used to publish nothing, so a
            // client that had moved its own display in anticipation was never corrected and went
            // on showing a state the rig had refused to enter — the failure was invisible, which
            // is worse than the failure. Publishing on the way out also resyncs any client that
            // drifted for some other reason.
            publishState();
            return false;
        }
    }

    // Physical abort broadcast FIRST — before any of the bookkeeping below.
    //
    // This used to sit after stopContinuousLoop(), fire_manager_.stop() and applyForState(), which
    // meant the boards' abort packet queued behind: a join of the republish thread (up to 100 ms),
    // a TCP round-trip to controller_service (previously unbounded — see notifyControllerFire),
    // and a full actuator batch. Every one of those is the sequencer's own housekeeping, and none
    // of it is a precondition for telling the boards to abort. The boards' independent abort logic
    // is the last line of defence on this rig; it must not wait on the process that is, by
    // definition, in the middle of something going wrong.
    //
    // triggerAbort() sends immediately and schedules ABORT_DONE on its own thread, so this does
    // not block the transition either.
    const bool entering_abort = isAbortState(to);
    if (entering_abort)
        abort_broadcaster_.triggerAbort();

    // New state wins over debug manual actuator overrides.
    actuator_commander_.clearAllManualOverrides();

    // Stop current continuous loop before applying the new state
    actuator_commander_.stopContinuousLoop();

    // A hold belongs to the state it was armed in, so any move ends it. Unconditional because
    // stop() is a no-op when nothing is running, and because start() below stops first anyway —
    // which is what makes re-entering a held state restart its window rather than stack a second.
    hold_timer_.stop();

    // Apply actuator commands for new state.
    //
    // is_transition=true is what makes this run the delays CSV as a staged schedule instead of
    // dumping every actuator at t=0. It used to be omitted, and the parameter defaults to false —
    // "this is the 1 Hz republish, send settled positions". So this call shipped the whole state
    // at once, and the staged schedule that startContinuousLoop kicked off below then re-commanded
    // valves that were already in position. Every configured delay was inert: parsed, logged as
    // "Sent 1 commands (+1s)", and completely without effect on any state on any profile, the
    // 80 ms fuel lead in default/server's Fire column included. The default argument is why it was
    // invisible — omitting it compiled clean and read exactly like the pre-delay call it once was.
    actuator_commander_.applyForState(to, /*is_transition=*/!isAbortState(to));

    // Arm the hold HERE, immediately after the valves are commanded, rather than at the end of the
    // transition: the window the operator asked for is the one between the open and the close, and
    // everything below (the resend thread spawn, the Elodin publishes) would otherwise be counted
    // inside it.
    if (has_rule && rule.return_state != State::UNKNOWN) {
        // The requested duration is what the GATE valve should be open for, so the state is held
        // for the gate's stagger plus that. Without this, a 1 s request on a state whose main opens
        // 1 s late would close everything exactly as the main opened — zero flow.
        const uint32_t requested = requested_hold_ms != 0 ? requested_hold_ms : rule.default_ms;
        // Both staggers. The entry delay pushes the valve's opening later, so the state must be
        // held longer; the return state's delay keeps it open past the expiry transition, so the
        // state must be held that much less. Net: hold = requested + open - close.
        const int64_t want = static_cast<int64_t>(requested) +
                             static_cast<int64_t>(rule.gate_open_delay_ms) -
                             static_cast<int64_t>(rule.gate_close_delay_ms);
        // Clamp rather than wrap: unsigned underflow here would become a ~49-day hold, valves open.
        const uint32_t hold_ms = want > 0 ? static_cast<uint32_t>(want) : 1;
        if (want <= 0)
            std::cerr << "[SequencerService] Gate close delay (" << rule.gate_close_delay_ms
                      << " ms) swallows the requested " << requested
                      << " ms window — holding 1 ms. Fix the delays CSV." << std::endl;
        const State return_state = rule.return_state;
        // The controller is told a burn started only when it owns the valves. When the sequencer
        // owns them there is no notifier at all rather than a suppressed one — nothing to forget
        // to check — and a flow hold never has one regardless.
        const bool notify_controller = (to == fire_state_) && !sequencer_owns_valves_;
        hold_timer_.start(HoldSpec{hold_ms, rule.extended_ms,
                                   [this, return_state]() {
                                       // Timer thread. Resolve to a State rather than a name: the
                                       // old code round-tripped through
                                       // StateMachine::name(State::ARMED) → fromName(), so renaming
                                       // the state made fromName() return UNKNOWN and the
                                       // transition was refused — stranding the system in fire with
                                       // the timer already stopped.
                                       //
                                       // Detached, never enqueueAndWait: this runs on the hold
                                       // timer's own thread, and the worker handling the expiry
                                       // transition calls hold_timer_.stop(), which joins this very
                                       // thread. Waiting here would be a guaranteed deadlock — the
                                       // worker waiting on the join, this thread waiting on the
                                       // worker — and it would strand the rig in the held state
                                       // with the gate valve open.
                                       enqueueDetached([this, return_state]() {
                                           return doTransitionTo(return_state);
                                       });
                                   },
                                   notify_controller
                                       ? std::function<void(bool)>([this](bool active) {
                                             notifyControllerFire(active);
                                         })
                                       : nullptr,
                                   StateMachine::name(to)});
    }

    // Start continuous re-send loop for new state.
    // allow_delays=false: the entry above already ran the schedule, so this loop is purely the
    // 1 Hz republish. Letting it claim the entry as well would bump the schedule generation and
    // cancel the stages the line above just armed. It still skips a role whose delay is pending,
    // so the board holds its pre-transition position until that role's stage fires.
    // (Abort states got their immediate apply above via isAbortState; an abort must not sit behind
    // a timer. The physical UDP abort broadcast already went out at the top of this function.)
    actuator_commander_.startContinuousLoop(to, /*allow_delays=*/false);

    // Update current state
    current_state_ = to;

    // Abort lifecycle. The burn/flow lifecycle is not here: both are hold rules now, armed by the
    // hold_timer_.start() above, so the fire window no longer needs a branch of its own.
    if (isAbortState(to)) {
        abort_broadcaster_.triggerAbort();
    }

    // Elodin publishing
    publishStateTransition(from, to);
    publishState();

    std::cout << "[SequencerService] " << StateMachine::name(from) << " → "
              << StateMachine::name(to) << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::setDebugMode(bool enabled) {
    return enqueueAndWait([this, enabled]() {
        return doSetDebugMode(enabled);
    });
}

bool SequencerService::doSetDebugMode(bool enabled) {
    debug_mode_ = enabled;
    if (!enabled)
        actuator_commander_.clearAllManualOverrides();
    std::cout << "[SequencerService] Debug mode: " << (enabled ? "ON" : "OFF") << std::endl;
    publishState();  // push updated debug_mode flag to GUI
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::manualActuator(const std::string& name, int pos) {
    return enqueueAndWait([this, name, pos]() {
        return doManualActuator(name, pos);
    });
}

bool SequencerService::doManualActuator(const std::string& name, int pos) {
    if (!debug_mode_) {
        std::cerr << "[SequencerService] Manual actuator commands require debug mode" << std::endl;
        return false;
    }
    actuator_commander_.setManualOverride(name, pos);
    return actuator_commander_.sendSingleActuator(name, pos);
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::extendFire() {
    return enqueueAndWait([this]() {
        return doExtendFire();
    });
}

bool SequencerService::doExtendFire() {
    if (current_state_ != fire_state_) {
        std::cerr << "[SequencerService] EXTEND_FIRE ignored: not in FIRE state" << std::endl;
        return false;
    }
    return hold_timer_.extend();
}

// ─────────────────────────────────────────────────────────────────────────────
// Elodin publishing
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Tell controller_service the burn gate changed. One TCP connection per message, 1 s send timeout.
 *
 * This lives here rather than in the hold timer so exactly one component talks to the
 * controller — previously the timer opened its own socket AND the backend independently saw the
 * FIRE edge and sent the same messages, so a safety-critical gate had two writers in two processes.
 */
void SequencerService::notifyControllerFire(bool active) {
    if (notifyControllerFireOnce(active))
        return;
    // One retry, driven by evidence rather than blind repetition: we know the first attempt was
    // not acted on, because the controller did not answer. Repeating a command that *was* acted
    // on is harmless here — both commands are idempotent level settings, not edges.
    std::cerr << "[SequencerService] retrying " << (active ? "FIRE_START" : "FIRE_STOP")
              << " to controller_service" << std::endl;
    if (notifyControllerFireOnce(active))
        return;
    std::cerr << "[SequencerService] ❌ controller_service did not acknowledge "
              << (active ? "FIRE_START" : "FIRE_STOP") << " at " << controller_host_ << ":"
              << controller_port_
              << " after 2 attempts — the PWM gate is NOT under sequencer control. The controller "
                 "falls back to the Elodin sequencer-state parity path; verify the burn ended."
              << std::endl;
}

bool SequencerService::notifyControllerFireOnce(bool active) {
    const std::string msg = active ? "FIRE_START\n" : "FIRE_STOP\n";
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0)
        return false;
    struct timeval tv{.tv_sec = 1, .tv_usec = 0};
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(controller_port_);
    if (inet_pton(AF_INET, controller_host_.c_str(), &dest.sin_addr) != 1) {
        close(sock);
        return false;
    }

    // SO_SNDTIMEO above does NOT bound connection establishment. On a blocking socket, connect()
    // to a host that drops SYNs rather than refusing them (powered off but still routable, or a
    // network partition) sits in the kernel's SYN retry budget for ~2 minutes. This runs on
    // whichever thread is performing the state transition — including an operator aborting out of
    // FIRE — so an unreachable controller used to stall the abort itself. Bound it explicitly:
    // non-blocking connect, wait with a deadline, then restore blocking mode for the send.
    const int flags = fcntl(sock, F_GETFL, 0);
    if (flags < 0 || fcntl(sock, F_SETFL, flags | O_NONBLOCK) < 0) {
        close(sock);
        return false;
    }

    bool connected = false;
    if (connect(sock, reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest)) == 0) {
        connected = true;  // immediate (loopback)
    } else if (errno == EINPROGRESS) {
        struct pollfd pfd{.fd = sock, .events = POLLOUT, .revents = 0};
        // Any readiness at all means the attempt resolved — consult SO_ERROR rather than the
        // revents bits. A refused connection can surface as POLLERR/POLLHUP without POLLOUT, and
        // testing for POLLOUT alone would report that as a timeout and lose the real reason in
        // the log. poll() returning 0 is the only genuine timeout.
        if (poll(&pfd, 1, kControllerConnectTimeoutMs) > 0) {
            int err = 0;
            socklen_t len = sizeof(err);
            if (getsockopt(sock, SOL_SOCKET, SO_ERROR, &err, &len) != 0)
                err = errno;
            if (err == 0)
                connected = true;
            else
                errno = err;
        } else {
            errno = ETIMEDOUT;
        }
    }

    bool acked = false;
    if (connected && fcntl(sock, F_SETFL, flags) == 0) {
        ssize_t n = send(sock, msg.c_str(), msg.size(), 0);
        if (n != static_cast<ssize_t>(msg.size())) {
            std::cerr << "[SequencerService] short send to controller_service (" << n << "/"
                      << msg.size() << "): " << strerror(errno) << std::endl;
        } else {
            // Read the ACK. A successful send() proves nothing: the kernel completes the
            // handshake and buffers the bytes whether or not the controller's accept loop is
            // alive to read them, so a wedged controller used to look identical to a healthy one
            // from here — this function logged the command as delivered either way. The
            // controller answers "OK\n" (controller_main.cpp), and that reply is the only
            // evidence the command actually reached the application.
            struct timeval rtv{.tv_sec = 0, .tv_usec = kControllerConnectTimeoutMs * 1000};
            setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &rtv, sizeof(rtv));
            char reply[16] = {0};
            ssize_t r = recv(sock, reply, sizeof(reply) - 1, 0);
            if (r > 0 && std::string(reply, static_cast<size_t>(r)).rfind("OK", 0) == 0) {
                acked = true;
            } else if (r > 0) {
                std::cerr << "[SequencerService] controller_service refused "
                          << (active ? "FIRE_START" : "FIRE_STOP") << ": "
                          << std::string(reply, static_cast<size_t>(r)) << std::endl;
            } else {
                std::cerr << "[SequencerService] no ACK from controller_service for "
                          << (active ? "FIRE_START" : "FIRE_STOP") << " ("
                          << (r == 0 ? "connection closed" : strerror(errno))
                          << ") — the command may not have been acted on" << std::endl;
            }
        }
    } else {
        std::cerr << "[SequencerService] could not reach controller_service at " << controller_host_
                  << ":" << controller_port_ << " for " << (active ? "FIRE_START" : "FIRE_STOP")
                  << " (" << strerror(errno) << ")" << std::endl;
    }
    close(sock);

    if (acked)
        std::cout << "[SequencerService] → controller: " << (active ? "FIRE_START" : "FIRE_STOP")
                  << " (acked)" << std::endl;
    return acked;
}

void SequencerService::publishState() {
    if (!elodin_.is_connected())
        return;

    const State s = current_state_.load();
    const uint32_t mask = state_machine_.allowedBitmask(s);
    const uint8_t dbg = debug_mode_ ? 1u : 0u;

    SequencerStateMsg msg(now_ns(), static_cast<uint8_t>(s), std::array<uint8_t, 3>{0, 0, 0}, mask,
                          dbg);
    if (!elodin_.publish(VTABLE_SEQUENCER_STATE, msg))
        std::cerr << "[SequencerService] Failed to publish sequencer state to Elodin" << std::endl;
}

void SequencerService::publishStateTransition(State from, State to) {
    if (!elodin_.is_connected())
        return;

    StateTransitionMsg msg(now_ns(), static_cast<uint8_t>(from), static_cast<uint8_t>(to), 0);
    elodin_.publish(VTABLE_STATE_TRANSITION, msg);
}

bool SequencerService::tryConnectElodin() {
    if (!elodin_.connect(elodin_host_, elodin_port_))
        return false;
    std::cout << "[SequencerService] Connected to Elodin at " << elodin_host_ << ":" << elodin_port_
              << std::endl;
    // Every one of these must run on a RECONNECT too, not just the first connect — the VTables
    // live in the db process, so a db restart loses them.
    //
    // The board list comes from the snapshot taken at init(), NOT from a fresh read of
    // config_path_. This used to re-parse config.toml on every reconnect, and the retry thread
    // reconnects on any db restart — so a db blip mid-run would rebuild the actuator tables from
    // whatever happened to be on disk at that moment. Config is applied once, at session start;
    // a process that has already booted keeps the config it booted with.
    fsw::elodin::DatabaseConfig::register_non_sensor_tables(elodin_, actuator_boards_);
    actuator_commander_.setElodinClient(&elodin_);
    actuator_commander_.publishInitialState();
    return true;
}

void SequencerService::startElodinRetry() {
    if (elodin_retry_thread_.joinable())
        return;
    elodin_retry_stop_ = false;
    elodin_retry_thread_ = std::thread([this]() {
        while (!elodin_retry_stop_) {
            for (int i = 0; i < kElodinRetrySeconds * 10 && !elodin_retry_stop_; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (elodin_retry_stop_ || elodin_.is_connected())
                continue;
            tryConnectElodin();
        }
    });
}

void SequencerService::stopElodinRetry() {
    elodin_retry_stop_ = true;
    if (elodin_retry_thread_.joinable())
        elodin_retry_thread_.join();
}

}  // namespace sequencer
