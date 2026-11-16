// DESIGN STUB (DESIGN-WP9 §3; AMENDMENT: its own header, not CalibrationActions.hpp) — not
// compiled. Becomes diablo_server/services/calibration/CalibrationContext.hpp.
//
// A method-less carrier of the main() locals that today's ~15 capture/clear/reload lambdas
// captured by reference, so the functions that replace them can live in three TUs. Not an
// abstraction (STYLE-S34, D43(3)): no methods, no constructor logic, no ownership.
//
// Owns:       nothing. Every member is a reference to an object main constructed at today's line
//             position (construction has side effects: prints, path registration; DESIGN-WP9 §8).
//             main builds the context immediately after the last register_store_channels call
//             (old 992) and it lives in main's frame for the process lifetime; evaluators returned
//             by lc_eval_for capture it by reference and are used only during LcTareStore calls.
// Threads:    one. The lib objects' own mutexes are taken per call, uncontended; the only nesting
//             is LcTareStore::mutex_ → the evaluator, which must touch only lc_calibration and
//             t7_map (DESIGN-WP9 §1.4).
// Must not know: Elodin, the read loop, StreamState.
// Why its own header: CalibrationActions, AbortThresholds, CalibrationCommands and RawStream all
//             take it; without this file AbortThresholds.hpp would include the whole actions API
//             for one type while CalibrationActions.cpp includes AbortThresholds.hpp back.
#pragma once

#include <cstdint>
#include <map>
#include <string>

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

}  // namespace fsw::calibration_service
