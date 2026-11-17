// DESIGN STUB (DESIGN-WP9 §2, move-only step 2) — not compiled. Becomes
// diablo_server/services/calibration/SensorModels.{hpp,cpp}.
//
// Which model each PT/LC/T7 sensor streams through (cubic, robust, blend, physics; linear, cubic,
// physics), the per-sensor physics parameters, and the selection functions that apply them.
//
// Owns:       move-only: the file-scope globals of calibration_main.cpp 80-150 (except the three
//             stream globals, which go to RawStream.cpp), now `extern` here and defined in
//             SensorModels.cpp. STYLE-S26 EXCEPTION, recorded (D58; DESIGN-WP9 §6.1 step 2): these
//             are namespace-scope std containers with dynamic initialisation in a new TU, which
//             S26 forbids; WP9 does not claim compliance. Harmless because every one is
//             default-constructed (no cross-TU initialisation-order dependency), nothing reads
//             them before main (the load_* fills are the first writers), and cleanup C2 removes
//             them: they become one SensorModels value owned by main and referenced from
//             CalibrationContext; the externs go away.
// Threads:    one (the service's only thread). No locks.
// Errors:     unknown model strings parse to today's defaults; missing per-uid entries fall back
//             (full scale 1000, sense resistor 120, LC Linear), as today. The load_* functions
//             print today's lines (counts, T7 count) — they are construction with side effects and
//             are called at today's positions in main (DESIGN-WP9 §6.1 step 6).
// D22:        select_pt_psi contains the Blend expression `(1 - kFactoryWeight) * psi_rob +
//             kFactoryWeight * psi_fac` (contractible) and stays header-inline so it is still
//             inlined into handle_t7_raw, handle_esp32_raw and the bisection's forward lambda —
//             its three call sites today. Never move it out of line or into the lib.
// Must not know: Elodin, the stores, files, CalibrationContext. Config is passed in (STYLE-S18).
// Contract:   cal_status and published values — calibration/golden/stack.txt; DESIGN-WP9 §7 G1
//             (Blend) and G2 (env overrides).
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "calibration/CubicCalibrationStore.hpp"
#include "config/Config.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "t7/T7Calibration.hpp"

namespace fsw::calibration_service {

enum class PtModel { Cubic, Robust, Blend, Physics };
enum class LcModel { Linear, Cubic, Physics };

// ── state (move-only: extern globals; cleanup C2: members of one main-owned value) ──
extern std::unordered_map<uint16_t, PtModel> g_pt_model;
extern std::unordered_map<uint16_t, std::string> g_uid_role;
extern std::unordered_map<uint16_t, double> g_pt_full_scale;
extern std::unordered_map<uint16_t, double> g_pt_sense_resistor;
extern std::optional<PtModel> g_env_override;
extern std::unordered_map<uint16_t, LcModel> g_lc_model;
extern std::unordered_map<uint16_t, double> g_lc_full_scale;
extern std::unordered_map<uint16_t, double> g_lc_sensitivity;
extern std::unordered_map<uint16_t, double> g_lc_pga_gain;
extern std::set<uint16_t> g_lc_uids;
extern std::set<uint8_t> g_lc_board_ids;

// ── lookups and selection (header-inline; 156-261, 280-329 — the 280-285 comment moves with
// select_pt_psi, STYLE-S38) ──
inline bool verbose();
inline bool env_flag_true(const char* name);
inline PtModel parse_pt_model(const std::string& s);
inline PtModel pt_model_for(uint16_t uid);
inline double pt_full_scale_for(uint16_t uid);
inline double pt_sense_resistor_for(uint16_t uid);
inline const char* pt_model_name(PtModel m);
inline LcModel parse_lc_model(const std::string& s);
inline LcModel lc_model_for(uint16_t uid);
inline bool lc_streams_physics(uint16_t uid, bool fit_ok);
inline double lc_full_scale_for(uint16_t uid, double fallback);
inline double lc_sensitivity_for(uint16_t uid, double fallback);
inline double lc_pga_gain_for(uint16_t uid, double fallback);
inline const char* lc_model_name(LcModel m);
inline double select_pt_psi(uint16_t uid, double psi_fac, double psi_rob, double psi_phys,
                            bool fac_ok, bool has_robust);
inline double select_lc_kg(uint16_t uid, double kg_fit, double kg_phys, bool fit_ok);

// ── construction-time fills (SensorModels.cpp; called at today's positions in main) ──
/** 764-879 (the 764-772 comment with the env override at 773, STYLE-S38): env override, PT and LC
 *  per-sensor models/params into the state above. 761-762 (the LC default print) stays in main. */
void load_pt_lc_models(const ::fsw::config::Config& cal_cfg);
/** 894-911: T7 models; prints the T7 count (910-911). Called after main builds t7_map (889-893). */
void load_t7_models(const ::fsw::config::Config& cal_cfg, const fsw::t7::T7CalibrationMap& t7_map);
/** 943-992: register PT, LC and T7 channels with the cubic store; fills g_lc_uids/g_lc_board_ids.
 */
void register_store_channels(fsw::calibration::CubicCalibrationStore& cubic_store,
                             const std::vector<fsw::elodin::BoardChannels>& pt_boards,
                             const std::vector<fsw::elodin::BoardChannels>& lc_boards,
                             const fsw::t7::T7CalibrationMap& t7_map);
/** 1436-1472: the startup model summary lines. */
void print_model_summary();

}  // namespace fsw::calibration_service
