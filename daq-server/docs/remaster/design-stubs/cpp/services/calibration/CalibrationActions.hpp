// DESIGN STUB (DESIGN-WP9 §2, move-only step 3) — not compiled. Becomes
// diablo_server/services/calibration/CalibrationActions.{hpp,cpp}. Bodies: calibration_main.cpp
// 727-732 and 999-1259, 1294-1391, as functions in the same textual order; each lambda becomes a
// function of the same name with the captured locals reached through `ctx.` (STYLE-S7: no renames).
//
// Owns:       nothing; it acts on the objects CalibrationContext references.
// Threads:    one (the read loop's), plus the LcTareStore nesting described in CalibrationContext.
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
// File-static in the .cpp (not declared here): apply_pt_capture, apply_lc_capture, apply_pt_clear,
//             apply_lc_clear.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "CalibrationContext.hpp"
#include "calibration/CaptureWindow.hpp"
#include "calibration/LcTareStore.hpp"
#include "config/LoadActiveBoards.hpp"

namespace fsw::calibration_service {

/** 727-732. Also used by RawStream's ESP32 PT path (1973). */
const ::fsw::config::PtBoardConfig* current_loop_board(const CalibrationContext& ctx,
                                                       uint8_t board_number);
/** 999-1020. 41 robust predictions (wall-clock dependent, C3-1). */
std::vector<std::pair<double, double>> sample_robust_curve(CalibrationContext& ctx, uint16_t uid);
/** 1130-1156. The returned evaluator captures ctx by reference and uid by value. */
fsw::calibration::LcTareStore::Evaluator lc_eval_for(CalibrationContext& ctx, uint16_t uid);
void recompute_tare(CalibrationContext& ctx, uint16_t uid);
void recompute_all_tares(CalibrationContext& ctx);
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
