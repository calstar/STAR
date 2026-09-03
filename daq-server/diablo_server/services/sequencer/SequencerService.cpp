#include "control/SequencerService.hpp"
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "comms/CommsMessage.hpp"
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
    stopElodinRetry();
    actuator_commander_.stopContinuousLoop();
    fire_manager_.stop();
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

// Read a "section.key" string value from raw config.toml content, stripping
// surrounding whitespace and quotes. Returns `fallback` if not found.
static std::string configString(const std::string& content, const std::string& section,
                                const std::string& key, const std::string& fallback) {
    const std::string header = "[" + section + "]";
    auto pos = content.find(header);
    if (pos == std::string::npos)
        return fallback;
    auto start = pos + header.size();
    auto next = content.find("\n[", start);
    const std::string sec =
        (next == std::string::npos) ? content.substr(start) : content.substr(start, next - start);
    std::istringstream iss(sec);
    std::string line;
    while (std::getline(iss, line)) {
        auto c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
        auto eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string k = line.substr(0, eq);
        k.erase(0, k.find_first_not_of(" \t"));
        k.erase(k.find_last_not_of(" \t") + 1);
        if (k != key)
            continue;
        std::string v = line.substr(eq + 1);
        v.erase(0, v.find_first_not_of(" \t\r\n\""));
        v.erase(v.find_last_not_of(" \t\r\n\"") + 1);
        return v.empty() ? fallback : v;
    }
    return fallback;
}

bool SequencerService::init(const std::string& config_path) {
    loadConfig(config_path);

    // State machine CSV — path from config.toml (canonical: daq-server/config/).
    std::string sm_csv = resolveDataPath(configString(
        config_content_, "state_machine", "transitions_csv", "config/state_transitions.csv"));
    if (!state_machine_.load(sm_csv)) {
        std::cerr
            << "[SequencerService] Failed to load state_transitions.csv (tried relative to cwd: "
            << sm_csv << ")" << std::endl;
        return false;
    }

    // Actuator commander — path from config.toml (canonical: daq-server/config/).
    std::string act_csv = resolveDataPath(configString(
        config_content_, "state_machine", "actuator_csv", "config/state_machine_actuators.csv"));
    if (!actuator_commander_.load(config_content_, act_csv)) {
        std::cerr << "[SequencerService] Failed to load state_machine_actuators.csv (tried: "
                  << act_csv << ")" << std::endl;
        return false;
    }

    // Adopt [[states]] before anything resolves a state name — the fire config below looks up
    // its state and expiry target by name, and the CSVs are parsed by name too.
    StateMachine::loadStatesFromConfig(config_content_);

    // FireManager: load durations from config
    auto getStr = [&](const std::string& sec, const std::string& key,
                      const std::string& def) -> std::string {
        const std::string& cc = config_content_;
        const std::string header = "[" + sec + "]";
        auto pos = cc.find(header);
        if (pos == std::string::npos)
            return def;
        auto start = pos + header.size();
        auto next = cc.find("\n[", start);
        const std::string section =
            (next == std::string::npos) ? cc.substr(start) : cc.substr(start, next - start);
        std::istringstream iss(section);
        std::string line;
        while (std::getline(iss, line)) {
            auto hash = line.find('#');
            if (hash != std::string::npos)
                line = line.substr(0, hash);
            auto eq = line.find('=');
            if (eq == std::string::npos)
                continue;
            std::string k = line.substr(0, eq);
            k.erase(0, k.find_first_not_of(" \t"));
            k.erase(k.find_last_not_of(" \t\r\n") + 1);
            if (k != key)
                continue;
            std::string v = line.substr(eq + 1);
            v.erase(0, v.find_first_not_of(" \t\"'"));
            auto endq = v.find_last_not_of(" \t\r\n\"'");
            if (endq != std::string::npos)
                v.erase(endq + 1);
            return v;
        }
        return def;
    };

    auto getInt = [&](const std::string& sec, const std::string& key, uint32_t def) -> uint32_t {
        const std::string& cc = config_content_;
        const std::string header = "[" + sec + "]";
        auto pos = cc.find(header);
        if (pos == std::string::npos)
            return def;
        auto start = pos + header.size();
        auto next = cc.find("\n[", start);
        const std::string section =
            (next == std::string::npos) ? cc.substr(start) : cc.substr(start, next - start);
        std::istringstream iss(section);
        std::string line;
        while (std::getline(iss, line)) {
            auto eq = line.find('=');
            if (eq == std::string::npos)
                continue;
            std::string k = line.substr(0, eq);
            k.erase(0, k.find_first_not_of(" \t"));
            k.erase(k.find_last_not_of(" \t") + 1);
            if (k != key)
                continue;
            std::string v = line.substr(eq + 1);
            v.erase(0, v.find_first_not_of(" \t\r\n"));
            v.erase(v.find_last_not_of(" \t\r\n") + 1);
            try {
                return static_cast<uint32_t>(std::stoul(v));
            } catch (...) {
            }
        }
        return def;
    };

    // [fire] is the new home; [controller_service] is still read as a fallback so an un-migrated
    // config keeps working. (That read used to name [state_machine], which holds only the CSV
    // paths, so the lookup always missed and every burn silently ran the 6000 ms default.)
    const uint32_t fire_duration_ms =
        getInt("fire", "duration_ms", getInt("controller_service", "fire_duration_ms", 6000));
    const uint32_t fire_extended_ms =
        getInt("fire", "extended_ms", getInt("controller_service", "fire_extended_ms", 10000));

    // Which state is the burn, and where its timer lands. Names, not enumerators.
    {
        const std::string fs = getStr("fire", "state", "");
        if (!fs.empty()) {
            State s = StateMachine::fromName(fs);
            if (s == State::UNKNOWN)
                std::cerr << "[SequencerService] [fire] state \"" << fs
                          << "\" is not a known state — falling back to Fire" << std::endl;
            else
                fire_state_ = s;
        }
        const std::string ft = getStr("fire", "expiry_target", "");
        if (!ft.empty()) {
            State s = StateMachine::fromName(ft);
            if (s == State::UNKNOWN)
                std::cerr << "[SequencerService] [fire] expiry_target \"" << ft
                          << "\" is not a known state — falling back to Armed" << std::endl;
            else
                fire_expiry_state_ = s;
        }
        actuator_commander_.setFireState(fire_state_);
        std::cout << "[SequencerService] Fire state: " << StateMachine::name(fire_state_)
                  << " → expires to " << StateMachine::name(fire_expiry_state_) << std::endl;
        // The expiry transition goes through the same isAllowed() gate as any other, so a target
        // the fire state cannot reach leaves the system sitting in FIRE with a dead timer. Say so
        // at startup rather than at T-0.
        if (!state_machine_.isAllowed(fire_state_, fire_expiry_state_))
            std::cerr << "[SequencerService] WARNING: " << StateMachine::name(fire_state_) << " → "
                      << StateMachine::name(fire_expiry_state_)
                      << " is not an allowed transition — the fire timer will expire into a "
                         "refused transition and the system will stay in fire."
                      << std::endl;
    }
    fire_manager_.configure(fire_duration_ms, fire_extended_ms);
    std::cout << "[SequencerService] Fire window: " << fire_duration_ms << " ms (extended "
              << fire_extended_ms << " ms)" << std::endl;

    // Controller service endpoint for FIRE_START / FIRE_STOP
    // Read from config; defaults to 127.0.0.1:8000
    std::string ctrl_host = "127.0.0.1";
    uint16_t ctrl_port = 8000;
    {
        std::istringstream cfg(config_content_);
        std::string line, cur_sec;
        while (std::getline(cfg, line)) {
            if (line.size() > 1 && line[0] == '[') {
                auto e = line.find(']');
                cur_sec = (e != std::string::npos) ? line.substr(1, e - 1) : "";
                continue;
            }
            if (cur_sec != "controller_service")
                continue;
            auto eq = line.find('=');
            if (eq == std::string::npos)
                continue;
            std::string k = line.substr(0, eq);
            k.erase(0, k.find_first_not_of(" \t"));
            k.erase(k.find_last_not_of(" \t") + 1);
            std::string v = line.substr(eq + 1);
            v.erase(0, v.find_first_not_of(" \t\r\n\""));
            v.erase(v.find_last_not_of(" \t\r\n\"") + 1);
            if (k == "host")
                ctrl_host = v;
            else if (k == "port") {
                try {
                    ctrl_port = static_cast<uint16_t>(std::stoi(v));
                } catch (...) {
                }
            }
        }
    }
    controller_host_ = ctrl_host;
    controller_port_ = ctrl_port;
    fire_manager_.setNotifier([this](bool active) { notifyControllerFire(active); });

    // Elodin — connection is best-effort; service runs without it
    const std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;
    {
        std::istringstream cfg(config_content_);
        std::string line, cur_sec;
        while (std::getline(cfg, line)) {
            if (line.size() > 1 && line[0] == '[') {
                auto e = line.find(']');
                cur_sec = (e != std::string::npos) ? line.substr(1, e - 1) : "";
                continue;
            }
            if (cur_sec != "database")
                continue;
            auto eq = line.find('=');
            if (eq == std::string::npos)
                continue;
            std::string k = line.substr(0, eq);
            k.erase(0, k.find_first_not_of(" \t"));
            k.erase(k.find_last_not_of(" \t") + 1);
            if (k != "port")
                continue;
            std::string v = line.substr(eq + 1);
            v.erase(0, v.find_first_not_of(" \t\r\n"));
            v.erase(v.find_last_not_of(" \t\r\n") + 1);
            try {
                elodin_port = static_cast<uint16_t>(std::stoi(v));
            } catch (...) {
            }
        }
    }
    elodin_host_ = elodin_host;
    elodin_port_ = elodin_port;
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
    State to = StateMachine::fromName(state_name);
    if (to == State::UNKNOWN) {
        std::cerr << "[SequencerService] Unknown state: " << state_name << std::endl;
        return false;
    }
    return transitionTo(to);
}

bool SequencerService::transitionTo(State to) {
    State from = current_state_.load();

    if (!debug_mode_) {
        if (!state_machine_.isAllowed(from, to)) {
            std::cerr << "[SequencerService] Transition " << StateMachine::name(from) << " → "
                      << StateMachine::name(to) << " is not allowed" << std::endl;
            return false;
        }
    }

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
    // behind a timer. (The physical UDP abort broadcast below is separate and always immediate.)
    actuator_commander_.startContinuousLoop(to, !isAbortState(to));

    // Update current state
    current_state_ = to;

    // Abort lifecycle
    if (isAbortState(to)) {
        abort_broadcaster_.triggerAbort();
    }

    // FIRE lifecycle — which state this is comes from [fire] state, not the enumerator.
    if (to == fire_state_) {
        fire_manager_.start([this]() {
            // Timer thread. Resolve to a State rather than a name: the old code round-tripped
            // through StateMachine::name(State::ARMED) → fromName(), so renaming the state made
            // fromName() return UNKNOWN and the transition was refused — stranding the system in
            // fire with the timer already stopped.
            transitionTo(fire_expiry_state_);
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
    debug_mode_ = enabled;
    if (!enabled)
        actuator_commander_.clearAllManualOverrides();
    std::cout << "[SequencerService] Debug mode: " << (enabled ? "ON" : "OFF") << std::endl;
    publishState();  // push updated debug_mode flag to GUI
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::manualActuator(const std::string& name, int pos) {
    if (!debug_mode_) {
        std::cerr << "[SequencerService] Manual actuator commands require debug mode" << std::endl;
        return false;
    }
    actuator_commander_.setManualOverride(name, pos);
    return actuator_commander_.sendSingleActuator(name, pos);
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::extendFire() {
    if (current_state_ != fire_state_) {
        std::cerr << "[SequencerService] EXTEND_FIRE ignored: not in FIRE state" << std::endl;
        return false;
    }
    fire_manager_.extend();
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::reloadConfig() {
    std::cout << "[SequencerService] Reloading config..." << std::endl;
    loadConfig(config_path_);

    std::string act_csv = resolveDataPath(configString(
        config_content_, "state_machine", "actuator_csv", "config/state_machine_actuators.csv"));
    if (!actuator_commander_.load(config_content_, act_csv)) {
        std::cerr << "[SequencerService] Reload: failed to reload actuator CSV" << std::endl;
        return false;
    }
    std::string sm_csv = resolveDataPath(configString(
        config_content_, "state_machine", "transitions_csv", "config/state_transitions.csv"));
    if (!state_machine_.load(sm_csv)) {
        std::cerr << "[SequencerService] Reload: failed to reload state transitions CSV"
                  << std::endl;
        return false;
    }
    std::cout << "[SequencerService] Config reloaded successfully" << std::endl;
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
    if (connect(sock, reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest)) == 0) {
        ssize_t n = send(sock, msg.c_str(), msg.size(), 0);
        (void)n;
        std::cout << "[SequencerService] → controller: " << (active ? "FIRE_START" : "FIRE_STOP")
                  << std::endl;
    } else {
        std::cerr << "[SequencerService] could not reach controller_service at " << controller_host_
                  << ":" << controller_port_ << " for "
                  << (active ? "FIRE_START" : "FIRE_STOP") << std::endl;
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
    const auto boards_map = fsw::config::load_active_boards(config_path_);
    const auto it_act = boards_map.find(fsw::config::ActiveBoardKind::ACTUATOR);
    const std::vector<fsw::elodin::BoardChannels> act_boards =
        (it_act != boards_map.end()) ? it_act->second : std::vector<fsw::elodin::BoardChannels>{};
    fsw::elodin::DatabaseConfig::register_non_sensor_tables(elodin_, act_boards);
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
