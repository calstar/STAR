#include "control/SequencerService.hpp"

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
    state_snapshot_stop_ = true;
    if (state_snapshot_thread_.joinable())
        state_snapshot_thread_.join();
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

bool SequencerService::init(const std::string& config_path) {
    loadConfig(config_path);

    // State machine CSV
    std::string sm_csv = resolveDataPath("firmware/test_guis/state_transitions.csv");
    if (!state_machine_.load(sm_csv)) {
        std::cerr
            << "[SequencerService] Failed to load state_transitions.csv (tried relative to cwd: "
            << sm_csv << ")" << std::endl;
        return false;
    }

    // Actuator commander
    std::string act_csv = resolveDataPath("firmware/test_guis/state_machine_actuators.csv");
    if (!actuator_commander_.load(config_content_, act_csv)) {
        std::cerr << "[SequencerService] Failed to load state_machine_actuators.csv (tried: "
                  << act_csv << ")" << std::endl;
        return false;
    }

    // FireManager: load durations from config
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

    const uint32_t fire_duration_ms = getInt("state_machine", "fire_duration_ms", 6000);
    const uint32_t fire_extended_ms = getInt("state_machine", "fire_extended_ms", 10000);
    fire_manager_.configure(fire_duration_ms, fire_extended_ms);

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
    fire_manager_.setControllerEndpoint(ctrl_host, ctrl_port);

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
    if (elodin_.connect(elodin_host, elodin_port)) {
        std::cout << "[SequencerService] Connected to Elodin at " << elodin_host << ":"
                  << elodin_port << std::endl;
        const auto boards_map = fsw::config::load_active_boards(config_path_);
        const auto it_act = boards_map.find(fsw::config::ActiveBoardKind::ACTUATOR);
        const std::vector<fsw::elodin::BoardChannels> act_boards =
            (it_act != boards_map.end()) ? it_act->second
                                         : std::vector<fsw::elodin::BoardChannels>{};
        fsw::elodin::DatabaseConfig::register_non_sensor_tables(elodin_, act_boards);
        actuator_commander_.setElodinClient(&elodin_);
        actuator_commander_.publishInitialState();
    } else {
        std::cerr << "[SequencerService] Cannot connect to Elodin (state will not be published)"
                  << std::endl;
    }

    current_state_ = State::IDLE;
    // Publish initial state so any already-connected backend/GUI knows we started at IDLE.
    publishState();
    // Command IDLE actuators and keep resending so manual debug clicks cannot stick vs CSV.
    actuator_commander_.applyForState(State::IDLE);
    actuator_commander_.startContinuousLoop(State::IDLE);
    std::cout << "[SequencerService] Initialized. Current state: "
              << StateMachine::name(State::IDLE) << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::isAbortState(State s) {
    return s == State::ENGINE_ABORT || s == State::GSE_ABORT || s == State::EMERGENCY_ABORT;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::transitionTo(const std::string& state_name) {
    State to = StateMachine::fromName(state_name);
    if (to == State::UNKNOWN) {
        std::cerr << "[SequencerService] Unknown state: " << state_name << std::endl;
        return false;
    }

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
    if (from == State::FIRE && to != State::FIRE) {
        fire_manager_.stop();
    }

    // Apply actuator commands for new state
    actuator_commander_.applyForState(to);

    // Start continuous re-send loop for new state
    actuator_commander_.startContinuousLoop(to);

    // Update current state
    current_state_ = to;

    // Abort lifecycle
    if (isAbortState(to)) {
        abort_broadcaster_.triggerAbort();
    }

    // FIRE lifecycle
    if (to == State::FIRE) {
        fire_manager_.start([this]() {
            // Called from FireManager's timer thread when FIRE expires
            transitionTo(StateMachine::name(State::ARMED));
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
    if (current_state_ != State::FIRE) {
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

    std::string act_csv = resolveDataPath("firmware/test_guis/state_machine_actuators.csv");
    if (!actuator_commander_.load(config_content_, act_csv)) {
        std::cerr << "[SequencerService] Reload: failed to reload actuator CSV" << std::endl;
        return false;
    }
    std::string sm_csv = resolveDataPath("firmware/test_guis/state_transitions.csv");
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

void SequencerService::startStateSnapshotPublisher() {
    if (state_snapshot_thread_.joinable())
        return;
    state_snapshot_stop_ = false;
    state_snapshot_thread_ = std::thread([this]() {
        while (!state_snapshot_stop_) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            if (!elodin_.is_connected())
                continue;
            const State s = current_state_.load();
            publishStateTransition(s, s);
        }
    });
}

}  // namespace sequencer
