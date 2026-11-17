// DESIGN STUB (DESIGN-WP9 §2-§3, move-only step 5) — not compiled. Becomes
// diablo_server/services/calibration/RawStream.{hpp,cpp}. Bodies: 1827-1910 (T7) and 1913-2127
// (ESP32 filter, decode, per-type publish, then the 10000-count log and the 5-minute robust
// auto-save, which therefore still run only after an ESP32 packet). Outer-loop `continue`s inside
// them become `return` (1829, 1838, 1841, 1845, 1910, 1915, 1922, 1924, 1930, 1939).
//
// Converts raw ADC rows to engineering units and publishes the calibrated tables.
//
// Owns:       StreamState's owned members (counters, last_save, last_adc_map) and, in the
//             anonymous namespace of RawStream.cpp, the stream globals g_hp_ma_live,
//             g_pt_smoother, g_t7_cold_junction_c (cleanup C2 moves them into StreamState). The
//             function-local `static int ch_mismatch_warn` stays in handle_esp32_raw.
//             last_adc_map is WRITE-ONLY on the baseline (declaration 1560, the reconnect clear
//             1575, writes 1860, 1883, 1983, 2075, a comment naming it at 1791, no reader): it
//             moves verbatim here and cleanup deletes it, that grep being the proof (DESIGN-WP9
//             §6.2, D73).
// last_save:  DEFAULT MEMBER INITIALISER `= std::chrono::steady_clock::now()` (D73). The struct is
//             constructed by main at old 1557's position, after connect_and_register (1544), which
//             is exactly where today's `auto last_save = steady_clock::now()` (1559) ran, so the
//             timing is unchanged and main's aggregate initialiser does not name the member. A
//             bare member would be the epoch, so the first ESP32 packet would satisfy `> 300` s
//             at 2124 and save adjustments at once — and the EXISTING golden sees it: the first
//             sync() sentinel (service_run.py:567, a raw 0x30 row) takes the ESP32 path, so an
//             epoch member writes adj.json before files("after refused commands") (:585), where
//             stack.txt:4780 has <absent> today (save_adjustments writes a file even with no
//             learned state). No new snapshot; checkpoint 2 is gated by DESIGN-WP9 §6.1's checks
//             alone.
// Threads:    one. ElodinClient's publish_mutex_ is taken per publish, uncontended.
// Order:      per packet: begin_batch → publish each value → flush_batch → ++packet_count; PT:
//             select_pt_psi then `psi = g_pt_smoother.step(uid, psi)` in the same statement
//             sequence as today (D22: PtSmoother::step is contractible and inlined here).
// Errors:     short / non-table / own-output / out-of-range packets → return before begin_batch,
//             silently except the small-payload log while debug_limit < 20 (one counter shared with
//             main's "Received packet" log, < 10). Non-finite T7 volts / unknown T7 table →
//             skipped.
// Must not know: the 0x46 commands, the stores' files (it only reads calibrations), subscription
//             management. main owns the Elodin connection; StreamState only references it.
// Contract:   published float32 values and cal_status — calibration/golden/stack.txt (4 ULP;
//             published-near-zero abs 1e-12); t7_integration; integration cal_robust_learn.
// Naming:     the StreamState parameter is `stream`, main's local name, so DESIGN-WP9 §6.1 check
//             (h)'s prefix strip (`stream.`, `, stream`) dims the moved bodies; there is no `st`.
//             CalibrationContext comes from CalibrationActions.hpp (D58), which the .cpp needs for
//             current_loop_board (1973) anyway.
#pragma once

#include <sys/types.h>

#include <chrono>
#include <cstdint>
#include <map>
#include <vector>

#include "CalibrationActions.hpp"
#include "calibration/SensorCalibration.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

namespace fsw::calibration_service {

/** Carrier of the read loop's locals two handlers share (1557 packet_count, 1559 last_save, 1560
 *  last_adc_map; 1558 logged_ch5 and 1562 command_dedupe stay in main) plus references to the
 *  objects they publish with. Built by main after connect, before the loop, replacing those three
 *  lines. Not an abstraction (STYLE-S34): no methods. Member types are today's locals' types,
 *  unchanged. */
struct StreamState {
    fsw::elodin::ElodinClient& elodin_client;
    fsw::calibration::SensorCalibrationManager& tc_calibration;
    fsw::calibration::SensorCalibrationManager& rtd_calibration;
    const std::vector<fsw::elodin::BoardChannels>& pt_boards;
    const std::vector<fsw::elodin::BoardChannels>& lc_boards;
    const double tc_adc_ref_voltage, rtd_adc_ref_voltage, rtd_excitation_ua, rtd_r0_ohm;
    int packet_count = 0;
    int debug_limit = 0;  // was a function-local static at 1621: same single counter, zero start
    // Today's type (1559). The default member initialiser runs when main constructs the struct at
    // old 1557's position, which is where 1559 ran: timing unchanged (D73). A bare member would be
    // the epoch and save on the first ESP32 packet; stack.txt:4780 (<absent>) is the check.
    std::chrono::steady_clock::time_point last_save = std::chrono::steady_clock::now();
    // today's type (1560); write-only (no reader on the baseline), deleted in cleanup (D73)
    std::map<uint16_t, int32_t> last_adc_map;
};

/** LabJack T7 raw rows (type_hi == 0x26). */
void handle_t7_raw(CalibrationContext& ctx, StreamState& stream, const uint8_t* pkt_buf,
                   ssize_t pkt_len, uint8_t type_lo);

/** ESP32 raw rows (0x20-0x24, 0x30, ball valve). Includes the count log and the auto-save tail. */
void handle_esp32_raw(CalibrationContext& ctx, StreamState& stream, const uint8_t* pkt_buf,
                      ssize_t pkt_len, uint8_t type_hi, uint8_t type_lo);

/** CLEANUP C2 ONLY (DESIGN-WP9 amendment): the reconnect clear of last_adc_map, called by main's
 *  loop head at today's position (after capture_window.clear(), before "[Cal] Reconnected to
 *  Elodin"). In move-only, main does `stream.last_adc_map.clear();` itself (D73: not minted
 *  there). Vacuous once the last_adc_map deletion lands first among the cleanup commits
 *  (DESIGN-WP9 §6.2, D73): it is the only RawStream state the reconnect clears, so C2 then has
 *  nothing to move here and does not mint this function either. */
void on_elodin_reconnected(StreamState& stream);

}  // namespace fsw::calibration_service
