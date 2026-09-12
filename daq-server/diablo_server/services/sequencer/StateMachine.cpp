#include "control/StateMachine.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>

#include "config/Config.hpp"

namespace sequencer {

// ─────────────────────────────────────────────────────────────────────────────
// CSV name → State map (mirrors TypeScript CSV_STATE_MAP in state-transitions.ts)
// ─────────────────────────────────────────────────────────────────────────────
const std::map<std::string, State>& StateMachine::csvStateMap() {
    static const std::map<std::string, State> map = {
        {"Debug", State::DEBUG},
        {"Idle", State::IDLE},
        {"Armed", State::ARMED},
        {"Fuel Fill", State::FUEL_FILL},
        {"Ox Fill", State::OX_FILL},
        {"Press Standby", State::PRESS_STANDBY},
        {"GN2 Low Press", State::GN2_LOW_PRESS},
        {"GN2 Low Vent", State::GN2_VENT},
        {"Fuel Press", State::FUEL_PRESS},
        {"Fuel Vent", State::FUEL_VENT},
        {"Ox Press", State::OX_PRESS},
        {"Ox Vent", State::OX_VENT},
        {"GN2 High Press", State::GN2_HIGH_PRESS},
        {"GN2 High Vent", State::GN2_HIGH_VENT},
        {"Vent", State::VENT},
        {"Calibrate", State::CALIBRATE},
        {"Ready", State::READY},
        {"Fire", State::FIRE},
        {"Engine Abort", State::ENGINE_ABORT},
        {"GSE Abort", State::GSE_ABORT},
        {"Emergency Abort", State::EMERGENCY_ABORT},
        // Legacy names
        {"GN2 Press", State::GN2_LOW_PRESS},
        {"GN2 Vent", State::GN2_VENT},
        {"Quick Fire", State::READY},
        {"High Press", State::GN2_HIGH_PRESS},
        {"Abort", State::EMERGENCY_ABORT},
    };
    return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config-declared states ([[states]]) — an override layer over the built-in table
// ─────────────────────────────────────────────────────────────────────────────
namespace {

struct ConfigStates {
    std::map<State, std::string> names;    // id → display name
    std::map<std::string, State> by_name;  // display name → id
    std::set<State> aborts;
    State boot = State::IDLE;
    bool boot_set = false;
    bool loaded = false;
};

ConfigStates& configStates() {
    static ConfigStates cs;
    return cs;
}

}  // namespace

void StateMachine::loadStatesFromConfig(const std::string& config_content) {
    ConfigStates fresh;
    const fsw::config::Config cfg = fsw::config::load_from_string(config_content);
    for (const auto& s : cfg.states) {
        // An entry needs a valid id and a name; skip incomplete ones. First is_boot wins.
        if (s.id < 0 || s.id > 255 || s.name.empty())
            continue;
        const State st = static_cast<State>(static_cast<uint8_t>(s.id));
        fresh.names[st] = s.name;
        fresh.by_name[s.name] = st;
        if (s.is_abort)
            fresh.aborts.insert(st);
        if (s.is_boot && !fresh.boot_set) {
            fresh.boot = st;
            fresh.boot_set = true;
        }
    }

    fresh.loaded = !fresh.names.empty();
    configStates() = fresh;
    if (fresh.loaded)
        std::cout << "[StateMachine] Loaded " << fresh.names.size() << " state(s) from config"
                  << (fresh.aborts.empty() ? ""
                                           : " (" + std::to_string(fresh.aborts.size()) + " abort)")
                  << std::endl;
}

bool StateMachine::isAbort(State s) {
    const auto& cs = configStates();
    // Once config declares states it is the sole authority — even when it flags none is_abort,
    // which means "this rig has no abort states," not "fall back to 17/18/19." The compiled ids
    // only stand in when no config states are loaded at all (no config / parse failure).
    if (cs.loaded)
        return cs.aborts.count(s) > 0;
    return s == State::ENGINE_ABORT || s == State::GSE_ABORT || s == State::EMERGENCY_ABORT;
}

State StateMachine::bootState() {
    const auto& cs = configStates();
    if (cs.loaded && cs.boot_set)
        return cs.boot;
    if (cs.loaded && !cs.names.empty()) {
        // Config declares states but flags none is_boot. Start in the lowest-id declared state
        // rather than a compiled IDLE(1) that names a different state on a renumbered rig, and say
        // so loudly — this is a misconfig the config editor should have prevented.
        const State first = cs.names.begin()->first;
        std::cerr << "[StateMachine] No is_boot state in config — booting into lowest-id state \""
                  << cs.names.begin()->second << "\"" << std::endl;
        return first;
    }
    return State::IDLE;
}

// ─────────────────────────────────────────────────────────────────────────────
// State → display name (for logging)
// ─────────────────────────────────────────────────────────────────────────────
std::string StateMachine::name(State s) {
    {
        const auto& cs = configStates();
        auto it = cs.names.find(s);
        if (it != cs.names.end())
            return it->second;
    }
    switch (s) {
        case State::DEBUG:
            return "Debug";
        case State::IDLE:
            return "Idle";
        case State::ARMED:
            return "Armed";
        case State::FUEL_FILL:
            return "Fuel Fill";
        case State::OX_FILL:
            return "Ox Fill";
        case State::PRESS_STANDBY:
            return "Press Standby";
        case State::GN2_LOW_PRESS:
            return "GN2 Low Press";
        case State::GN2_VENT:
            return "GN2 Low Vent";
        case State::FUEL_PRESS:
            return "Fuel Press";
        case State::FUEL_VENT:
            return "Fuel Vent";
        case State::OX_PRESS:
            return "Ox Press";
        case State::OX_VENT:
            return "Ox Vent";
        case State::GN2_HIGH_PRESS:
            return "GN2 High Press";
        case State::GN2_HIGH_VENT:
            return "GN2 High Vent";
        case State::VENT:
            return "Vent";
        case State::CALIBRATE:
            return "Calibrate";
        case State::READY:
            return "Ready";
        case State::FIRE:
            return "Fire";
        case State::ENGINE_ABORT:
            return "Engine Abort";
        case State::GSE_ABORT:
            return "GSE Abort";
        case State::EMERGENCY_ABORT:
            return "Emergency Abort";
        default:
            return "Unknown";
    }
}

// ─────────────────────────────────────────────────────────────────────────────
State StateMachine::fromName(const std::string& name) {
    {
        const auto& cs = configStates();
        auto it = cs.by_name.find(name);
        if (it != cs.by_name.end())
            return it->second;
        // Config is authoritative once loaded: a name it does not declare resolves to UNKNOWN, not
        // a compiled/legacy id that names a different state on a renumbered rig. The table below
        // stands in only when no config states are loaded at all (no config, or a parse failure).
        if (cs.loaded)
            return State::UNKNOWN;
    }
    const auto& map = csvStateMap();
    auto it = map.find(name);
    if (it != map.end())
        return it->second;

    // Case-insensitive fallback
    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    for (const auto& [k, v] : map) {
        std::string kl = k;
        std::transform(kl.begin(), kl.end(), kl.begin(), ::tolower);
        if (kl == lower)
            return v;
    }
    return State::UNKNOWN;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parsing
// ─────────────────────────────────────────────────────────────────────────────
static std::string trimCell(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

bool StateMachine::load(const std::string& csv_path) {
    const char* fallbacks[] = {
        "config/state_transitions.csv",
        "../config/state_transitions.csv",
        "../../config/state_transitions.csv",
        // Generated config/*.csv are absent on a fresh checkout (they are gitignored deploy
        // output); fall back to the profile that owns them.
        "config/profiles/default/state_transitions.csv",
        "../config/profiles/default/state_transitions.csv",
        "../../config/profiles/default/state_transitions.csv",
    };

    std::ifstream f(csv_path);
    std::string used_path = csv_path;
    if (!f.is_open()) {
        for (const char* fb : fallbacks) {
            if (std::string(fb) == csv_path)
                continue;
            f.open(fb);
            if (f.is_open()) {
                used_path = fb;
                break;
            }
        }
    }
    if (!f.is_open()) {
        std::cerr << "[StateMachine] Cannot open state_transitions.csv (tried: " << csv_path;
        for (const char* fb : fallbacks) {
            if (std::string(fb) != csv_path)
                std::cerr << ", " << fb;
        }
        std::cerr << ")" << std::endl;
        return false;
    }

    std::string line;
    if (!std::getline(f, line))
        return false;

    // Header row: ,Idle,Armed,...
    std::vector<State> column_states;
    {
        std::istringstream iss(line);
        std::string cell;
        bool first = true;
        while (std::getline(iss, cell, ',')) {
            if (first) {
                first = false;
                continue;
            }  // skip leading empty cell
            State s = fromName(trimCell(cell));
            column_states.push_back(s);
        }
    }

    transitions_.clear();
    int rows = 0;
    while (std::getline(f, line)) {
        std::vector<std::string> cells;
        std::istringstream iss(line);
        std::string cell;
        while (std::getline(iss, cell, ','))
            cells.push_back(trimCell(cell));
        if (cells.empty() || cells[0].empty())
            continue;

        State from = fromName(cells[0]);
        if (from == State::UNKNOWN)
            continue;

        for (size_t col = 1; col < cells.size() && col - 1 < column_states.size(); ++col) {
            if (cells[col] == "1") {
                State to = column_states[col - 1];
                if (to != State::UNKNOWN)
                    transitions_[from].insert(to);
            }
        }
        ++rows;
    }

    loaded_ = true;
    std::cout << "[StateMachine] Loaded " << rows << " states from " << used_path << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool StateMachine::isAllowed(State from, State to) const {
    auto it = transitions_.find(from);
    if (it == transitions_.end())
        return false;
    return it->second.count(to) > 0;
}

std::vector<State> StateMachine::allowedFrom(State state) const {
    std::vector<State> result;
    auto it = transitions_.find(state);
    if (it != transitions_.end()) {
        for (State s : it->second)
            result.push_back(s);
    }
    return result;
}

uint32_t StateMachine::allowedBitmask(State state) const {
    uint32_t mask = 0;
    auto it = transitions_.find(state);
    if (it != transitions_.end()) {
        for (State s : it->second) {
            uint8_t val = static_cast<uint8_t>(s);
            if (val < 32)
                mask |= (1u << val);
        }
    }
    return mask;
}

}  // namespace sequencer
