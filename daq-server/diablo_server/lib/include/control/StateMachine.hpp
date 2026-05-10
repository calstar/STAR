#pragma once

#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace sequencer {

/**
 * System state IDs — must match the TypeScript SystemState enum in web-gui/shared/types.ts.
 */
enum class State : uint8_t {
    DEBUG = 0,
    IDLE = 1,
    ARMED = 2,
    FUEL_FILL = 3,
    OX_FILL = 4,
    GN2_LOW_PRESS = 5,
    GN2_VENT = 6,
    FUEL_PRESS = 7,
    FUEL_VENT = 8,
    OX_PRESS = 9,
    OX_VENT = 10,
    GN2_HIGH_PRESS = 11,
    GN2_HIGH_VENT = 12,
    VENT = 13,
    CALIBRATE = 14,
    READY = 15,
    FIRE = 16,
    ENGINE_ABORT = 17,
    GSE_ABORT = 18,
    EMERGENCY_ABORT = 19,
    PRESS_STANDBY = 20,
    UNKNOWN = 255,
};

/**
 * Parses state_transitions.csv and validates state transitions.
 * Thread-safe for concurrent reads after load().
 */
class StateMachine {
public:
    /**
     * Load from a state_transitions.csv file.
     * Tries the given path, then a set of fallback paths.
     * @return true on success.
     */
    bool load(const std::string& csv_path);

    /**
     * Returns true if transitioning from→to is allowed.
     * In debug mode, always returns true.
     */
    bool isAllowed(State from, State to) const;

    /**
     * Returns the list of states reachable from the given state.
     * In debug mode, returns all known states.
     */
    std::vector<State> allowedFrom(State state) const;

    /**
     * Returns a bitmask where bit N is set if state N is reachable from the given state.
     * Used for the [0x50, 0x00] Elodin VTable payload.
     */
    uint32_t allowedBitmask(State state) const;

    /** Translate a CSV name (e.g. "Emergency Abort") to a State. */
    static State fromName(const std::string& name);

    /** Human-readable name for a State (e.g. State::FIRE → "Fire"). */
    static std::string name(State s);

    bool isLoaded() const {
        return loaded_;
    }

private:
    std::map<State, std::set<State>> transitions_;
    bool loaded_{false};

    static const std::map<std::string, State>& csvStateMap();
};

}  // namespace sequencer
