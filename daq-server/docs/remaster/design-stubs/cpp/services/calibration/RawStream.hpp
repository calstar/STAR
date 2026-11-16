// DESIGN STUB (DESIGN-WP9 §2-§3, move-only step 6) — not compiled. Becomes
// diablo_server/services/calibration/RawStream.{hpp,cpp}. Bodies: 1827-1910 (T7) and 1913-2127
// (ESP32 filter, decode, per-type publish, then the 10000-count log and the 5-minute robust
// auto-save, which therefore still run only after an ESP32 packet). Outer-loop `continue`s inside
// them become `return` (1829, 1838, 1841, 1845, 1910, 1915, 1922, 1924, 1930, 1939).
//
// Converts raw ADC rows to engineering units and publishes the calibrated tables.
//
// Owns:       StreamState's owned members (counters, last_save, last_adc_map) and, in
// RawStream.cpp's
//             anonymous namespace, the stream globals g_hp_ma_live, g_pt_smoother,
//             g_t7_cold_junction_c (cleanup C2 moves them into StreamState). The function-local
//             `static int ch_mismatch_warn` stays in handle_esp32_raw.
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
#pragma once

#include <sys/types.h>

#include <chrono>
#include <cstdint>
#include <map>
#include <vector>

#include "CalibrationContext.hpp"
#include "calibration/SensorCalibration.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

namespace fsw::calibration_service {

/** Carrier of the read loop's locals two handlers share (1557-1562) plus references to the
 *  objects they publish with. Built by main after connect, before the loop. Not an abstraction
 *  (STYLE-S34): no methods. Member types are today's locals' types, unchanged. */
struct StreamState {
    fsw::elodin::ElodinClient& elodin_client;
    fsw::calibration::SensorCalibrationManager& tc_calibration;
    fsw::calibration::SensorCalibrationManager& rtd_calibration;
    const std::vector<fsw::elodin::BoardChannels>& pt_boards;
    const std::vector<fsw::elodin::BoardChannels>& lc_boards;
    const double tc_adc_ref_voltage, rtd_adc_ref_voltage, rtd_excitation_ua, rtd_r0_ohm;
    int packet_count = 0;
    int debug_limit = 0;  // was a function-local static at 1621: same single counter, zero start
    std::chrono::steady_clock::time_point last_save;  // today's type of `last_save`
    std::map<uint16_t, int32_t> last_adc_map;         // today's type (1560)
};

/** LabJack T7 raw rows (type_hi == 0x26). */
void handle_t7_raw(CalibrationContext& ctx, StreamState& st, const uint8_t* pkt_buf,
                   ssize_t pkt_len, uint8_t type_lo);

/** ESP32 raw rows (0x20-0x24, 0x30, ball valve). Includes the count log and the auto-save tail. */
void handle_esp32_raw(CalibrationContext& ctx, StreamState& st, const uint8_t* pkt_buf,
                      ssize_t pkt_len, uint8_t type_hi, uint8_t type_lo);

/** CLEANUP C2 ONLY (DESIGN-WP9 amendment): the reconnect clear of last_adc_map, called by main's
 *  loop head at today's position (after capture_window.clear(), before "[Cal] Reconnected to
 *  Elodin"). In move-only, main does `stream.last_adc_map.clear();` itself. */
void on_elodin_reconnected(StreamState& st);

}  // namespace fsw::calibration_service
