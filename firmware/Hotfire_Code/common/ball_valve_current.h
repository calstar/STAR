#pragma once

/**
 * Ball valve command current (BallValve_Hotfire): VALVE_CURRENT_CONFIG microamps -> MCP4728
 * codes, and whether to take them. No Arduino here, so Hotfire_Tests can run it on the host.
 *
 * Scale: MCP4728 on its internal 2.048 V reference, gain x1, is 0.5 mV per code, and the XTR111's
 * 1.00 k R_SET makes 10 mA per volt: 5 uA per code, 200 codes per mA. 4 mA = 800, 20 mA = 4000.
 *
 * Limits match the server's (daq-server lib ValveCommandCurrent.hpp, backend
 * ball-valve-current.ts): 3.8 mA (NAMUR NE43 low saturation, clear of the board's 3.6 mA "command
 * loop open" fault) to the DAC's full scale, 20.475 mA, and the two ends at least 1 mA apart.
 * Open below closed is allowed (a reverse-acting valve).
 */

#include <stdint.h>

namespace ball_valve_current {

static constexpr uint16_t CODE_CLOSED_DEFAULT = 800;  // 4 mA
static constexpr uint16_t CODE_OPEN_DEFAULT = 4000;   // 20 mA
static constexpr uint16_t DAC_MAX_CODE = 4095;        // 20.475 mA
static constexpr float DAC_CODES_PER_MA = 200.0f;
static constexpr uint16_t UA_PER_CODE = 5;

static constexpr uint16_t MIN_UA = 3800;
static constexpr uint16_t MAX_UA = 20475;
static constexpr uint16_t MIN_SPAN_UA = 1000;

inline bool valid(uint16_t closed_ua, uint16_t open_ua) {
    const bool in_range = closed_ua >= MIN_UA && closed_ua <= MAX_UA && open_ua >= MIN_UA &&
                          open_ua <= MAX_UA;
    const uint16_t span = closed_ua > open_ua ? closed_ua - open_ua : open_ua - closed_ua;
    return in_range && span >= MIN_SPAN_UA;
}

/** Nearest code (5 uA steps), never above full scale. */
inline uint16_t code_from_ua(uint16_t ua) {
    uint32_t code = (static_cast<uint32_t>(ua) + UA_PER_CODE / 2) / UA_PER_CODE;
    return static_cast<uint16_t>(code > DAC_MAX_CODE ? DAC_MAX_CODE : code);
}

inline uint16_t ua_from_code(uint16_t code) {
    return static_cast<uint16_t>(code * UA_PER_CODE);
}

enum class Result : uint8_t {
    Changed,    // new codes stored: rewrite the DAC, save to NVS
    Unchanged,  // already on these codes (the server repeats every cycle)
    Refused,    // out of range: codes left as they were
};

/** Take a VALVE_CURRENT_CONFIG entry for one valve. */
inline Result apply(uint16_t& closed_code, uint16_t& open_code, uint16_t closed_ua,
                    uint16_t open_ua) {
    if (!valid(closed_ua, open_ua))
        return Result::Refused;
    const uint16_t c = code_from_ua(closed_ua);
    const uint16_t o = code_from_ua(open_ua);
    if (c == closed_code && o == open_code)
        return Result::Unchanged;
    closed_code = c;
    open_code = o;
    return Result::Changed;
}

/** Codes read back from NVS: taken only if they are a valid pair, else the defaults stay. */
inline bool restore(uint16_t& closed_code, uint16_t& open_code, uint16_t nvs_closed,
                    uint16_t nvs_open) {
    if (nvs_closed == 0 || nvs_open == 0 || nvs_closed > DAC_MAX_CODE || nvs_open > DAC_MAX_CODE)
        return false;
    if (!valid(ua_from_code(nvs_closed), ua_from_code(nvs_open)))
        return false;
    closed_code = nvs_closed;
    open_code = nvs_open;
    return true;
}

/** The DAC code a valve is driven at for a commanded state (0 closed, 1 open). */
inline uint16_t code_for_state(uint8_t state, uint16_t closed_code, uint16_t open_code) {
    return state ? open_code : closed_code;
}

// ── Trial current (VALVE_TEST_CURRENT) ──────────────────────────────────────────────────────
// While calibrating, the operator drives a valve at a trial current, watches its position, and
// saves that current as the valve's open or closed. trial_code 0 means no trial.

/** Dropped if the server has not repeated it for this long (it repeats every ~1 s). */
static constexpr uint32_t TRIAL_TIMEOUT_MS = 3000;

inline bool valid_trial(uint16_t ua) {
    return ua >= MIN_UA && ua <= MAX_UA;
}

/** What the DAC drives: the trial while there is one, else the commanded state's current. */
inline uint16_t drive_code(uint8_t state, uint16_t closed_code, uint16_t open_code,
                           uint16_t trial_code) {
    return trial_code ? trial_code : code_for_state(state, closed_code, open_code);
}

enum class TrialResult : uint8_t {
    Started,    // no trial before: rewrite the DAC
    Changed,    // a different trial current: rewrite the DAC
    Refreshed,  // same trial repeated: only push its timeout back
    Ended,      // ua 0 ended a trial: rewrite the DAC
    None,       // ua 0 and no trial: nothing to do
    Blocked,    // the trial a command / the failsafe / an OTA ended: not resumed
    NotActive,  // no current server heartbeat: a valve on its failsafe is not trimmed
    Refused,    // out of range
};

/**
 * Take one VALVE_TEST_CURRENT entry. `server_active`: heartbeats are current.
 *
 * `blocked_code` is the trial that a command, the failsafe or an OTA ended (end_trial_on_board).
 * The server keeps repeating a trial until the operator stops it, so without this the next
 * repeat, a second later, would resume what the command just ended. It stays refused until the
 * server sends 0 (Stop, Save, expiry) or a different current (Drive again).
 */
inline TrialResult apply_trial(uint16_t& trial_code, uint16_t& blocked_code, uint16_t ua,
                               bool server_active) {
    if (ua == 0) {
        blocked_code = 0;
        if (!trial_code)
            return TrialResult::None;
        trial_code = 0;
        return TrialResult::Ended;
    }
    const uint16_t code = code_from_ua(ua);
    if (blocked_code && code == blocked_code)
        return TrialResult::Blocked;
    if (!server_active)
        return TrialResult::NotActive;
    if (!valid_trial(ua))
        return TrialResult::Refused;
    blocked_code = 0;
    if (code == trial_code)
        return TrialResult::Refreshed;
    const bool had = trial_code != 0;
    trial_code = code;
    return had ? TrialResult::Changed : TrialResult::Started;
}

/**
 * The board ends a trial itself (a command that changes the state, the failsafe, an OTA): it is
 * remembered in `blocked_code` so the server's next repeat does not resume it. Returns false if
 * there was none.
 */
inline bool end_trial_on_board(uint16_t& trial_code, uint16_t& blocked_code) {
    if (!trial_code)
        return false;
    blocked_code = trial_code;
    trial_code = 0;
    return true;
}

/** A trial the server stopped repeating. uint32_t, as millis() is on the ESP32, so the
 *  subtraction wraps the same on the board and in the host tests. */
inline bool trial_expired(uint16_t trial_code, uint32_t now_ms, uint32_t last_ms) {
    return trial_code != 0 && static_cast<uint32_t>(now_ms - last_ms) > TRIAL_TIMEOUT_MS;
}

}  // namespace ball_valve_current
