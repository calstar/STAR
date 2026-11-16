// DESIGN STUB (DESIGN-WP9 §2, move-only step 4) — not compiled. Becomes
// diablo_server/services/calibration/AbortThresholds.{hpp,cpp}. Bodies: 532-594 (file-static
// kMinAbortCalPoints, invert_abort_psi_to_adc) and 1032-1108.
//
// The one writer of abort_thresholds.txt: for each abort role, invert the role's psi threshold to
// an ADC code by bisection over the active forward model (select_pt_psi, header-inline), falling
// back to the physics model when the fit has fewer than kMinAbortCalPoints points; write via
// `.tmp` + rename. Triggered from CalibrationActions only (capture, clear, reload_live_store).
//
// Owns:       the file's content and its temporary; nothing in memory.
// Threads:    one.
// Errors:     unknown role / T7 role / no mapping → one stderr line per role, role omitted; write
//             failure → stderr `abort_thresholds write failed: …`, continue. Never fatal.
// Must not know: who reads the file. config_broadcast_service re-reads it every cycle and puts
//             the thresholds in ACTUATOR_CONFIG (only to a designated survivor, C6-6; abort IPs
//             reversed, C1-2): a pull, by design — no notification is added (DESIGN-WP9
//             walkthrough (d) step 15).
// Contract:   abort_thresholds.txt snapshots in calibration/golden/stack.txt (generated_unix
//             normalised); packets/golden/service_config_broadcast.txt downstream. H-1: the
//             integration harness parks and restores the live file.
#pragma once

#include "CalibrationContext.hpp"

namespace fsw::calibration_service {

void write_abort_thresholds(CalibrationContext& ctx);

}  // namespace fsw::calibration_service
