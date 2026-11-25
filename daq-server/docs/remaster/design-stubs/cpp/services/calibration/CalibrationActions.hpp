// DESIGN STUB (DESIGN-WP9 §2-§3, move-only step 3) — not compiled. Becomes
// diablo_server/services/calibration/CalibrationActions.{hpp,cpp}. Bodies, in today's textual
// order: calibration_main.cpp 532-594 (file-static kMinAbortCalPoints, invert_abort_psi_to_adc),
// 727-732, 994-1259 (the 994-998 banner comment leads sample_robust_curve, STYLE-S38; 1032-1108
// write_abort_thresholds file-static) and 1294-1391; each lambda becomes a function of the same
// name with the captured locals reached through `ctx.` (STYLE-S7: no renames). D58 folded
// AbortThresholds.{hpp,cpp} (one consumer: this TU, at 1124, 1241, 1385) and
// CalibrationContext.hpp (its two other takers include this header anyway) into this file. D69
// made sample_robust_curve, recompute_tare and recompute_all_tares file-static too: every caller
// (1117, 1381; 1186, 1252; 1389) is in this TU.
//
// ── CalibrationContext ──
// A method-less carrier of the main() locals that today's 16 capture/clear/reload lambdas captured
// by reference, so the functions that replace them can live in three TUs. Not an abstraction
// (STYLE-S34, D43(3)): no methods, no constructor logic, no ownership.
// Owns:       nothing. Every member is a reference to an object main constructed at today's line
//             position (construction has side effects: prints, path registration; DESIGN-WP9 §8).
//             main builds the context immediately after the last register_store_channels call
//             (old 992) and it lives in main's frame for the process lifetime; evaluators returned
//             by lc_eval_for capture it by reference and are used only during LcTareStore calls.
// Threads:    one. The lib objects' own mutexes are taken per call, uncontended; the only nesting
//             is LcTareStore::mutex_ → the evaluator, which must touch only lc_calibration and
//             t7_map (DESIGN-WP9 §1.4).
// Must not know: Elodin, the read loop, StreamState.
// Why here, not its own header (D58): the verdict's reason for a separate header was that
//             AbortThresholds.hpp should not pull the whole actions API in for one type while
//             CalibrationActions.cpp included AbortThresholds.hpp back. With write_abort_thresholds
//             a file-static here, that cycle is gone, and both remaining takers of the type —
//             CalibrationCommands.cpp (apply_capture, apply_clear, take_capture,
//             reload_live_store) and RawStream.cpp (current_loop_board at 1973) — include this
//             header regardless. A separate file would save them nothing.
//
// ── the actions ──
// Owns:       nothing; they act on the objects CalibrationContext references.
// Threads:    one (the read loop's), plus the LcTareStore nesting above.
// Order:      apply_capture → apply_pt_capture: cubic_store.add_point (fit, lib) →
//             pt_calibration.set_calibration → robust_manager.update_calibration →
//             cubic_store.set_fit_curve(sample_robust_curve) → cubic_store.save() →
//             robust_manager.save_adjustments → write_abort_thresholds. reload_live_store ends with
//             write_abort_thresholds() then recompute_all_tares(). Never reordered.
// Errors:     a capture without fresh data → take_capture logs `[Cal] <what> uid=… REJECTED (…)`
//             and the caller does nothing; file write failures are logged by the stores, the
//             service continues. No exceptions caught or added (STYLE-S9).
// Must not know: the Elodin client, packet layouts, StreamState, the 0x46 command encoding.
// Contract:   cubic_calibration.json, adjustments, lc_tare.json snapshots and the published frames
//             after each command — calibration/golden/stack.txt (fitCurve masked: C3-1).
//
// ── write_abort_thresholds (file-static; was AbortThresholds.{hpp,cpp} before D58) ──
// The one writer of abort_thresholds.txt: for each abort role, invert the role's psi threshold to
// an ADC code by bisection over the active forward model (select_pt_psi, header-inline; D22: the
// bisection's forward lambda 565-578 is one of its three call sites), falling back to the physics
// model when the fit has fewer than kMinAbortCalPoints points; write via `.tmp` + rename. Called
// from apply_pt_capture, apply_pt_clear and reload_live_store only.
// Owns:       the file's content and its temporary; nothing in memory.
// Errors:     unknown role / T7 role / no mapping → one stderr line per role, role omitted; write
//             failure → stderr `abort_thresholds write failed: …`, continue. Never fatal.
// Must not know: who reads the file. config_broadcast_service re-reads it every cycle and puts
//             the thresholds in ACTUATOR_CONFIG (only to a designated survivor, C6-6; abort IPs
//             reversed, C1-2): a pull, by design — no notification is added (DESIGN-WP9
//             walkthrough (d) step 15, debates/WP9/history.md).
// Contract:   abort_thresholds.txt snapshots in calibration/golden/stack.txt (generated_unix
//             normalised); packets/golden/service_config_broadcast.txt downstream. H-1: the
//             integration harness parks and restores the live file.
//
// File-static in the .cpp (not declared here): kMinAbortCalPoints, invert_abort_psi_to_adc,
//             write_abort_thresholds, sample_robust_curve (999-1020: 41 robust predictions,
//             wall-clock dependent, C3-1), recompute_tare, recompute_all_tares (1164-1175),
//             apply_pt_capture, apply_lc_capture, apply_pt_clear, apply_lc_clear. Size: ~510 lines
//             (433 moved + file comment, includes, namespace), under STYLE-S33's 700.
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "calibration/CaptureWindow.hpp"
#include "calibration/CubicCalibrationStore.hpp"
#include "calibration/LcTareStore.hpp"
#include "calibration/PTCalibration.hpp"
#include "calibration/RobustCalibrationManager.hpp"
#include "calibration/SensorCalibration.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "t7/T7Calibration.hpp"

namespace fsw::calibration_service {

struct CalibrationContext {
    const ::fsw::config::Config& cal_cfg;
    const std::map<uint8_t, ::fsw::config::PtBoardConfig>& pt_board_configs;
    const fsw::t7::T7CalibrationMap& t7_map;
    const std::map<uint16_t, std::string>& uid_role;
    const std::string& adjustments_path;
    fsw::calibration::PTCalibrationManager& pt_calibration;
    fsw::calibration::RobustCalibrationManager& robust_manager;
    fsw::calibration::SensorCalibrationManager& lc_calibration;
    fsw::calibration::CubicCalibrationStore& cubic_store;
    fsw::calibration::LcTareStore& lc_tare_store;
    fsw::calibration::CaptureWindow& capture_window;
    const double lc_sensitivity_mv_per_v, lc_pga_gain, lc_full_scale_value;
};

/** 727-732. Also used by RawStream's ESP32 PT path (1973). */
const ::fsw::config::PtBoardConfig* current_loop_board(const CalibrationContext& ctx,
                                                       uint8_t board_number);
/** 1130-1156. The returned evaluator captures ctx by reference and uid by value (the inner lambda
 *  head at 1131, `[&, uid]` -> `[&ctx, uid]`, is the one changed line in the body). Also called
 *  by main's stale-tare audit (1422) and the Tare command (1806). */
fsw::calibration::LcTareStore::Evaluator lc_eval_for(CalibrationContext& ctx, uint16_t uid);
/** 1194-1203: CaptureWindow decides; this logs a rejection. */
fsw::calibration::CaptureResult take_capture(CalibrationContext& ctx, uint16_t uid,
                                             const char* what);
/** 1205-1211: takes no context. */
std::string capture_detail(const fsw::calibration::CaptureResult& r);
bool is_lc_uid(uint16_t uid);
void apply_capture(CalibrationContext& ctx, uint16_t uid, double adc_avg, double ref);
void apply_clear(CalibrationContext& ctx, uint16_t uid);
/** 1294-1391. Returns the count of restored entries, as the lambda did. */
size_t reload_live_store(CalibrationContext& ctx, bool restore_learned);

}  // namespace fsw::calibration_service
