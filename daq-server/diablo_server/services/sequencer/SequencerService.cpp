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
    fire_manager_.stop();
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
/**
 * Resolve everything under [fire] against the currently-adopted state table.
 *
 * Called from init(). Extracted from it when reload still existed, and kept separate because it
 * documents one rule in one place: [fire] is resolved against the state table adopted from the
 * same config, never against the compiled enum.
 *
 * Must run after StateMachine::loadStatesFromConfig() and after state_machine_.load(), since it
 * resolves names through the former and sanity-checks the transition table from the latter.
 */
void SequencerService::applyFireConfig(const fsw::config::Config& cfg) {
    // Reset before resolving: on a reload an entry that has since been removed from config must
    // disable the burn, not leave the previous run's id in place.
    fire_state_ = State::UNKNOWN;
    fire_expiry_state_ = State::UNKNOWN;

    const std::string fs = cfg.fire.state;
    if (fs.empty()) {
        // No fire state configured → the fire timer never arms (nothing to auto-transition out
        // of). UNKNOWN never equals a real state in transitionTo's `to == fire_state_` check.
        fire_state_ = State::UNKNOWN;
    } else {
        State s = StateMachine::fromName(fs);
        if (s == State::UNKNOWN)
            // Config is authoritative and does not declare this name. Disable the burn (leave
            // UNKNOWN) rather than fall back to the compiled Fire id, which names a different
            // state on a renumbered rig — a misconfig fails safe and loud, not silent-wrong.
            std::cerr << "[SequencerService] [fire] state \"" << fs
                      << "\" is not a declared state — FIRE DISABLED" << std::endl;
        else
            fire_state_ = s;
    }
    const std::string ft = cfg.fire.expiry_target;
    if (!ft.empty()) {
        State s = StateMachine::fromName(ft);
        if (s == State::UNKNOWN)
            // Same rule for the timer's landing state: an undeclared name disables auto-expiry
            // (leaves UNKNOWN → the isAllowed check below warns) instead of a compiled Armed.
            std::cerr << "[SequencerService] [fire] expiry_target \"" << ft
                      << "\" is not a declared state — fire auto-expiry disabled" << std::endl;
        else
            fire_expiry_state_ = s;
    }
    actuator_commander_.setFireState(fire_state_);
    if (fire_state_ == State::UNKNOWN) {
        std::cout << "[SequencerService] Fire state: (none) — fire timer disabled" << std::endl;
    } else {
        std::cout << "[SequencerService] Fire state: " << StateMachine::name(fire_state_)
                  << " → expires to " << StateMachine::name(fire_expiry_state_) << std::endl;
        // The expiry transition goes through the same isAllowed() gate as any other, so a
        // target the fire state cannot reach leaves the system sitting in FIRE with a dead
        // timer. Say so at startup rather than at T-0.
        if (!state_machine_.isAllowed(fire_state_, fire_expiry_state_))
            std::cerr << "[SequencerService] WARNING: " << StateMachine::name(fire_state_) << " → "
                      << StateMachine::name(fire_expiry_state_)
                      << " is not an allowed transition — the fire timer will expire into a "
                         "refused transition and the system will stay in fire."
                      << std::endl;
    }

    // FireManager durations from config.toml [fire] (see the parser for the
    // [controller_service].fire_* fallback that keeps an un-migrated config working).
    fire_manager_.configure(cfg.fire.duration_ms, cfg.fire.extended_ms);
    std::cout << "[SequencerService] Fire window: " << cfg.fire.duration_ms << " ms (extended "
              << cfg.fire.extended_ms << " ms)" << std::endl;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::init(const std::string& config_path) {
    loadConfig(config_path);
    const fsw::config::Config cfg = fsw::config::load_from_string(config_content_);

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
    if (!actuator_commander_.load(config_content_, act_csv)) {
        std::cerr << "[SequencerService] Failed to load state_machine_actuators.csv (tried: "
                  << act_csv << ")" << std::endl;
        return false;
    }

    applyFireConfig(cfg);

    // Controller service endpoint for FIRE_START / FIRE_STOP
    // Read from config; defaults to 127.0.0.1:8000
    controller_host_ = cfg.controller_service.host;
    controller_port_ = cfg.controller_service.port;
    fire_manager_.setNotifier([this](bool active) {
        notifyControllerFire(active);
    });

    // Snapshot the actuator board list now, while we are reading config for the first and only
    // time. tryConnectElodin() re-registers VTables on every reconnect and must not go back to
    // disk for this (see the comment there).
    {
        const auto boards_map = fsw::config::load_active_boards(config_path_);
        const auto it_act = boards_map.find(fsw::config::ActiveBoardKind::ACTUATOR);
        actuator_boards_ = (it_act != boards_map.end())
                               ? it_act->second
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
    actuator_commander_.applyForState(current_state_.load());
    actuator_commander_.startContinuousLoop(current_state_.load());

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
    // Resolve on the worker, not here. fromName() reads the config-declared state table, which
    // the worker owns — resolving on the caller's thread would read it from an arbitrary thread.
    return enqueueAndWait([this, state_name]() {
        State to = StateMachine::fromName(state_name);
        if (to == State::UNKNOWN) {
            std::cerr << "[SequencerService] Unknown state: " << state_name << std::endl;
            return false;
        }
        return doTransitionTo(to);
    });
}

bool SequencerService::transitionTo(State to) {
    return enqueueAndWait([this, to]() {
        return doTransitionTo(to);
    });
}

bool SequencerService::doTransitionTo(State to) {
    State from = current_state_.load();

    if (!debug_mode_) {
        if (!state_machine_.isAllowed(from, to)) {
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

    // If leaving FIRE state, stop the fire manager
    if (from == fire_state_ && to != fire_state_) {
        fire_manager_.stop();
    }

    // Apply actuator commands for new state
    actuator_commander_.applyForState(to);

    // Start continuous re-send loop for new state
    // Abort states apply immediately: their CSV delays are ignored, because an abort must not sit
    // behind a timer. (The physical UDP abort broadcast is separate and already went out at the
    // top of this function.)
    actuator_commander_.startContinuousLoop(to, !entering_abort);

    // Update current state
    current_state_ = to;

    // FIRE lifecycle — which state this is comes from [fire] state, not the enumerator.
    if (to == fire_state_) {
        fire_manager_.start([this]() {
            // Timer thread. Resolve to a State rather than a name: the old code round-tripped
            // through StateMachine::name(State::ARMED) → fromName(), so renaming the state made
            // fromName() return UNKNOWN and the transition was refused — stranding the system in
            // fire with the timer already stopped.
            //
            // Detached, never enqueueAndWait: this runs on FireManager's timer thread, and the
            // worker handling the expiry transition will call fire_manager_.stop(), which joins
            // this very thread. Waiting here would be a guaranteed deadlock — the worker waiting
            // on the join, this thread waiting on the worker.
            enqueueDetached([this]() {
                return doTransitionTo(fire_expiry_state_);
            });
        });
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
    fire_manager_.extend();
    return true;
}
// ─────────────────────────────────────────────────────────────────────────────
// Elodin publishing
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Tell controller_service the burn gate changed. One TCP connection per message, 1 s send timeout.
 *
 * This lives here rather than in FireManager so exactly one component talks to the controller —
 * previously FireManager opened its own socket AND the backend independently detected the FIRE
 * edge and sent the same messages, so a safety-critical gate had two writers in two processes.
 */
void SequencerService::notifyControllerFire(bool active) {
    const std::string msg = active ? "FIRE_START\n" : "FIRE_STOP\n";
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0)
        return;
    struct timeval tv{.tv_sec = 1, .tv_usec = 0};
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(controller_port_);
    if (inet_pton(AF_INET, controller_host_.c_str(), &dest.sin_addr) != 1) {
        close(sock);
        return;
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
        return;
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

    if (connected && fcntl(sock, F_SETFL, flags) == 0) {
        ssize_t n = send(sock, msg.c_str(), msg.size(), 0);
        (void)n;
        std::cout << "[SequencerService] → controller: " << (active ? "FIRE_START" : "FIRE_STOP")
                  << std::endl;
    } else {
        std::cerr << "[SequencerService] could not reach controller_service at " << controller_host_
                  << ":" << controller_port_ << " for " << (active ? "FIRE_START" : "FIRE_STOP")
                  << " (" << strerror(errno) << ")" << std::endl;
    }
    close(sock);
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
