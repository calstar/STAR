#pragma once

/**
 * Ball valve command current: the loop current each valve is driven at to be fully closed
 * (ACTUATOR_COMMAND state 0) and fully open (state 1).
 *
 * The ideal is 4 / 20 mA, but an actuator's positioner may need a little more or less to reach the
 * end of its travel. The operator sets each end on the Calibration page while watching the
 * position readback; the backend stores it (backend/src/ball-valve-current.ts) and
 * config_broadcast sends it to the board as VALVE_CURRENT_CONFIG every cycle, built here.
 *
 * Separate from the position calibration (ball_valve_endpoints.json), which says what the
 * readback *means*; this says what the board *sends*.
 *
 * Store: scripts/calibration/calibrations/ball_valve_currents.json,
 *   { "valves": { "BV1_Cal.CH1": { "closed_ma": 4.0, "open_ma": 19.6, "updated_at_ms": ... } } }
 * keyed like the position calibration by the valve's calibrated entity (physical channel), so
 * renaming its role keeps its currents.
 */

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "DiabloPackets.h"

namespace fsw {
namespace calibration {
namespace valve_current {

constexpr double kDefaultClosedMa = 4.0;
constexpr double kDefaultOpenMa = 20.0;
/** NAMUR NE43's low saturation; clear of the board's 3.6 mA "command loop open" fault. */
constexpr double kMinMa = 3.8;
/** The MCP4728's full scale on the board: 4095 codes at 200 codes per mA. */
constexpr double kMaxMa = 20.475;
/** Ends closer than this cannot be a valve's travel; most likely a typo. */
constexpr double kMinSpanMa = 1.0;

struct Currents {
    double closed_ma = kDefaultClosedMa;
    double open_ma = kDefaultOpenMa;
};

/** Empty string when valid, else why not. Both ends in [kMinMa, kMaxMa], kMinSpanMa apart. */
std::string validate(const Currents& c);

/** "BV<slot>_Cal.CH<channel>": the key the store and the position calibration share. */
std::string entity_for(int slot, int channel);

/**
 * Parse the store. Entries that are malformed or fail validate() are dropped and named in
 * `warnings` (if given), so that valve gets the defaults rather than a bad current.
 * Unparseable text is an empty map plus a warning.
 */
std::map<std::string, Currents> parse(const std::string& json_text,
                                      std::vector<std::string>* warnings = nullptr);

/** parse() of a file; a missing file is an empty map (every valve at 4 / 20) and no warning. */
std::map<std::string, Currents> load_file(const std::string& path,
                                          std::vector<std::string>* warnings = nullptr);

/**
 * One entry per active connector of a ball valve board, calibrated or not, so clearing a
 * calibration sends 4 / 20 rather than leaving the board on its last value. Connectors outside
 * 1..255 are skipped; at most MAX_ACTUATORS_PER_BOARD entries.
 */
std::vector<daq::ValveCurrentEntry> entries_for_board(int slot, const std::vector<int>& channels,
                                                      const std::map<std::string, Currents>& store);

// ── Trial currents ────────────────────────────────────────────────────────────────────────────
// While calibrating, the operator drives a valve at a trial current (VALVE_TEST_CURRENT), watches
// its position, and saves it as open or closed. The backend writes
//   scripts/calibration/calibrations/ball_valve_trials.json,
//   { "valves": { "BV1_Cal.CH1": { "ma": 19.6, "expires_at_ms": <epoch ms> } } }
// and config_broadcast repeats each unexpired trial every cycle. The board drops a trial that is
// not repeated within 3 s, so an expiry, a cleared file or a stopped service all end it.

/**
 * The trials still running at `now_epoch_ms`, entity -> mA. Expired, malformed and out-of-range
 * ([kMinMa, kMaxMa]) entries are dropped; the bad ones are named in `warnings`.
 */
std::map<std::string, double> parse_trials(const std::string& json_text, int64_t now_epoch_ms,
                                           std::vector<std::string>* warnings = nullptr);

std::map<std::string, double> load_trials_file(const std::string& path, int64_t now_epoch_ms,
                                               std::vector<std::string>* warnings = nullptr);

/** One entry per active connector: its trial in uA, or 0 (no trial), so an ended trial ends
 *  on the board within one cycle rather than on its 3 s timeout. */
std::vector<daq::ValveTestCurrentEntry> trial_entries_for_board(
    int slot, const std::vector<int>& channels, const std::map<std::string, double>& trials);

}  // namespace valve_current
}  // namespace calibration
}  // namespace fsw
