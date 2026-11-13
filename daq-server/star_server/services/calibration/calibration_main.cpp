/**
 * @file calibration_main.cpp
 * @brief Standalone Calibration Service — subscribes directly to Elodin, applies calibration,
 *        publishes calibrated VTables back to Elodin.
 *
 * Connects directly to Elodin DB (port 2240) and subscribes to the raw sensor
 * data (PT, TC, RTD, LC). Publishes calibrated values to the same Elodin instance. No relay
 * dependency — fully independent of the relay and backend restart cycles.
 *
 * Raw data path (always immediate):
 *   daq_bridge → Elodin [0x20xx raw] → relay → backend → GUI
 * Calibrated path (~1 ms behind):
 *   calibration_service ─(subscribes)→ Elodin [0x20xx raw]
 *                       ─(publishes)→ Elodin [0x20xx+0x10 cal] → relay → backend → GUI
 *
 * Usage:
 *   ./calibration_service [--config PATH] [--elodin-host HOST] [--elodin-port PORT]
 *   CAL_VERBOSE=1 for per-packet debug output
 *   LP PT (non–HP board): default = factory cubic from CSV/JSON (same priority as letsfix / stable
 *   stack). RobustCalibrationManager still seeds from that factory curve and loads
 * adjustments.json; streaming uses factory unless you opt into robust below. CAL_USE_ROBUST_PT=1 —
 * 100% robust mean for streaming (when sensor initialized) CAL_USE_ROBUST_BLEND=1 — 75% robust +
 * 25% factory CAL_USE_FACTORY_PT=1 — force factory cubic (same as default; explicit)
 *   CAL_BACKUP_PATH — override robust prior JSON (else the latest calibration_backups/ JSON)
 */

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "calibration/CaptureWindow.hpp"
#include "calibration/CommandDedupe.hpp"
#include "calibration/CubicCalibrationStore.hpp"
#include "calibration/HpPtCode.hpp"
#include "calibration/LcTareStore.hpp"
#include "calibration/PTCalibration.hpp"
#include "calibration/PtSmoothing.hpp"
#include "calibration/RobustCalibrationManager.hpp"
#include "calibration/SensorCalibration.hpp"
#include "calibration/TypeK.hpp"
#include "calibration/ValvePosition.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "comms/messages/sensor/T7Messages.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "elodin/SubscriptionTracker.hpp"
#include "t7/T7Calibration.hpp"
#include "t7/T7Convert.hpp"
#include "t7/T7Stream.hpp"

namespace {

/**
 * Hysteresis: 0 = treat as below loop, 1 = in 4–20 mA band (stops 3.99↔4.01 PSI chatter).
 * Keyed by board slot so one board's channel going live cannot unlatch another board's
 * same-numbered channel.
 */
std::map<uint8_t, std::array<uint8_t, 11>> g_hp_ma_live;

/** Per-sensor PT output smoothing (ESP32 and T7), seeded with each sensor's first reading. */
fsw::calibration::PtSmoother g_pt_smoother;

/**
 * Which model a PT streams: operator/factory cubic, the robust learner, the 75/25 blend, or the
 * datasheet physics conversion (ratiometric for 0-5 V boards, 4-20 mA for current-loop). Chosen per
 * sensor from [calibration_model_<board>] in config.toml (see main); a CAL_USE_* env var, when set,
 * overrides all LP sensors via g_env_override.
 */
enum class PtModel { Cubic, Robust, Blend, Physics };

/** uid (board_id*100 + connector) -> streaming model. Non-default resolutions are stored (4-20 mA
 *  boards default to Physics, 0-5 V to Cubic); an absent uid means Cubic. */
std::unordered_map<uint16_t, PtModel> g_pt_model;

/** uid -> role name (from [sensor_roles_*]). Durable calibration is filed under the role, so it
 *  follows the sensor when its connector changes (see re-file-by-role in the stores). Empty for
 *  connectors with no configured role. */
std::unordered_map<uint16_t, std::string> g_uid_role;

/** Per-sensor physics-mode parameters (from [calibration_full_scale_*] /
 * [calibration_sense_resistor_*], falling back to the board defaults). full_scale is PSI at full
 * ADC / at 20 mA; sense_resistor Ω is the 4-20 mA shunt. Only present for uids the config/board
 * provides. */
std::unordered_map<uint16_t, double> g_pt_full_scale;
std::unordered_map<uint16_t, double> g_pt_sense_resistor;

/** Set once at startup: when a CAL_USE_* PT env var is present it forces every sensor, else nullopt
 *  and the per-sensor config governs. */
std::optional<PtModel> g_env_override;

/**
 * Which model an LC streams: a straight-line fit through the operator's captured points, a cubic
 * fit through them, or the datasheet physics conversion (sensitivity/PGA-gain formula). No
 * robust/blend — load cells don't need drift-learning. Chosen per sensor from
 * [calibration_model_<lc_board>] in config; absent from the map means Linear (see lc_model_for).
 *
 * Why linear is the default: a load cell is linear to a few hundredths of a percent, and its zero
 * drifts. A tare is taken as an ADC code and evaluated through the live curve, so on a line it
 * cancels a pure zero shift exactly, wherever the zero has wandered. A cubic fitted over 400-500k
 * and evaluated at a 200k zero extrapolates a full span past its data and bends, so the same tare
 * leaves a load-dependent error. Until a linear sensor has two captured points it streams physics
 * — exactly what an unconfigured LC streamed before this model existed — so a rig with no LC
 * captures reads the same as before.
 */
enum class LcModel { Linear, Cubic, Physics };

/** uid -> LC streaming model. A uid absent from this map defaults to Linear (see lc_model_for). */
std::unordered_map<uint16_t, LcModel> g_lc_model;

/** Per-sensor LC physics-mode parameters (from [calibration_full_scale_*] /
 * [calibration_sensitivity_*] / [calibration_pga_*], falling back to [calibration.lc] globals).
 * Only present for uids the config/board provides. */
std::unordered_map<uint16_t, double> g_lc_full_scale;
std::unordered_map<uint16_t, double> g_lc_sensitivity;
std::unordered_map<uint16_t, double> g_lc_pga_gain;

/** Every LC uid, populated at startup — the discriminant apply_capture/apply_clear/
 *  reload_live_store use to route a shared uid-keyed cubic_store entry to lc_calibration instead
 *  of pt_calibration/robust_manager (PT and LC uids share the store; their board_id ranges never
 *  collide, but nothing else tags which kind a uid is). */
std::set<uint16_t> g_lc_uids;
/** Board ids of every LC board, so a connector outside active_connectors still routes as LC. */
std::set<uint8_t> g_lc_board_ids;

/** Latest thermocouple cold-junction temperature (°C) per T7 slot, from t7_bridge's CJC table
 *  {0x26, (slot-1)*0x20 + 0x0F}. Absent until the first one arrives; a T7 TC sample with no
 *  junction yet is not published rather than converted against a guess. */
std::map<uint8_t, double> g_t7_cold_junction_c;

}  // namespace

static std::atomic<bool> running{true};

static bool verbose() {
    const char* v = std::getenv("CAL_VERBOSE");
    return v && (v[0] == '1' || v[0] == 'y' || v[0] == 'Y');
}

static bool env_flag_true(const char* name) {
    const char* v = std::getenv(name);
    return v && (v[0] == '1' || v[0] == 'y' || v[0] == 'Y' || v[0] == 't' || v[0] == 'T');
}

/** Parse a config model string to the enum; "cubic" and anything unrecognized map to Cubic. */
static PtModel parse_pt_model(const std::string& s) {
    if (s == "robust")
        return PtModel::Robust;
    if (s == "physics")
        return PtModel::Physics;
    if (s == "blend")
        return PtModel::Blend;
    return PtModel::Cubic;
}

/** Per-sensor streaming model; sensors absent from the map default to factory cubic. */
static PtModel pt_model_for(uint16_t uid) {
    auto it = g_pt_model.find(uid);
    return it == g_pt_model.end() ? PtModel::Cubic : it->second;
}

/** Per-sensor physics full-scale PSI; default 1000 (0-5 V -> 0-1000 PSI) when unset. */
static double pt_full_scale_for(uint16_t uid) {
    auto it = g_pt_full_scale.find(uid);
    return it != g_pt_full_scale.end() ? it->second : 1000.0;
}

/** Per-sensor 4-20 mA shunt resistance (Ω); default 120 when unset. */
static double pt_sense_resistor_for(uint16_t uid) {
    auto it = g_pt_sense_resistor.find(uid);
    return it != g_pt_sense_resistor.end() ? it->second : 120.0;
}

/** Config-string form of a model, for the cubic store's per-uid active_model tag. */
static const char* pt_model_name(PtModel m) {
    switch (m) {
        case PtModel::Robust:
            return "robust";
        case PtModel::Physics:
            return "physics";
        case PtModel::Blend:
            return "blend";
        default:
            return "cubic";
    }
}

/** Parse a config model string for an LC role: "linear" and "cubic" map to their fits, everything
 *  else (including unrecognized/"robust"/"blend", which LC doesn't support) maps to Physics, as
 *  it always has. */
static LcModel parse_lc_model(const std::string& s) {
    if (s == "linear")
        return LcModel::Linear;
    return s == "cubic" ? LcModel::Cubic : LcModel::Physics;
}

/** Per-sensor LC streaming model; a uid absent from g_lc_model defaults to Linear, which streams
 *  physics until it has a fit (see select_lc_kg), so an uncaptured LC reads as it always did. */
static LcModel lc_model_for(uint16_t uid) {
    auto it = g_lc_model.find(uid);
    return it == g_lc_model.end() ? LcModel::Linear : it->second;
}

/** True when this LC's published kilograms are its datasheet physics conversion: physics itself,
 *  or a linear sensor that has no fit yet. Such a reading is "calibrated" in the status sense. */
static bool lc_streams_physics(uint16_t uid, bool fit_ok) {
    const LcModel m = lc_model_for(uid);
    return m == LcModel::Physics || (m == LcModel::Linear && !fit_ok);
}

/** Per-sensor LC physics full-scale kg; falls back to the [calibration.lc] global when unset. */
static double lc_full_scale_for(uint16_t uid, double fallback) {
    auto it = g_lc_full_scale.find(uid);
    return it != g_lc_full_scale.end() ? it->second : fallback;
}

/** Per-sensor LC sensitivity mV/V; falls back to the [calibration.lc] global when unset. */
static double lc_sensitivity_for(uint16_t uid, double fallback) {
    auto it = g_lc_sensitivity.find(uid);
    return it != g_lc_sensitivity.end() ? it->second : fallback;
}

/** Per-sensor LC PGA gain; falls back to the [calibration.lc] global when unset. */
static double lc_pga_gain_for(uint16_t uid, double fallback) {
    auto it = g_lc_pga_gain.find(uid);
    return it != g_lc_pga_gain.end() ? it->second : fallback;
}

/** Config-string form of an LC model, for the cubic store's per-uid active_model tag. */
static const char* lc_model_name(LcModel m) {
    switch (m) {
        case LcModel::Linear:
            return "linear";
        case LcModel::Cubic:
            return "cubic";
        case LcModel::Physics:
        default:
            return "physics";
    }
}

/** Ratiometric PT, 0.5-4.5 V at 5 V excitation: excitation is the ADC reference, so the output
 *  is 10 % of full code at zero and 90 % at full scale whatever the supply actually is —
 *  psi = (adc / 2^31 - 0.1) / 0.8 * full_scale. Used by the `physics` model on non-loop boards.
 *  The bench calibrations of 2026-02 put four of the stand's PTs within ~1.5 % of this. */
constexpr double kRatiometricPtZeroFrac = 0.1;  // 0.5 V of 5 V
constexpr double kRatiometricPtSpanFrac = 0.8;  // 4.5 V - 0.5 V of 5 V
static double convert_ratiometric_pt_to_pressure(int32_t adc_raw, double full_scale_psi) {
    constexpr double ADC_MAX = 2147483648.0;  // 2^31
    if (!(full_scale_psi > 0.0))
        return 0.0;
    const double frac = static_cast<double>(adc_raw) / ADC_MAX;
    const double psi = (frac - kRatiometricPtZeroFrac) / kRatiometricPtSpanFrac * full_scale_psi;
    if (!std::isfinite(psi))
        return 0.0;
    return std::clamp(psi, -0.05 * full_scale_psi, full_scale_psi * 1.05);
}

/**
 * The single PT source-selection rule, shared by the streaming path and the Zero-All helper so both
 * agree. `physics` (the datasheet conversion — ratiometric or 4-20 mA per the board) is also the
 * universal fallback: a cubic/robust sensor that isn't yet fit/seeded streams physics rather than
 * 0. An env override (CAL_USE_*), when set, forces cubic/robust/blend across all sensors.
 */
static double select_pt_psi(uint16_t uid, double psi_fac, double psi_rob, double psi_phys,
                            bool fac_ok, bool has_robust) {
    const PtModel m = g_env_override ? *g_env_override : pt_model_for(uid);
    switch (m) {
        case PtModel::Physics:
            // Physics is a datasheet conversion, used only when explicitly selected.
            return psi_phys;
        case PtModel::Robust:
            // Robust streams its learned model; before any captured points its baseline is 0, so an
            // uncalibrated robust sensor reads nothing (0) rather than a physics fallback.
            return has_robust ? psi_rob : 0.0;
        case PtModel::Blend: {
            if (fac_ok && has_robust) {
                constexpr double kFactoryWeight = 0.25;  // 75% robust + 25% factory
                return (1.0 - kFactoryWeight) * psi_rob + kFactoryWeight * psi_fac;
            }
            return fac_ok ? psi_fac : (has_robust ? psi_rob : 0.0);
        }
        case PtModel::Cubic:
        default:
            // Uncalibrated / cleared cubic reads nothing (0) — no factory/physics fallback.
            return fac_ok ? psi_fac : 0.0;
    }
}

/**
 * The LC source-selection rule, mirroring select_pt_psi minus robust/blend (LC doesn't learn
 * drift). `kg_fit` / `fit_ok` are this uid's fitted curve — linear or cubic per its model, since
 * the store fits to the model's degree and that one curve is what lc_calibration holds. A cubic
 * uid with no fit reads 0, the "physics-or-nothing" rule PT's cubic mode uses once explicitly
 * opted in. A linear uid with no fit streams physics instead: linear is the default for every LC,
 * so it must read exactly what an unconfigured LC read before it existed.
 */
static double select_lc_kg(uint16_t uid, double kg_fit, double kg_phys, bool fit_ok) {
    switch (lc_model_for(uid)) {
        case LcModel::Linear:
            return fit_ok ? kg_fit : kg_phys;
        case LcModel::Cubic:
            return fit_ok ? kg_fit : 0.0;
        case LcModel::Physics:
        default:
            return kg_phys;
    }
}

/**
 * 4-20 mA HP PT → PSI. Wire raw is u32 full-scale to 2^31.
 *
 * A 4-20 mA transmitter regulates its loop current independently of its supply, so the reading is
 * absolute and needs no excitation reference — the shunt voltage against the internal 2.5 V ref is
 * the whole measurement. Optional per-channel mA hysteresis kills threshold flicker at ~4 mA
 * open-circuit noise.
 */
static double convert_hp_pt_to_pressure(uint8_t local_ch, uint32_t adc_raw,
                                        const fsw::config::PtBoardConfig& board,
                                        double full_scale_psi, double sense_resistor_ohms,
                                        std::array<uint8_t, 11>& live_state) {
    // full_scale_psi and sense_resistor_ohms are the per-sensor physics params (config override or
    // board default); the ADC reference is a board-level hardware property.
    const double adc_ref_voltage = board.adc_ref_voltage;

    constexpr double ADC_MAX = 2147483648.0;
    constexpr double I_MIN_MA = 4.0;
    constexpr double I_SPAN_MA = 16.0;
    // Hysteresis band (mA) — ~0.5% of span; widen with CAL_HP_MA_HYST=0 to disable (both 0).
    const char* hyst_env = std::getenv("CAL_HP_MA_HYST");
    const double hyst = (hyst_env && hyst_env[0] == '0' && hyst_env[1] == '\0') ? 0.0 : 0.08;
    const double i_on = I_MIN_MA + hyst;
    const double i_off = I_MIN_MA - std::min(hyst * 0.75, 0.06);

    if (local_ch < 1 || local_ch > 10)
        return 0.0;
    if (sense_resistor_ohms <= 0.0 || !std::isfinite(adc_ref_voltage))
        return 0.0;

    // Clamp to [0, 2^31-1] for voltage ratio (do not reject 2^31.. as hard zero).
    uint32_t adc = std::min(adc_raw, static_cast<uint32_t>(ADC_MAX) - 1u);

    double v_sense = (static_cast<double>(adc) / ADC_MAX) * adc_ref_voltage;

    double i_ma = (v_sense / sense_resistor_ohms) * 1000.0;
    if (!std::isfinite(v_sense) || !std::isfinite(i_ma))
        return 0.0;

    uint8_t& live = live_state[local_ch];
    if (hyst > 0.0) {
        if (!live) {
            if (i_ma < i_on)
                return 0.0;
            live = 1;
        } else {
            if (i_ma < i_off) {
                live = 0;
                return 0.0;
            }
        }
    } else {
        if (i_ma < I_MIN_MA)
            return 0.0;
    }

    if (i_ma > 20.0)
        i_ma = 20.0;
    i_ma = std::max(i_ma, I_MIN_MA);

    double psi = ((i_ma - I_MIN_MA) / I_SPAN_MA) * full_scale_psi;
    if (!std::isfinite(psi))
        return 0.0;
    return std::clamp(psi, 0.0, full_scale_psi * 1.05);
}

/**
 * K-type thermocouple: raw ADC → voltage → temperature (°C).
 * ITS-90 rational polynomial with 5 sub-ranges (-6.4 mV to 69.6 mV).
 * Coefficients from NIST ITS-90 Thermocouple Database (Type K inverse).
 * Each range: T = T0 + (x * num) / den, where x = V_mV - V0.
 */
static double convert_tc_adc_to_temp_c(int32_t adc_raw, double adc_ref_voltage) {
    constexpr double ADC_MAX = 2147483648.0;  // 2^31
    double voltage_v = (static_cast<double>(adc_raw) / ADC_MAX) * adc_ref_voltage;
    double v_mv = voltage_v * 1000.0;
    // The curve lives in lib (calibration/TypeK.hpp) so t7_bridge uses the same numbers. It
    // returns NaN out of range; this path has always published 0.0 there.
    const double t = fsw::calibration::type_k_c_from_mv(v_mv);
    return std::isfinite(t) ? t : 0.0;
}

/**
 * TC/RTD calibrated temperature before Elodin publish. Polynomial fits can diverge when raw ADC
 * is far off-scale (e.g. multi-million counts); thin backend rejects absurd temperature_c.
 */
static double clamp_tc_rtd_temp_publish_c(double t_c) {
    if (!std::isfinite(t_c))
        return 0.0;
    return std::clamp(t_c, -300.0, 2200.0);
}

/**
 * Pt1000 RTD: raw ADC → voltage → resistance → temperature (°C), on the full IEC 60751 curve
 * (rtd::rtd_board_adc_to_temp_c). NaN for an open or shorted element: publish nothing.
 */
static double convert_rtd_adc_to_temp_c(int32_t adc_raw, double adc_ref_voltage,
                                        double excitation_ua, double r0_ohm) {
    return fsw::calibration::rtd::rtd_board_adc_to_temp_c(adc_raw, adc_ref_voltage, excitation_ua,
                                                          r0_ohm);
}

/**
 * Actuator current-sense: 12-bit ADC → current (amps).
 * 3.3V reference, V-to-I transfer function = 1:1.
 */
static double convert_act_adc_to_current(uint32_t adc_raw) {
    constexpr double ADC_MAX_12BIT = 4095.0;
    constexpr double V_REF = 3.3;
    return (static_cast<double>(adc_raw) / ADC_MAX_12BIT) * V_REF;
}

/**
 * Ratiometric load cell: raw ADC → force (kg).
 * Reference = excitation, so voltage cancels: code_fs = (sensitivity * PGA_gain) * 2^31.
 * force = (code / code_fs) * full_scale_value.
 */
static double convert_lc_adc_to_force(int32_t adc_raw, double sensitivity_mv_per_v, double pga_gain,
                                      double full_scale_value) {
    constexpr double ADC_FULL_SCALE = 2147483648.0;  // 2^31
    if (pga_gain <= 0.0 || sensitivity_mv_per_v <= 0.0)
        return 0.0;
    double code_fs = (sensitivity_mv_per_v / 1000.0) * pga_gain * ADC_FULL_SCALE;
    if (code_fs <= 0.0)
        return 0.0;
    return (static_cast<double>(adc_raw) / code_fs) * full_scale_value;
}

static void signalHandler(int /*sig*/) {
    std::cout << "\n[CalibrationService] Caught signal, shutting down..." << std::endl;
    running = false;
}

/** Monotonic now, in ns. The capture window judges liveness on OUR clock and never the
 *  board's, so a board whose clock is skewed or has just reset cannot make a dead channel
 *  look live (or a live one look stale). */
/** Wall-clock unix seconds, for stamping a record a human will read. */
static double unix_now() {
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

static uint64_t mono_ns() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                     std::chrono::steady_clock::now().time_since_epoch())
                                     .count());
}

/**
 * Map Elodin PT raw packet low byte + connector ch → robust calibration uid (board_id*100+ch).
 * Uses the same slot rule as daq_bridge: slot = board_id % 10, with 0 treated as 10.
 */
static uint16_t resolve_pt_sensor_uid(uint8_t type_lo, uint8_t ch,
                                      const std::vector<fsw::elodin::BoardChannels>& pt_boards) {
    if (ch == 0 || ch > 10)
        return static_cast<uint16_t>(100u + ch);
    uint8_t bn_slot = 1;
    if (type_lo >= ch) {
        unsigned delta = static_cast<unsigned>(type_lo - ch);
        bn_slot = static_cast<uint8_t>(delta / 0x20u + 1u);
        if (bn_slot < 1)
            bn_slot = 1;
        if (bn_slot > 10)
            bn_slot = 10;
    }
    for (const auto& bc : pt_boards) {
        int mod = static_cast<int>(bc.board_id % 10);
        int slot = (mod == 0) ? 10 : mod;
        if (slot == static_cast<int>(bn_slot))
            return static_cast<uint16_t>(bc.board_id) * 100u + ch;
    }
    return static_cast<uint16_t>(100u + ch);
}

/**
 * Map Elodin LC raw packet low byte + connector ch -> LC uid (board_id*100+ch). Mirrors
 * resolve_pt_sensor_uid (kept as a separate copy rather than a shared/generalized helper so the
 * PT/abort-threshold path is untouched by this change).
 */
static uint16_t resolve_lc_sensor_uid(uint8_t type_lo, uint8_t ch,
                                      const std::vector<fsw::elodin::BoardChannels>& lc_boards) {
    if (ch == 0 || ch > 10)
        return static_cast<uint16_t>(100u + ch);
    uint8_t bn_slot = 1;
    if (type_lo >= ch) {
        unsigned delta = static_cast<unsigned>(type_lo - ch);
        bn_slot = static_cast<uint8_t>(delta / 0x20u + 1u);
        if (bn_slot < 1)
            bn_slot = 1;
        if (bn_slot > 10)
            bn_slot = 10;
    }
    for (const auto& bc : lc_boards) {
        int mod = static_cast<int>(bc.board_id % 10);
        int slot = (mod == 0) ? 10 : mod;
        if (slot == static_cast<int>(bn_slot))
            return static_cast<uint16_t>(bc.board_id) * 100u + ch;
    }
    return static_cast<uint16_t>(100u + ch);
}

/** A sensor needs at least this many captured points before its cubic/robust curve is trusted to
 *  invert an abort threshold. Below it, the fit is too loose — a 1-2 point cubic can invert to an
 *  ADC far from the intended pressure — so the abort threshold falls back to physics (the datasheet
 *  mapping), which is always monotonic and sane. See invert_abort_psi_to_adc /
 * write_abort_thresholds. */
constexpr int kMinAbortCalPoints = 3;

/**
 * Invert an abort-procedure pressure (the level the boards vent DOWN below before completing an
 * autonomous abort) to the raw ADC code the firmware compares against (dp.data < threshold_adc),
 * for uid's model, by bisecting the SAME forward conversion the stream uses — so the board's
 * "vented to safe" gate fires at exactly the pressure the operator configured on the curve they
 * see.
 *
 * force_physics forces the datasheet (ratiometric / 4-20 mA) mapping regardless of the sensor's
 * active model, used when the cubic/robust fit is too sparse to trust (see kMinAbortCalPoints).
 *
 * Monotonic increasing in adc for every model, so bisection is valid. Returns nullopt when the
 * target is unreachable in [0, 2^31) — e.g. an uncalibrated cubic whose forward is flat 0, or
 * full_scale 0 — so a sensor with no trustworthy mapping gets no threshold (the firmware then
 * relies on its PT_ABORT_THRESHOLD_TIMEOUT) rather than a wrong one.
 */
static std::optional<int32_t> invert_abort_psi_to_adc(
    uint16_t uid, uint8_t pt_log_ch, bool is_loop, const fsw::config::PtBoardConfig* loop_board,
    double target_psi, bool force_physics,
    const fsw::calibration::PTCalibrationManager& pt_calibration,
    fsw::calibration::RobustCalibrationManager& robust_manager) {
    if (!(target_psi > 0.0))
        return std::nullopt;
    const double full_scale = pt_full_scale_for(uid);
    const double sense_resistor = pt_sense_resistor_for(uid);
    const bool fac_ok = pt_calibration.is_calibrated(pt_log_ch);
    const bool has_rob = robust_manager.has_sensor(uid);
    auto forward = [&](int64_t adc) -> double {
        const int32_t a = static_cast<int32_t>(adc);
        std::array<uint8_t, 11> hyst{};  // fresh state → the static (unhysteresed) mapping
        const double psi_phys =
            is_loop && loop_board != nullptr
                ? convert_hp_pt_to_pressure(static_cast<uint8_t>(uid % 100),
                                            static_cast<uint32_t>(adc), *loop_board, full_scale,
                                            sense_resistor, hyst)
                : convert_ratiometric_pt_to_pressure(a, full_scale);
        if (force_physics)
            return psi_phys;
        const double psi_fac = fac_ok ? pt_calibration.calculate_pressure(pt_log_ch, a) : 0.0;
        const double psi_rob = robust_manager.predict_pressure_psi(uid, a);
        return select_pt_psi(uid, psi_fac, psi_rob, psi_phys, fac_ok, has_rob);
    };
    constexpr int64_t kAdcMax = 2147483647;  // 2^31 - 1
    if (forward(kAdcMax) < target_psi)
        return std::nullopt;  // unreachable: uncalibrated, or target above full scale
    if (forward(0) > target_psi)
        return std::nullopt;  // target below the sensor's zero — nothing to gate on
    int64_t lo = 0, hi = kAdcMax;
    for (int i = 0; i < 40 && hi - lo > 1; ++i) {
        const int64_t mid = lo + (hi - lo) / 2;
        if (forward(mid) < target_psi)
            lo = mid;
        else
            hi = mid;
    }
    return static_cast<int32_t>(hi);
}

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;
    std::string adjustments_path = "scripts/calibration/calibrations/adjustments.json";

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc)
            config_path = argv[++i];
        else if ((arg == "--host" || arg == "--elodin-host") && i + 1 < argc)
            elodin_host = argv[++i];
        else if ((arg == "--port" || arg == "--elodin-port") && i + 1 < argc)
            elodin_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        else if (arg == "--adjustments" && i + 1 < argc)
            adjustments_path = argv[++i];
        else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0]
                      << " [--config PATH] [--elodin-host HOST] [--elodin-port PORT]\n";
            return 0;
        }
    }

    // If the caller didn't explicitly pass an adjustments file, default to the latest
    // robust calibration backup so priors are always well-informed.
    const std::string default_adj = "scripts/calibration/calibrations/adjustments.json";
    if (adjustments_path == default_adj) {
        const char* env_override = std::getenv("CAL_BACKUP_PATH");
        if (env_override && env_override[0] != '\0') {
            adjustments_path = env_override;
        } else {
            const std::string backup_dir = "calibration_backups";
            std::string best_path;
            auto best_time = std::filesystem::file_time_type::min();
            try {
                for (const auto& entry : std::filesystem::directory_iterator(backup_dir)) {
                    if (!entry.is_regular_file())
                        continue;
                    const std::string name = entry.path().filename().string();
                    if (entry.path().extension() != ".json")
                        continue;
                    if (name.rfind("calibration_backup_", 0) != 0)
                        continue;
                    const auto t = entry.last_write_time();
                    if (t > best_time) {
                        best_time = t;
                        best_path = entry.path().string();
                    }
                }
            } catch (...) {
                // If directory doesn't exist, we'll fall back to the default adjustments.json.
            }
            if (!best_path.empty())
                adjustments_path = best_path;
        }
    }

    std::cout << "=== Calibration Service (C++) ===" << std::endl;
    std::cout << "  Elodin DB: " << elodin_host << ":" << elodin_port << std::endl;

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    // Parse config once (paths + [calibration.*] params + per-sensor models) before the loaders.
    const fsw::config::Config cal_cfg = fsw::config::load(config_path);
    auto or_default = [](const std::string& v, const char* d) {
        return v.empty() ? d : v;
    };

    // Load calibration coefficients
    // Physics-or-nothing baseline: PT cubics come ONLY from operator captures (the cubic store,
    // resumed below) or an explicit bench-cal import — never auto-loaded from a factory file. An
    // uncalibrated cubic/robust sensor streams 0. set_default_paths still sets the default CSV the
    // bench-cal import reads.
    fsw::calibration::PTCalibrationManager pt_calibration(/*auto_load=*/false);
    pt_calibration.set_default_paths(
        "scripts/calibration/calibrations",
        "firmware/PT_Board/Calibration/PT Calibration Attempt 2026-02-04_test2.csv");

    fsw::calibration::RobustCalibrationManager robust_manager;

    // json_dir + first csv_paths entry now come from [calibration.<type>] in config (was
    // hardcoded); empty keeps the historical default dir.
    fsw::calibration::SensorCalibrationManager tc_calibration("TC", "°C", 3);
    tc_calibration.load_calibration(
        or_default(cal_cfg.calibration.tc_json_dir, "scripts/calibration/calibrations/tc"),
        cal_cfg.calibration.tc_csv_path);

    fsw::calibration::SensorCalibrationManager rtd_calibration("RTD", "°C", 3);
    rtd_calibration.load_calibration(
        or_default(cal_cfg.calibration.rtd_json_dir, "scripts/calibration/calibrations/rtd"),
        cal_cfg.calibration.rtd_csv_path);

    fsw::calibration::SensorCalibrationManager lc_calibration("LC", "kg", 3);
    lc_calibration.load_calibration(
        or_default(cal_cfg.calibration.lc_json_dir, "scripts/calibration/calibrations/lc"),
        cal_cfg.calibration.lc_csv_path);

    std::cout << "[Calibration] PT:  physics-or-nothing baseline — cubics come from operator "
                 "captures / bench-cal import only (resumed from the cubic store below)"
              << std::endl;
    std::cout << "[Calibration] TC:  " << tc_calibration.calibrated_count() << " channels"
              << std::endl;
    std::cout << "[Calibration] RTD: " << rtd_calibration.calibrated_count() << " channels"
              << std::endl;
    std::cout << "[Calibration] LC:  " << lc_calibration.calibrated_count() << " channels"
              << std::endl;

    // Collect active boards with local channels for VTable registration (board-namespaced).
    // Shared with daq_bridge and sequencer_service so all three agree on which boards are live
    // and which Elodin slot each one owns.
    using BoardChannels = fsw::elodin::BoardChannels;
    auto active_boards = fsw::config::load_active_boards(config_path);
    auto boards_of = [&](fsw::config::ActiveBoardKind kind) {
        auto it = active_boards.find(kind);
        return it == active_boards.end() ? std::vector<BoardChannels>{} : it->second;
    };
    std::vector<BoardChannels> pt_boards = boards_of(fsw::config::ActiveBoardKind::PT);
    std::vector<BoardChannels> tc_boards = boards_of(fsw::config::ActiveBoardKind::TC);
    std::vector<BoardChannels> rtd_boards = boards_of(fsw::config::ActiveBoardKind::RTD);
    std::vector<BoardChannels> lc_boards = boards_of(fsw::config::ActiveBoardKind::LC);
    std::vector<BoardChannels> enc_boards = boards_of(fsw::config::ActiveBoardKind::ENCODER);
    std::vector<BoardChannels> act_boards = boards_of(fsw::config::ActiveBoardKind::ACTUATOR);
    std::vector<BoardChannels> bv_boards = boards_of(fsw::config::ActiveBoardKind::BALL_VALVE);

    // Per-PT-board sensor interface and 4-20 mA conversion parameters, keyed by Elodin slot.
    // board_simulator.py back-calculates i_ma from the target PSI and sends valid 4-20 mA ADC
    // codes for current-loop boards, so the 4-20 mA path is correct in sim and on hardware.
    const auto pt_board_configs = fsw::config::load_pt_boards(config_path);

    /** The board's 4-20 mA config, or nullptr when this slot is not a current-loop PT board. */
    auto current_loop_board = [&](uint8_t board_number) -> const fsw::config::PtBoardConfig* {
        auto it = pt_board_configs.find(board_number);
        if (it == pt_board_configs.end() || !fsw::config::is_current_loop(it->second))
            return nullptr;
        return &it->second;
    };

    for (const auto& [slot, board] : pt_board_configs) {
        if (!fsw::config::is_current_loop(board))
            continue;
        size_t channel_count = 0;
        for (const auto& bc : pt_boards)
            if (bc.board_number == slot)
                channel_count = bc.channels.size();
        std::cout << "[Calibration] HP PT slot " << static_cast<int>(slot) << " (board_id "
                  << static_cast<int>(board.board_id) << "): " << channel_count
                  << " channels (4-20 mA, " << board.full_scale_psi << " PSI full scale, "
                  << board.sense_resistor_ohms << " ohm shunt)" << std::endl;
    }

    // [calibration.tc/.rtd/.lc] default formula params, via fsw::config (toml++). cal_cfg parsed
    // above.
    const double tc_adc_ref_voltage = cal_cfg.calibration.tc_adc_ref_voltage;
    const double rtd_adc_ref_voltage = cal_cfg.calibration.rtd_adc_ref_voltage;
    const double rtd_excitation_ua = cal_cfg.calibration.rtd_excitation_ua;
    const double rtd_r0_ohm = cal_cfg.calibration.rtd_r0_ohm;  // Pt1000
    const double lc_sensitivity_mv_per_v = cal_cfg.calibration.lc_sensitivity_mv_per_v;
    const double lc_pga_gain = cal_cfg.calibration.lc_pga_gain;
    const double lc_full_scale_value = cal_cfg.calibration.lc_full_scale_value;  // kg
    std::cout << "[Calibration] TC default:  ITS-90 K-type, Vref=" << tc_adc_ref_voltage << "V"
              << std::endl;
    std::cout << "[Calibration] RTD default: CVD Pt" << (int)rtd_r0_ohm
              << ", Vref=" << rtd_adc_ref_voltage << "V, I=" << rtd_excitation_ua << "µA"
              << std::endl;
    std::cout << "[Calibration] LC default:  " << lc_sensitivity_mv_per_v
              << "mV/V, PGA=" << lc_pga_gain << ", FS=" << lc_full_scale_value << "kg" << std::endl;

    // ---- Per-sensor streaming model + physics params from config ----
    // [calibration_model_<board_key>] maps a PT role -> "cubic"|"robust"|"physics"|"blend"; resolve
    // it to the uid the streaming path uses (board_id*100 + connector) via
    // [sensor_roles_<board_key>]. Every PT (incl. 4-20 mA) participates: cubic/robust operate on
    // raw ADC and apply to all, while `physics` is the datasheet conversion (ratiometric or 4-20 mA
    // per board). Default by interface: 4-20 mA -> physics (today's behavior), 0-5 V -> cubic.
    // Physics params (full-scale, sense-resistor) come from
    // [calibration_full_scale_<board>]/[calibration_sense_resistor_<board>] else board defaults. A
    // CAL_USE_* env var overrides the model for every sensor (dev/testing).
    if (env_flag_true("CAL_USE_FACTORY_PT"))
        g_env_override = PtModel::Cubic;
    else if (env_flag_true("CAL_USE_ROBUST_BLEND"))
        g_env_override = PtModel::Blend;
    else if (env_flag_true("CAL_USE_ROBUST_PT"))
        g_env_override = PtModel::Robust;

    g_pt_model.clear();
    g_uid_role.clear();
    g_pt_full_scale.clear();
    g_pt_sense_resistor.clear();
    for (const auto& b : cal_cfg.boards) {
        if (b.type != "PT" || !b.enabled || b.board_id < 0)
            continue;
        const bool is_loop = b.has_hp_pt_keys || b.pt_type == "4-20 mA absolute";
        const std::string board_key =
            b.section.rfind("boards.", 0) == 0 ? b.section.substr(7) : b.section;
        const auto* roles = cal_cfg.sensor_roles_for("sensor_roles_" + board_key);
        if (roles == nullptr)
            continue;  // no role map -> connectors default to cubic (0-5 V) at the streaming site
        const auto* models = cal_cfg.calibration_model_for("calibration_model_" + board_key);
        const auto* full_scales = cal_cfg.full_scale_for("calibration_full_scale_" + board_key);
        const auto* resistors =
            cal_cfg.sense_resistor_for("calibration_sense_resistor_" + board_key);
        // Board-level physics defaults: 4-20 mA boards use their hp_pt_* params; a 0-5 V board maps
        // 0-5 V -> 0-1000 PSI unless a per-sensor full-scale overrides it.
        const double board_full_scale = is_loop ? b.hp_pt_full_scale_psi : 1000.0;
        const double board_resistor = b.hp_pt_sense_resistor_ohms;
        for (const auto& [role, connector] : *roles) {
            if (connector < 1 || connector > 99)
                continue;
            const uint16_t uid = static_cast<uint16_t>(b.board_id * 100 + connector);
            g_uid_role[uid] = role;  // the identity durable cal is filed under

            PtModel m = is_loop ? PtModel::Physics : PtModel::Cubic;  // interface-aware default
            if (models != nullptr) {
                auto it = models->find(role);
                if (it != models->end())
                    m = parse_pt_model(it->second);
            }
            if (m != PtModel::Cubic)  // Cubic is pt_model_for's default; store the rest
                g_pt_model[uid] = m;

            double fs = board_full_scale, rs = board_resistor;
            if (full_scales != nullptr) {
                auto it = full_scales->find(role);
                if (it != full_scales->end() && it->second > 0.0)
                    fs = it->second;
            }
            if (resistors != nullptr) {
                auto it = resistors->find(role);
                if (it != resistors->end() && it->second > 0.0)
                    rs = it->second;
            }
            g_pt_full_scale[uid] = fs;
            g_pt_sense_resistor[uid] = rs;
        }
    }

    // ---- Per-sensor LC streaming model + physics params from config (mirrors the PT block above,
    // minus robust/blend). A board with no [sensor_roles_<board>] section contributes no per-role
    // overrides here — its uids simply fall back to the [calibration.lc] globals at the streaming
    // site (lc_full_scale_for/lc_sensitivity_for/lc_pga_gain_for), same as every LC board today.
    g_lc_model.clear();
    g_lc_full_scale.clear();
    g_lc_sensitivity.clear();
    g_lc_pga_gain.clear();
    for (const auto& b : cal_cfg.boards) {
        if (b.type != "LC" || !b.enabled || b.board_id < 0)
            continue;
        const std::string board_key =
            b.section.rfind("boards.", 0) == 0 ? b.section.substr(7) : b.section;
        const auto* roles = cal_cfg.sensor_roles_for("sensor_roles_" + board_key);
        if (roles == nullptr)
            continue;  // no role map -> connectors default to linear (see lc_model_for)
        const auto* models = cal_cfg.calibration_model_for("calibration_model_" + board_key);
        const auto* full_scales = cal_cfg.full_scale_for("calibration_full_scale_" + board_key);
        const auto* sensitivities = cal_cfg.sensitivity_for("calibration_sensitivity_" + board_key);
        const auto* pga_gains = cal_cfg.pga_gain_for("calibration_pga_" + board_key);
        for (const auto& [role, connector] : *roles) {
            if (connector < 1 || connector > 99)
                continue;
            const uint16_t uid = static_cast<uint16_t>(b.board_id * 100 + connector);
            g_uid_role[uid] = role;  // shared with PT — role names are unique across the whole rig

            if (models != nullptr) {
                auto it = models->find(role);
                if (it != models->end())
                    g_lc_model[uid] = parse_lc_model(it->second);
            }
            if (full_scales != nullptr) {
                auto it = full_scales->find(role);
                if (it != full_scales->end() && it->second > 0.0)
                    g_lc_full_scale[uid] = it->second;
            }
            if (sensitivities != nullptr) {
                auto it = sensitivities->find(role);
                if (it != sensitivities->end() && it->second > 0.0)
                    g_lc_sensitivity[uid] = it->second;
            }
            if (pga_gains != nullptr) {
                auto it = pga_gains->find(role);
                if (it != pga_gains->end() && it->second > 0.0)
                    g_lc_pga_gain[uid] = it->second;
            }
        }
    }

    // ---- LabJack T7 inputs (t7_bridge) — the same PT / LC machinery, fed from a different place.
    // A T7 input is a uid (board_id*100 + AIN) with a role, a model and a store entry like any
    // ESP32 sensor; its "ADC code" is its reading in microvolts (t7::t7_counts), its logical
    // channel sits above the ESP32 range (t7::t7_logical_channel), and its physics conversion is
    // its channel row's datasheet numbers (t7/T7Convert.hpp). The model comes from
    // [calibration_model_<t7 board>] by role, as for an ESP32 board; with none given a T7 input
    // defaults to physics — it measures volts against the T7's own calibration, so the datasheet
    // conversion is already a real reading, exactly as for a 4-20 mA board.
    const fsw::t7::T7CalibrationMap t7_map(cal_cfg);
    if (!cal_cfg.t7_errors.empty())
        std::cerr << "[Calibration] T7: config has " << cal_cfg.t7_errors.size()
                  << " problem(s); t7_bridge will not stream, so no T7 input is calibrated"
                  << std::endl;
    for (const auto& t : t7_map.all()) {
        if (t.channel.kind != "PT" && t.channel.kind != "LC")
            continue;  // TC / RTD: physics only (no model to choose)
        g_uid_role[t.uid] = t.channel.role;
        std::optional<std::string> model;
        if (const auto* models =
                cal_cfg.calibration_model_for("calibration_model_" + t.board_key)) {
            auto it = models->find(t.channel.role);
            if (it != models->end())
                model = it->second;
        }
        if (t.channel.kind == "PT")
            g_pt_model[t.uid] = model ? parse_pt_model(*model) : PtModel::Physics;
        else if (model)
            g_lc_model[t.uid] = parse_lc_model(*model);  // absent = physics (lc_model_for)
    }
    std::cout << "[Calibration] T7: " << t7_map.all().size() << " input(s) on "
              << cal_cfg.t7_boards.size() << " board(s)" << std::endl;

    // Ordered uid->role for RobustCalibrationManager save/load, so the robust learned state is
    // filed by role and re-attaches to the role's current connector (mirrors the cubic store).
    // T7 inputs are left out: the robust file has no unit tag, and a role moving between an ESP32
    // board (ADC codes) and a T7 (µV) must not carry its learned state across. They are filed by
    // uid instead, which is stable for a given T7 and AIN.
    std::map<uint16_t, std::string> uid_role;
    for (const auto& [u, r] : g_uid_role)
        if (t7_map.by_uid(u) == nullptr)
            uid_role.emplace(u, r);

    // Robust is NOT factory-seeded here anymore. Its per-sensor baseline is the operator's shared
    // cubic fit, so it's initialized AFTER the cubic store loads (see below). A sensor with no
    // captured points gets a zero baseline and reads 0 until it learns from captures.

    // ---- Operator-built cubic PT calibration (see CubicCalibrationStore) ----
    // The store owns per-connector captured (adc, psi) points and the fitted cubic; it is the sole
    // source of PT cubics (there is no factory overlay). Captured points are shared: each capture
    // feeds both this cubic fit and the robust learner.
    fsw::calibration::CubicCalibrationStore cubic_store(
        "scripts/calibration/calibrations/cubic_calibration.json");
    // Load-cell tares: display-only offsets the backend subtracts on the way to the browser.
    // Deliberately NOT part of the cubic store — a tare is not a calibration point, and folding
    // one in as a captured zero would tilt the whole fit rather than shift its intercept.
    // Cleared by the backend at session start (while this service is down); survives a restart
    // inside a session. See LcTareStore.hpp.
    fsw::calibration::LcTareStore lc_tare_store("scripts/calibration/calibrations/lc_tare.json");
    // What a capture records. Bounded in TIME, not in samples: the old 128-sample ring was
    // sized for a 250 Hz PT and spanned 9.3 s on a 13.7 Hz load cell, so a capture taken
    // soon after a load change averaged the old load in. See CaptureWindow.hpp.
    fsw::calibration::CaptureWindow capture_window;
    for (const auto& bc : pt_boards) {
        for (uint8_t local_ch : bc.channels) {
            const uint16_t uid = static_cast<uint16_t>(bc.board_id) * 100u + local_ch;
            const uint8_t log_ch =
                fsw::calibration::pt_logical_calibration_channel(bc.board_number, local_ch);
            const auto rit = g_uid_role.find(uid);
            const std::string role = rit != g_uid_role.end() ? rit->second : std::string();
            cubic_store.register_channel(uid, bc.board_id, local_ch, log_ch, role,
                                         pt_model_name(pt_model_for(uid)),
                                         fsw::calibration::SensorKind::PT);
        }
    }

    // ---- Operator-built cubic LC calibration — registers into the SAME cubic_store as PT (uid
    // board_id ranges never collide), so /api/cubic_calibration, calibration-profile save/load, and
    // the seed-from-default mechanism all pick up LC channels for free. g_lc_uids is the
    // discriminant apply_capture/apply_clear/reload_live_store use to route a store entry to
    // lc_calibration instead of pt_calibration/robust_manager.
    g_lc_uids.clear();
    g_lc_board_ids.clear();
    for (const auto& bc : lc_boards) {
        g_lc_board_ids.insert(bc.board_id);
        for (uint8_t local_ch : bc.channels) {
            const uint16_t uid = static_cast<uint16_t>(bc.board_id) * 100u + local_ch;
            const uint8_t log_ch =
                fsw::calibration::pt_logical_calibration_channel(bc.board_number, local_ch);
            const auto rit = g_uid_role.find(uid);
            const std::string role = rit != g_uid_role.end() ? rit->second : std::string();
            g_lc_uids.insert(uid);
            cubic_store.register_channel(uid, bc.board_id, local_ch, log_ch, role,
                                         lc_model_name(lc_model_for(uid)),
                                         fsw::calibration::SensorKind::LC);
        }
    }

    // T7 PT / LC inputs: the same store, tagged as microvolt channels so a fit never crosses
    // between them and the ESP32 boards' ADC codes (CubicCalibrationStore::load).
    for (const auto& t : t7_map.all()) {
        const bool is_lc = t.channel.kind == "LC";
        if (t.channel.kind != "PT" && !is_lc)
            continue;
        if (is_lc)
            g_lc_uids.insert(t.uid);
        cubic_store.register_channel(
            t.uid, static_cast<uint8_t>(t.board_id), static_cast<uint8_t>(t.channel.ain),
            t.logical_ch, t.channel.role,
            is_lc ? lc_model_name(lc_model_for(t.uid)) : pt_model_name(pt_model_for(t.uid)),
            is_lc ? fsw::calibration::SensorKind::LC : fsw::calibration::SensorKind::PT,
            fsw::calibration::kRawUnitMicrovolts);
    }

    // ---- Unified capture/clear routing (see the [calibration_model_*] plan)
    // ---------------------- One capture path: the frontend sends {uid, ref}; the service routes by
    // the uid's configured model. Cubic/Blend -> record point + fit + apply to pt_calibration.
    // Robust -> record point for display + feed the RLS learner + refresh the sampled display
    // curve. Same split for clear.
    auto sample_robust_curve = [&](uint16_t uid) -> std::vector<std::pair<double, double>> {
        std::vector<std::pair<double, double>> curve;
        const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
        if (cch == nullptr || cch->points.empty())
            return curve;
        double amin = cch->points.front().adc, amax = amin;
        for (const auto& p : cch->points) {
            amin = std::min(amin, p.adc);
            amax = std::max(amax, p.adc);
        }
        if (!(amax > amin))
            amax = amin + 1.0;
        constexpr int kSamples = 40;
        curve.reserve(kSamples + 1);
        for (int i = 0; i <= kSamples; ++i) {
            const double adc = amin + (amax - amin) * i / kSamples;
            const double psi =
                robust_manager.predict_pressure_psi(uid, static_cast<int32_t>(std::llround(adc)));
            curve.emplace_back(adc, psi);
        }
        return curve;
    };
    // Shared points: every capture — regardless of the sensor's active model — feeds BOTH the cubic
    // fit and the robust learner, so switching a sensor's model later reuses the same points, and
    // the merged UI can preview all three curves. The robust display curve is refreshed for every
    // sensor that has points (not just robust ones).
    // Recompute the boards' abort-procedure "vent to safe" thresholds from the CURRENT calibration
    // and write them for config_broadcast to broadcast. Called at startup and after every capture /
    // clear / live profile swap, so a mid-session calibration updates the hardware threshold within
    // a broadcast cycle — no restart. Each abort PSI is inverted through the sensor's active model;
    // a sensor with fewer than kMinAbortCalPoints captured points falls back to physics so a sparse
    // fit can't emit a wildly wrong ADC, and one with no usable mapping is omitted (the firmware
    // then leans on PT_ABORT_THRESHOLD_TIMEOUT) rather than given a wrong gate.
    auto write_abort_thresholds = [&]() {
        const std::string out_path = "scripts/calibration/calibrations/abort_thresholds.txt";
        const long long now_unix = std::chrono::duration_cast<std::chrono::seconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count();
        std::ostringstream body;
        body << "# abort thresholds — one line per PT: uid  target_psi  raw_adc\n";
        body << "# regenerated on every capture/clear/reload. generated_unix " << now_unix << "\n";
        for (const auto& [role, target_psi] : cal_cfg.abort_pts) {
            uint16_t uid = 0;
            bool found = false;
            for (const auto& [u, r] : g_uid_role)
                if (r == role) {
                    uid = u;
                    found = true;
                    break;
                }
            if (!found) {
                std::cerr << "[Calibration] abort_pts \"" << role
                          << "\": no PT sensor_role declares this name — no threshold emitted"
                          << std::endl;
                continue;
            }
            if (t7_map.by_uid(uid) != nullptr) {
                // The threshold is an ADC code an ESP32 board compares its own reading against
                // while it vents autonomously; a T7 is not on that board, so it cannot gate it.
                std::cerr << "[Calibration] abort_pts \"" << role
                          << "\" is a LabJack T7 input — board abort thresholds can only use an "
                             "ESP32 PT; no threshold emitted"
                          << std::endl;
                continue;
            }
            const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
            if (cch == nullptr)
                continue;
            uint8_t board_number = static_cast<uint8_t>((uid / 100) % 10);
            if (board_number == 0)
                board_number = 10;
            const fsw::config::PtBoardConfig* loop_board = current_loop_board(board_number);
            const bool is_loop = loop_board != nullptr;
            const int npoints = static_cast<int>(cch->points.size());
            const PtModel model = g_env_override ? *g_env_override : pt_model_for(uid);
            // Physics-model sensors always use physics; cubic/robust/blend use their own curve only
            // with enough captured points to trust it, else fall back to physics.
            const bool sparse = (model != PtModel::Physics) && (npoints < kMinAbortCalPoints);
            std::optional<int32_t> adc =
                invert_abort_psi_to_adc(uid, cch->logical_ch, is_loop, loop_board, target_psi,
                                        /*force_physics=*/sparse, pt_calibration, robust_manager);
            // Model curve couldn't reach the target (bad fit) → fall back to physics; a datasheet
            // gate beats no gate.
            if (!adc && model != PtModel::Physics && !sparse)
                adc =
                    invert_abort_psi_to_adc(uid, cch->logical_ch, is_loop, loop_board, target_psi,
                                            /*force_physics=*/true, pt_calibration, robust_manager);
            if (!adc) {
                std::cerr << "[Calibration] abort_pts \"" << role << "\" (" << target_psi
                          << " psi): no usable mapping (full_scale 0?) — no threshold emitted"
                          << std::endl;
                continue;
            }
            if (sparse)
                std::cout << "[Calibration] abort_pts \"" << role << "\": only " << npoints
                          << " cal point(s) (<" << kMinAbortCalPoints
                          << ") — using physics threshold" << std::endl;
            body << uid << " " << target_psi << " " << static_cast<uint32_t>(*adc) << "\n";
        }
        const std::string tmp = out_path + ".tmp";
        {
            std::ofstream f(tmp, std::ios::trunc);
            f << body.str();
        }
        std::error_code ec;
        std::filesystem::rename(tmp, out_path, ec);
        if (ec)
            std::cerr << "[Calibration] abort_thresholds write failed: " << ec.message()
                      << std::endl;
    };

    auto apply_pt_capture = [&](uint16_t uid, double adc_avg, double ref) {
        const fsw::calibration::CubicFit fit = cubic_store.add_point(uid, adc_avg, ref);
        const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
        if (fit.valid && cch != nullptr)
            pt_calibration.set_calibration(
                cch->logical_ch, fsw::calibration::PTCalibrationCoeffs(fit.A, fit.B, fit.C, fit.D));
        robust_manager.update_calibration(uid, static_cast<int32_t>(std::llround(adc_avg)), ref);
        cubic_store.set_fit_curve(uid, sample_robust_curve(uid));
        cubic_store.save();
        // Persist robust learning on every capture (not only the 5-min auto-save / clean stop), so
        // a crash can't lose it.
        robust_manager.save_adjustments(adjustments_path, &uid_role);
        // This capture may have changed the sensor's curve → re-emit its abort threshold so the
        // boards' vent-to-safe gate tracks the new calibration within a broadcast cycle.
        write_abort_thresholds();
    };
    // adc -> kg exactly as the LC publish path computes it (see the 0x23 branch): the cubic fit
    // if this uid streams one, else the datasheet physics conversion. A tare offset is derived
    // through the SAME model selection the live sample goes through, so flipping a uid between
    // cubic and physics carries its tare correctly instead of being a fourth special case.
    auto lc_eval_for = [&](uint16_t uid) -> fsw::calibration::LcTareStore::Evaluator {
        return [&, uid](double adc) -> double {
            if (const fsw::t7::T7CalChannel* t = t7_map.by_uid(uid)) {
                // A T7 load cell: the code is µV; physics is its own channel's bridge numbers.
                const int32_t code = static_cast<int32_t>(adc);
                const bool cubic_ok = lc_calibration.is_calibrated(t->logical_ch);
                const double kg_cubic =
                    cubic_ok ? lc_calibration.calculate(t->logical_ch, code) : 0.0;
                const double kg_phys = fsw::t7::lc_kg(fsw::t7::t7_volts(adc), t->channel);
                return select_lc_kg(uid, kg_cubic, std::isfinite(kg_phys) ? kg_phys : 0.0,
                                    cubic_ok);
            }
            uint8_t board_number = static_cast<uint8_t>((uid / 100) % 10);
            if (board_number == 0)
                board_number = 10;
            const uint8_t connector = static_cast<uint8_t>(uid % 100);
            const uint8_t lc_log_ch =
                fsw::calibration::pt_logical_calibration_channel(board_number, connector);
            const int32_t code = static_cast<int32_t>(adc);
            const bool cubic_ok = lc_calibration.is_calibrated(lc_log_ch);
            const double kg_cubic = cubic_ok ? lc_calibration.calculate(lc_log_ch, code) : 0.0;
            const double kg_phys = convert_lc_adc_to_force(
                code, lc_sensitivity_for(uid, lc_sensitivity_mv_per_v),
                lc_pga_gain_for(uid, lc_pga_gain), lc_full_scale_for(uid, lc_full_scale_value));
            return select_lc_kg(uid, kg_cubic, kg_phys, cubic_ok);
        };
    };
    // Re-derive a standing tare's kilograms from the ADC code it was taken at. Called from EVERY
    // site that can change an LC curve; miss one and the stand carries an offset computed against
    // a curve that no longer exists — the "tank reads 2 kg after a better fit" bug.
    //
    // curves_trusted tracks the cubic store: if its file could not be read, every curve here is a
    // fallback, and persisting an offset derived from one would replace a good number with a
    // confident wrong one.
    auto recompute_tare = [&](uint16_t uid) {
        lc_tare_store.set_curves_trusted(!cubic_store.load_failed());
        lc_tare_store.recompute(uid, lc_eval_for(uid));
        lc_tare_store.save();
    };
    auto recompute_all_tares = [&]() {
        lc_tare_store.set_curves_trusted(!cubic_store.load_failed());
        lc_tare_store.recompute_all([&](uint16_t u) {
            return lc_eval_for(u);
        });
        lc_tare_store.save();
    };
    // LC capture: cubic fit only — no robust learner (LC doesn't need drift-learning) and no abort
    // thresholds (a PT-only concept; abort_pts names PT roles).
    auto apply_lc_capture = [&](uint16_t uid, double adc_avg, double ref) {
        const fsw::calibration::CubicFit fit = cubic_store.add_point(uid, adc_avg, ref);
        const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
        if (fit.valid && cch != nullptr)
            lc_calibration.set_calibration(cch->logical_ch, fsw::calibration::PolynomialCalibration(
                                                                fit.A, fit.B, fit.C, fit.D, "kg"));
        cubic_store.save();
        // The curve just moved under any standing tare on this channel.
        recompute_tare(uid);
    };
    // Every capture/clear is routed by uid kind (g_lc_uids), so cmd_type 0/3/4/5/6 in the
    // CalibrationCommand handler below work unchanged for both PT and LC uids.
    // One capture decision for every command that takes one (Zero, Zero-All, cmd 1, 3, 5).
    // Each used to open-code the same unbounded mean with its own last-value fallback; that
    // fallback is gone, because a capture that cannot be substantiated by fresh data must not
    // become a point on a live stand.
    auto take_capture = [&](uint16_t uid, const char* what) -> fsw::calibration::CaptureResult {
        const fsw::calibration::CaptureResult r = capture_window.capture(uid, mono_ns());
        if (!r.ok) {
            std::cout << "[Cal] " << what << " uid=" << static_cast<int>(uid) << " REJECTED ("
                      << r.reason << "): newest sample " << r.age_ms << "ms old, " << r.n
                      << " in last " << r.window_ms << "ms (limit " << r.max_age_ms << "ms)"
                      << std::endl;
        }
        return r;
    };
    // The fields that would have made the 2026-09-13 load-cell failure obvious at the time.
    auto capture_detail = [](const fsw::calibration::CaptureResult& r) {
        std::ostringstream o;
        o << "n=" << r.n << " span=" << r.span_ms << "ms age=" << r.age_ms << "ms adc=" << r.adc_avg
          << " spread=" << r.spread << " drift=" << r.drift << " z=" << r.drift_z
          << (r.settled ? "" : " UNSETTLED");
        return o.str();
    };

    // g_lc_uids only holds connectors in active_connectors, so an LC channel outside that list
    // used to fall through to the PT path and write a PT logical channel. The board id settles
    // the kind regardless of which connectors are declared.
    auto is_lc_uid = [&](uint16_t uid) {
        return g_lc_uids.count(uid) > 0 ||
               g_lc_board_ids.count(static_cast<uint8_t>(uid / 100)) > 0;
    };
    auto apply_capture = [&](uint16_t uid, double adc_avg, double ref) {
        if (is_lc_uid(uid))
            apply_lc_capture(uid, adc_avg, ref);
        else
            apply_pt_capture(uid, adc_avg, ref);
    };
    // Clear = back to nothing: drop the captured points, remove the operator cubic (so cubic reads
    // 0), and reset the robust learner (PT only). No factory/baseline revert.
    auto apply_pt_clear = [&](uint16_t uid) {
        const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
        // Only a LIVE channel's logical slot is its own to clear. An orphan (a disabled or
        // removed board, still listed on the calibration page because its points are kept) shares
        // its logical channel with whatever live board now owns that slot — so Clear on a dead
        // LC-41 row would wipe FT-PT-R's cubic. Drop the points; leave the live map alone.
        if (cch != nullptr && fsw::calibration::cal_target(*cch) == fsw::calibration::CalTarget::PT)
            pt_calibration.clear_calibration(cch->logical_ch);
        cubic_store.clear_channel(uid);
        robust_manager.reset_adjustment(uid);
        cubic_store.save();
        robust_manager.save_adjustments(adjustments_path, &uid_role);
        // Clearing drops the curve → re-emit (this sensor now falls back to physics or is omitted).
        write_abort_thresholds();
    };
    auto apply_lc_clear = [&](uint16_t uid) {
        const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
        // Live channels only — see apply_pt_clear.
        if (cch != nullptr && fsw::calibration::cal_target(*cch) == fsw::calibration::CalTarget::LC)
            lc_calibration.clear_calibration(cch->logical_ch);
        cubic_store.clear_channel(uid);
        cubic_store.save();
        // A cleared channel falls back to the physics conversion, which is a different curve.
        // The tare survives and re-derives through it, so the same load still reads zero.
        recompute_tare(uid);
    };
    auto apply_clear = [&](uint16_t uid) {
        if (is_lc_uid(uid))
            apply_lc_clear(uid);
        else
            apply_pt_clear(uid);
    };

    // Seed on first run: if the live store file is missing, copy the committed default (a curated,
    // version-controlled calibration snapshot) into place so a fresh checkout / new machine boots
    // with the team's calibration instead of an empty store. The live file is gitignored and
    // rewritten on every capture; cubic_calibration.default.json is the tracked source you promote
    // a known-good cal into (see scripts/calibration/promote_default.sh).
    {
        const std::filesystem::path live_path(
            "scripts/calibration/calibrations/cubic_calibration.json");
        const std::filesystem::path seed_path(
            "scripts/calibration/calibrations/cubic_calibration.default.json");
        std::error_code ec;
        if (!std::filesystem::exists(live_path, ec) && std::filesystem::exists(seed_path, ec)) {
            std::filesystem::copy_file(seed_path, live_path,
                                       std::filesystem::copy_options::overwrite_existing, ec);
            if (ec)
                std::cout << "[Calibration] Cubic: seed copy failed (" << ec.message() << ")"
                          << std::endl;
            else
                std::cout
                    << "[Calibration] Cubic: seeded live store from cubic_calibration.default.json"
                    << std::endl;
        }
    }

    // Load (or reload) the live cubic store from disk and re-apply it to the running stream: each
    // channel's fitted cubic → pt_calibration, and robust reseeded from that same cubic baseline.
    // Used at startup AND when a calibration profile is swapped live (cmd 7): the file on disk is
    // the source of truth, so re-reading it is all that's needed to switch the whole rig's cal.
    //   restore_learned=true  (startup): additionally restore the learned robust θ from
    //                                    adjustments.json on top of the cubic-seeded baseline.
    //   restore_learned=false (profile swap): reset + reseed robust from the profile only — the
    //                                    profile is the whole cal, so previously learned θ is
    //                                    dropped.
    auto reload_live_store = [&](bool restore_learned) -> size_t {
        const size_t loaded = cubic_store.load();
        for (uint16_t uid : cubic_store.uids()) {
            const fsw::calibration::CubicFit* fit = cubic_store.fit_for(uid);
            const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
            if (cch == nullptr)
                continue;
            // An ORPHAN — an entry whose board the running config no longer declares — has no
            // sensor streaming, and its logical channel belongs to whatever live board owns that
            // slot: disabled LC board 41's connectors 1/6/7 name PT board 21's logical 1/6/7.
            // Neither apply nor clear; its points stay on disk and re-attach by role when the
            // board comes back. See CubicChannel::live / cal_target().
            const fsw::calibration::CalTarget target = fsw::calibration::cal_target(*cch);
            if (target == fsw::calibration::CalTarget::None)
                continue;
            const bool fit_ok = fit != nullptr && fit->valid;
            if (target == fsw::calibration::CalTarget::LC) {
                // LC: cubic fit only, no robust baseline to reseed.
                if (fit_ok)
                    lc_calibration.set_calibration(cch->logical_ch,
                                                   fsw::calibration::PolynomialCalibration(
                                                       fit->A, fit->B, fit->C, fit->D, "kg"));
                else
                    lc_calibration.clear_calibration(cch->logical_ch);
                continue;
            }
            if (fit_ok)
                pt_calibration.set_calibration(
                    cch->logical_ch,
                    fsw::calibration::PTCalibrationCoeffs(fit->A, fit->B, fit->C, fit->D));
            else
                // No valid cubic (e.g. a blank profile) → clear any stale cubic so it reads 0.
                pt_calibration.clear_calibration(cch->logical_ch);
            const fsw::calibration::PTCalibrationCoeffs baseline =
                fit_ok ? fsw::calibration::PTCalibrationCoeffs(fit->A, fit->B, fit->C, fit->D)
                       : fsw::calibration::PTCalibrationCoeffs(0.0, 0.0, 0.0, 0.0);
            robust_manager.reseed_sensor(uid, baseline);
        }
        // Say out loud which entries did NOT reach the stream, and which live sensor each one
        // shadows. Silence here is what made 2026-11-09 take an afternoon: disabling LC board 41
        // left three PTs reading 0 psi and nothing in any log connected the two. An orphan is
        // normal (a board off for the day keeps its cal); an orphan sitting on a LIVE sensor's
        // logical channel is the thing to see at a glance.
        {
            std::map<uint8_t, std::string> live_logical;  // logical_ch -> "role (uid)"
            for (uint16_t uid : cubic_store.uids()) {
                const fsw::calibration::CubicChannel* c = cubic_store.channel(uid);
                if (c != nullptr && c->live)
                    live_logical[c->logical_ch] =
                        (c->role.empty() ? std::string("<no role>") : c->role) + " (uid " +
                        std::to_string(uid) + ")";
            }
            size_t orphans = 0;
            for (uint16_t uid : cubic_store.uids()) {
                const fsw::calibration::CubicChannel* c = cubic_store.channel(uid);
                if (c == nullptr || c->live)
                    continue;
                ++orphans;
                const auto hit = live_logical.find(c->logical_ch);
                if (hit == live_logical.end())
                    continue;
                std::cout << "[Calibration] Cubic: uid " << uid << " ('"
                          << (c->role.empty() ? "<no role>" : c->role) << "', board "
                          << static_cast<int>(c->board_id)
                          << " is not in the running config) sits on logical channel "
                          << static_cast<int>(c->logical_ch) << ", which belongs to " << hit->second
                          << " — its curve is NOT applied and does not touch that "
                             "sensor."
                          << std::endl;
            }
            if (orphans > 0)
                std::cout << "[Calibration] Cubic: " << orphans
                          << " entr(ies) kept for boards not in the running config (points "
                             "preserved; they re-attach by role when the board returns)."
                          << std::endl;
        }
        // Restore learned robust θ only on process start (not on a live profile swap).
        if (restore_learned)
            robust_manager.load_adjustments(adjustments_path, &uid_role);
        // Sample the robust preview curve for EVERY PT sensor that has points (not just robust
        // ones), so the merged UI can show "what robust would look like" before you switch to it.
        // LC has no robust display.
        for (uint16_t uid : cubic_store.uids()) {
            if (is_lc_uid(uid))
                continue;
            const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
            if (cch != nullptr && !cch->points.empty())
                cubic_store.set_fit_curve(uid, sample_robust_curve(uid));
        }
        // Whole-rig cal just (re)loaded — startup or a live profile swap (cmd 7). Emit the abort
        // thresholds from it so the boards' vent-to-safe gate matches the newly active calibration.
        write_abort_thresholds();
        // Every LC curve may have just changed, so every standing tare's kilograms are stale.
        // This is why the tare file is loaded BEFORE the first call to this lambda: recomputing
        // an empty map does nothing, and the stale offsets would then survive all session.
        recompute_all_tares();
        return loaded;
    };

    std::cout << "[Calibration] Robust adjustments path: " << adjustments_path << std::endl;
    std::cout << "[Calibration]   (override with --adjustments, CAL_BACKUP_PATH, or "
                 "calibration_backups/calibration_backup_*.json mtime)"
              << std::endl;
    // Resume standing tares BEFORE the live store reload below, not after.
    //
    // Ordering is load-bearing. reload_live_store() ends by recomputing every tare against the
    // curves it just applied; if the tare file were read after that call, the recompute would run
    // over an empty map and never happen. The case that bites is a calibration profile swapped on
    // disk while this service was down: the offsets on disk belong to the old curves, and without
    // the startup recompute a tared tank reads a wrong nonzero at rest with nothing to explain it.
    const size_t tares_loaded = lc_tare_store.load();
    if (tares_loaded > 0)
        std::cout << "[Calibration] LC tare: resumed " << tares_loaded
                  << " standing tare(s) from lc_tare.json" << std::endl;

    // Resume previously captured points + learned robust state from disk.
    const size_t cubic_loaded = reload_live_store(/*restore_learned=*/true);
    if (cubic_loaded > 0)
        std::cout << "[Calibration] Cubic: resumed " << cubic_loaded
                  << " channel(s) from cubic_calibration.json" << std::endl;
    // Audit, not a second recompute: by here every restored tare should already have been
    // re-derived by the reload above, so the expected answer is zero. A non-zero answer means a
    // curve moved without its recompute running — most likely this file was read after the
    // reload rather than before it — and the offsets it just fixed were being applied against a
    // curve that no longer exists. Self-healing, but never silently.
    {
        lc_tare_store.set_curves_trusted(!cubic_store.load_failed());
        const size_t stale = lc_tare_store.recompute_stale([&](uint16_t u) {
            return lc_eval_for(u);
        });
        if (stale > 0) {
            std::cout << "[Calibration] LC tare: WARNING — " << stale
                      << " tare(s) were stale against the live curves and have been re-derived. "
                         "A curve changed without recomputing its tare; check that lc_tare_store"
                         ".load() still runs BEFORE the first reload_live_store()."
                      << std::endl;
            lc_tare_store.save();
        }
    }
    // Always persist at startup so the record (with each channel's active_model) exists immediately
    // — the UI / cal_model_select read it before any capture.
    cubic_store.save();
    if (g_env_override) {
        const char* label = *g_env_override == PtModel::Cubic ? "factory cubic (CAL_USE_FACTORY_PT)"
                            : *g_env_override == PtModel::Blend
                                ? "75% robust + 25% factory (CAL_USE_ROBUST_BLEND)"
                                : "100% robust when initialized (CAL_USE_ROBUST_PT)";
        std::cout << "[Calibration] LP PT: env override — all sensors " << label << std::endl;
    } else {
        size_t robust_n = 0, blend_n = 0, physics_n = 0;
        for (const auto& [uid, m] : g_pt_model) {
            if (m == PtModel::Robust)
                ++robust_n;
            else if (m == PtModel::Blend)
                ++blend_n;
            else if (m == PtModel::Physics)
                ++physics_n;
        }
        std::cout
            << "[Calibration] PT: per-sensor model from config — default cubic (0-5 V) / physics "
               "(4-20 mA); "
            << robust_n << " robust, " << physics_n << " physics, " << blend_n << " blend"
            << std::endl;
        for (const auto& [uid, m] : g_pt_model)
            std::cout << "[Calibration]   uid " << uid << " -> " << pt_model_name(m) << std::endl;
    }
    {
        size_t lc_linear_n = 0, lc_cubic_n = 0, lc_physics_n = 0;
        for (uint16_t uid : g_lc_uids) {
            const LcModel m = lc_model_for(uid);
            (m == LcModel::Linear  ? lc_linear_n
             : m == LcModel::Cubic ? lc_cubic_n
                                   : lc_physics_n)++;
        }
        std::cout << "[Calibration] LC: per-sensor model from config — default linear (physics "
                     "until 2 points); "
                  << lc_linear_n << " linear, " << lc_cubic_n << " cubic, " << lc_physics_n
                  << " physics" << std::endl;
    }

    if (verbose())
        std::cout << "[Cal] CAL_VERBOSE=1 — debug output enabled" << std::endl;

    // Single ElodinClient for both subscribe (read) and publish (write)
    fsw::elodin::ElodinClient elodin_client;

    // Every table this service writes, and every raw table it calibrates (ball valves have their
    // own type_hi bytes, so they sit beside the six sensor kinds rather than among them; a LabJack
    // T7 is one more source, under 0x26).
    auto register_calibrated = [&]() {
        fsw::elodin::DatabaseConfig::register_calibrated_tables(
            elodin_client, pt_boards, tc_boards, rtd_boards, lc_boards, enc_boards, act_boards);
        if (!bv_boards.empty())
            fsw::elodin::DatabaseConfig::register_ball_valve_calibrated_tables(elodin_client,
                                                                               bv_boards);
        std::map<uint8_t, std::vector<fsw::elodin::DatabaseConfig::T7Table>> t7_by_slot;
        for (const auto& t : t7_map.all())
            t7_by_slot[t.slot].push_back(
                {static_cast<uint8_t>(t.channel.ain), fsw::t7::calibrated_field(t.channel.kind)});
        for (const auto& [slot, tables] : t7_by_slot)
            fsw::elodin::DatabaseConfig::register_t7_calibrated_tables(elodin_client, slot, tables);
    };
    // A T7's raw tables (inputs + each TC slot's cold junction) go through the same tracker as the
    // ESP32 ones: t7_bridge registers them when it connects, often after this service subscribed,
    // and a refused table is asked for again by name. Re-subscribing to a T7 merely because it
    // has gone quiet (an unplugged T7) would stack a second stream on a table the DB accepted.
    auto raw_tables = [&]() {
        auto t = fsw::elodin::raw_sensor_tables(pt_boards, act_boards, tc_boards, rtd_boards,
                                                lc_boards, enc_boards);
        const auto bv = fsw::elodin::ball_valve_raw_tables(bv_boards);
        t.insert(t.end(), bv.begin(), bv.end());
        const auto t7 = t7_map.raw_tables();
        t.insert(t.end(), t7.begin(), t7.end());
        return t;
    };

    // Every subscription goes out under its own request id, so a refusal (the DB answers a
    // subscription to a table nobody has registered yet with ErrorResponse) names the table to
    // ask for again. See SubscriptionTracker.hpp.
    fsw::elodin::SubscriptionTracker sub_tracker;
    auto subscribe_all = [&]() -> bool {
        sub_tracker.reset();
        auto tables = raw_tables();
        tables.push_back(fsw::elodin::kTableCalibrationCommand);
        bool ok = true;
        for (const auto& t : tables)
            ok = elodin_client.subscribe_table(t.first, t.second, sub_tracker.assign(t)) && ok;
        return ok;
    };

    auto connect_and_register = [&]() -> bool {
        if (!elodin_client.connect(elodin_host, elodin_port)) {
            std::cerr << "[Cal] Failed to connect to Elodin at " << elodin_host << ":"
                      << elodin_port << std::endl;
            return false;
        }
        register_calibrated();
        // The raw sensor tables this service calibrates, built from the boards actually in
        // config. This used to be subscribe_stream(), which guessed boards 1-8 x channels 1-10
        // and sent 481 subscribe messages regardless of the rig.
        if (!subscribe_all()) {
            std::cerr << "[Cal] Failed to subscribe to raw sensor tables / CalibrationCommand"
                      << std::endl;
            return false;
        }
        std::cout << "[Cal] Connected to Elodin, registered calibrated VTables, subscribed."
                  << std::endl;
        return true;
    };

    if (!connect_and_register())
        return 1;
    // Allow read_packet() to yield every 1 s so a refused subscription is asked for again (below)
    // on the tracker's 1 s retry even when nothing else is arriving.
    elodin_client.set_recv_timeout_ms(1000);

    // Generous, but not for the reason the previous comment claimed ("handles large Elodin
    // subscription-ACK bursts"). ACKs are 19-23 bytes and arrive one per read_packet() call, so
    // their number never mattered; the largest single packet on this stream is a ~179-byte VTable
    // definition. The size was really working around read_packet(), which used to corrupt the
    // connection permanently if any packet exceeded the buffer. That is fixed — an oversized
    // packet is now skipped — so this is ordinary headroom for VTables that grow.
    uint8_t pkt_buf[65536];
    int packet_count = 0;
    static std::atomic<bool> logged_ch5{false};
    auto last_save = std::chrono::steady_clock::now();
    std::map<uint16_t, int32_t> last_adc_map;
    // Every re-subscribe adds a copy of the command stream; handle each command once.
    fsw::calibration::CommandDedupe command_dedupe;

    while (running) {
        if (!elodin_client.is_connected()) {
            std::cerr << "[Cal] Elodin disconnected, retrying in 2s..." << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(2));
            if (elodin_client.reconnect()) {
                register_calibrated();
                subscribe_all();
                elodin_client.set_recv_timeout_ms(1000);
                // Samples either side of the gap are not a continuous record; averaging
                // across it would blend pre-disconnect codes into the next capture.
                capture_window.clear();
                last_adc_map.clear();
                std::cout << "[Cal] Reconnected to Elodin" << std::endl;
            }
            continue;
        }

        // A table the DB refused (its publisher had not registered it yet) is asked for again
        // until it is accepted; the refusal names it (SubscriptionTracker).
        //
        // Nothing else is re-sent. There used to be a fallback here that re-subscribed EVERY table
        // after 5 s with no packets, but elodin-db treats a second subscribe on one connection as
        // a second subscription and delivers the table twice: each firing stacked another copy of
        // every stream, the command table included, so after N firings each capture, zero and
        // tare was applied N+1 times (the stand re-subscribed 57 times in a quiet minute on
        // 2026-11-07). A quiet stream is quiet because its board is; the DB refuses a table that
        // does not exist yet, and a dropped connection resubscribes on reconnect above.
        {
            const auto now_s = std::chrono::steady_clock::now();
            for (const auto& t : sub_tracker.due(now_s))
                elodin_client.subscribe_table(t.first, t.second, sub_tracker.assign(t));
        }

        ssize_t pkt_len = elodin_client.read_packet(pkt_buf, sizeof(pkt_buf));
        if (pkt_len <= 0)
            continue;
        if (pkt_len < 8)
            continue;
        if (fsw::elodin::is_error_response(pkt_buf, static_cast<size_t>(pkt_len))) {
            const auto t = sub_tracker.rejected(pkt_buf[7], std::chrono::steady_clock::now());
            if (t.first != 0 || t.second != 0)
                std::cout << "[Cal] DB refused the subscription to [0x" << std::hex
                          << static_cast<int>(t.first) << ",0x" << static_cast<int>(t.second)
                          << std::dec << "] (not registered yet) — asking again" << std::endl;
            continue;
        }

        const uint8_t type_hi = pkt_buf[5];
        const uint8_t type_lo = pkt_buf[6];
        const uint8_t ty = pkt_buf[4];

        // Elodin TABLE packets can arrive with type 0 or 1 depending on stream path/version.
        if (ty != 0 && ty != 1)
            continue;

        // Only log first few ACTUAL sensor/command packets (skip registration ACKs with type_hi >=
        // 0x80)
        static int debug_limit = 0;
        if (debug_limit < 10 && type_hi < 0x80) {
            std::cout << "[Cal] Received packet ty=" << (int)ty << " id=[0x" << std::hex
                      << (int)type_hi << ",0x" << (int)type_lo << std::dec << "]"
                      << " pkt_len=" << pkt_len << std::endl;
            debug_limit++;
        }

        // Only process RAW sensor packets or Calibration Commands.
        if (type_hi == 0x46) {
            // CalibrationCommand: ts(8) | cmd(1)@8 | pad(1)@9 | sensor_id(2 LE)@10 | ref_f32(4)@12.
            // sensor_id is at even offset 10 so it is an aligned u16 in the Elodin VTable and its
            // high byte survives (uid = board_id*100+connector can exceed 255).
            if (pkt_len >= 8 + 16) {
                const uint8_t* p = pkt_buf + 8;
                if (command_dedupe.seen(p))
                    continue;  // the same command again, from a second subscription
                uint8_t cmd_type = p[8];
                uint16_t sensor_id =
                    static_cast<uint16_t>(p[10]) | (static_cast<uint16_t>(p[11]) << 8);
                // memcpy, not a `const float*` cast: p is pkt_buf + 8, so p + 12 inherits the
                // buffer's alignment and nothing guarantees it is 4-aligned (cppcheck
                // invalidPointerCast). Same instruction, defined behaviour.
                float ref_val;
                std::memcpy(&ref_val, p + 12, sizeof(ref_val));

                std::cout << "[Cal] Received CalibrationCommand: type=" << (int)cmd_type
                          << " sensor=" << static_cast<int>(sensor_id) << " ref=" << ref_val
                          << std::endl;

                if (cmd_type == 0) {  // Zero All — capture a 0 reference point on every PT + LC
                    // A "zero" is just a captured reference point at 0 (psi or kg): it feeds the
                    // same shared fit as any other capture, persists, and naturally averages
                    // repeated zeroes — capturing real zero-drift over time rather than assuming a
                    // uniform tare. Physics sensors are captured too: the point is stored, not
                    // applied.
                    int zeroed = 0;
                    if (sensor_id == 0) {  // All sensors
                        // Enumerate sensors that are actually SENDING, not every uid ever seen.
                        // Iterating a last-value map zeroed channels whose board had gone away,
                        // from codes of unbounded age.
                        std::vector<uint16_t> skipped;
                        for (uint16_t id : capture_window.uids()) {
                            // Physics sensors are captured too. The point does not change what
                            // physics streams — that stays the datasheet conversion — but it is
                            // recorded in the shared store, so a sensor can be calibrated while in
                            // physics mode and switched to cubic or robust afterwards with its
                            // points already there. Skipping them meant the only way to collect
                            // points was to change a sensor's mode first, mid-campaign.
                            const fsw::calibration::CaptureResult r = take_capture(id, "Zero All");
                            if (!r.ok) {
                                skipped.push_back(id);
                                continue;
                            }
                            apply_capture(id, r.adc_avg, 0.0);
                            ++zeroed;
                        }
                        std::cout << "[Cal] Zero All: captured 0 on " << zeroed << " PT/LC sensors";
                        if (!skipped.empty()) {
                            std::cout << "; skipped " << skipped.size() << " with no fresh data (";
                            for (size_t i = 0; i < skipped.size(); i++)
                                std::cout << (i ? " " : "") << static_cast<int>(skipped[i]);
                            std::cout << ")";
                        }
                        std::cout << std::endl;
                    } else {
                        const fsw::calibration::CaptureResult r = take_capture(sensor_id, "Zero");
                        if (r.ok) {
                            apply_capture(sensor_id, r.adc_avg, 0.0);
                            ++zeroed;
                        }
                        std::cout << "[Cal] Zero: captured 0 on uid " << static_cast<int>(sensor_id)
                                  << " (" << zeroed << ")" << std::endl;
                    }
                } else if (cmd_type == 1) {  // Capture Reference
                    // Through the same window as every other capture: this used to feed the
                    // robust learner one last-value sample of unbounded age.
                    const fsw::calibration::CaptureResult r =
                        take_capture(sensor_id, "Capture ref");
                    if (r.ok) {
                        robust_manager.update_calibration(sensor_id,
                                                          static_cast<int32_t>(r.adc_avg), ref_val);
                    }
                } else if (cmd_type == 2) {  // Save
                    robust_manager.save_adjustments(adjustments_path, &uid_role);
                    std::cout << "[Cal] Adjustments saved to " << adjustments_path << std::endl;
                } else if (cmd_type == 3) {  // Capture cubic point (operator-built factory cubic)
                    const fsw::calibration::CaptureResult cr =
                        take_capture(sensor_id, "Cubic capture");
                    const bool have_adc = cr.ok;
                    const double adc_avg = cr.adc_avg;
                    if (have_adc) {
                        // Legacy cubic capture is now a shared capture (feeds cubic + robust).
                        apply_capture(sensor_id, adc_avg, ref_val);
                        std::cout << "[Cal] Cubic capture uid=" << static_cast<int>(sensor_id)
                                  << " adc=" << adc_avg << " psi=" << ref_val << std::endl;
                    } else {
                        std::cout << "[Cal] Cubic capture: no ADC seen yet for uid "
                                  << static_cast<int>(sensor_id) << std::endl;
                    }
                } else if (cmd_type == 4) {  // Clear channel → nothing (no factory revert)
                    apply_clear(sensor_id);
                    std::cout << "[Cal] Cubic cleared uid=" << static_cast<int>(sensor_id)
                              << std::endl;
                } else if (cmd_type == 5) {  // Unified capture point — routed by configured model
                    const fsw::calibration::CaptureResult cr = take_capture(sensor_id, "Capture");
                    if (cr.ok) {
                        apply_capture(sensor_id, cr.adc_avg, ref_val);
                        // Recorded either way; `settled` is how the GUI flags a capture taken
                        // while the reading was still moving.
                        cubic_store.note_capture(sensor_id, fsw::calibration::CaptureQuality{
                                                                true, unix_now(), cr.adc_avg, cr.n,
                                                                cr.window_ms, cr.spread, cr.drift,
                                                                cr.drift_z, cr.settled});
                        std::cout << "[Cal] Capture uid=" << static_cast<int>(sensor_id) << " ("
                                  << pt_model_name(pt_model_for(sensor_id)) << ") "
                                  << capture_detail(cr) << " ref=" << ref_val << std::endl;
                    } else {
                        std::cout << "[Cal] Capture: no ADC seen yet for uid "
                                  << static_cast<int>(sensor_id) << std::endl;
                    }
                } else if (cmd_type == 6) {  // Unified new calibration / clear — routed by model
                    apply_clear(sensor_id);
                    std::cout << "[Cal] New calibration uid=" << static_cast<int>(sensor_id) << " ("
                              << pt_model_name(pt_model_for(sensor_id)) << ")" << std::endl;
                } else if (cmd_type == 7) {  // Reload live store — the backend swapped the cal file
                    // A calibration profile was loaded / a blank was created on disk by the
                    // backend; re-read the live store and re-apply it to the running stream (reset
                    // + reseed robust from the new profile). No session restart needed.
                    // The capture window is deliberately NOT cleared here: it holds raw ADC
                    // counts, which are calibration-independent, so dropping them would only
                    // make the next capture fail for no reason.
                    const size_t n = reload_live_store(/*restore_learned=*/false);
                    std::cout << "[Cal] Reloaded live calibration store (" << n
                              << " channel(s)) after profile swap" << std::endl;
                } else if (cmd_type == 8) {  // LC tare — display only, never touches the fit
                    // ref_val: 0 = set, 1 = clear. sensor_id 0 = every LC channel.
                    //
                    // A tare is NOT a captured zero, and this is the one command where that
                    // distinction is the whole point. Zero-All (cmd 0) records a real 0 kg
                    // reference point into the shared fit, which is correct for a vented PT and
                    // wrong for a load cell holding a tank: that tank is not at 0 kg, so the
                    // point would be false and, because the fit is least-squares over every
                    // point, it would tilt the whole cubic rather than shift its intercept.
                    const bool clearing = ref_val >= 0.5f;
                    std::vector<uint16_t> targets;
                    if (sensor_id == 0) {
                        if (clearing) {
                            targets = lc_tare_store.uids();
                        } else {
                            // Only channels actually streaming can be tared — same rule Zero-All
                            // uses. A uid in a last-value map may have had its board go away.
                            for (uint16_t id : capture_window.uids())
                                if (is_lc_uid(id))
                                    targets.push_back(id);
                        }
                    } else if (is_lc_uid(sensor_id)) {
                        targets.push_back(sensor_id);
                    } else {
                        std::cout << "[Cal] Tare: uid " << static_cast<int>(sensor_id)
                                  << " is not a load cell — ignored" << std::endl;
                    }

                    size_t done = 0;
                    for (uint16_t id : targets) {
                        if (clearing) {
                            lc_tare_store.clear(id);
                            ++done;
                            continue;
                        }
                        // Through the capture window, never last_adc_map: a tare taken from a
                        // stale code silently biases every reading on the channel for the rest
                        // of the run, which is the same failure take_capture exists to refuse.
                        const fsw::calibration::CaptureResult r = take_capture(id, "Tare");
                        if (!r.ok)
                            continue;
                        const uint8_t board_id = static_cast<uint8_t>(id / 100);
                        const uint8_t connector = static_cast<uint8_t>(id % 100);
                        // Keyed by the calibrated entity this service publishes, which the backend
                        // subtracts the offset from: LC<slot>_Cal.CH<n>, or T7<slot>_Cal.AIN<n>.
                        const fsw::t7::T7CalChannel* t7 = t7_map.by_uid(id);
                        const std::string entity =
                            t7 != nullptr ? fsw::t7::calibrated_entity_name(
                                                t7->slot, static_cast<uint8_t>(t7->channel.ain))
                                          : fsw::calibration::lc_tare_entity(board_id, connector);
                        if (lc_tare_store.set(id, entity, r.adc_avg, lc_eval_for(id))) {
                            ++done;
                            const fsw::calibration::LcTare* t = lc_tare_store.tare_for(id);
                            std::cout << "[Cal] Tare uid=" << static_cast<int>(id) << " "
                                      << capture_detail(r)
                                      << " offset=" << (t != nullptr ? t->offset_kg : 0.0) << "kg"
                                      << std::endl;
                        }
                    }
                    lc_tare_store.save();
                    std::cout << "[Cal] " << (clearing ? "Tare clear" : "Tare") << ": " << done
                              << " load cell(s)" << std::endl;
                }
            }
            continue;
        }

        // ── LabJack T7 raw (t7_bridge) ─────────────────────────────────────────────────────────
        // The same model selection, capture window and outputs as the ESP32 PT / LC / TC branches
        // below; what differs is only the input: a float in volts, turned into a µV code.
        if (type_hi == fsw::t7::kTypeHi) {
            const uint8_t offset = type_lo & 0x1F;
            if (offset >= 0x10 || pkt_len - 8 < 21)
                continue;  // >= 0x10 is our own calibrated output
            const uint8_t* p = pkt_buf + 8;
            uint64_t ts_ns = 0;
            float volts_f = 0.0f;
            std::memcpy(&ts_ns, p, sizeof(ts_ns));
            std::memcpy(&volts_f, p + 12, sizeof(volts_f));
            const uint64_t rx_ns = mono_ns();
            const uint8_t slot = static_cast<uint8_t>((type_lo >> 5) + 1);
            if (!std::isfinite(volts_f))
                continue;
            if (offset == fsw::t7::kCjcTableOffset) {
                g_t7_cold_junction_c[slot] = volts_f;  // this table's float is °C
                continue;
            }
            const fsw::t7::T7CalChannel* t = t7_map.by_table(slot, offset);
            if (t == nullptr)
                continue;
            const double volts = volts_f;
            const int32_t code = fsw::t7::t7_counts(volts);
            const uint16_t uid = t->uid;
            const uint8_t ain = static_cast<uint8_t>(t->channel.ain);
            const auto out_id = fsw::t7::calibrated_table_id(slot, ain);
            auto publish = [&](double value, uint8_t cal_status) {
                comms::messages::sensor::T7CalibratedMessage msg(
                    ts_ns, ain, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(value), code,
                    cal_status);
                elodin_client.publish(out_id, msg);
            };

            elodin_client.begin_batch();
            if (t->channel.kind == "PT") {
                last_adc_map[uid] = code;
                capture_window.push(uid, code, ts_ns, rx_ns);
                const bool fac_ok = pt_calibration.is_calibrated(t->logical_ch);
                const double psi_fac =
                    fac_ok ? pt_calibration.calculate_pressure(t->logical_ch, code) : 0.0;
                const double psi_rob = robust_manager.predict_pressure_psi(uid, code);
                double psi_phys = fsw::t7::pt_psi(volts, t->channel);
                if (!std::isfinite(psi_phys))
                    psi_phys = 0.0;
                const bool has_rob = robust_manager.has_sensor(uid);
                double psi = select_pt_psi(uid, psi_fac, psi_rob, psi_phys, fac_ok, has_rob);
                const PtModel eff_model = g_env_override ? *g_env_override : pt_model_for(uid);
                uint8_t cal_status = 1;
                if (eff_model == PtModel::Cubic)
                    cal_status = fac_ok ? 1u : 0u;
                else if (eff_model == PtModel::Robust)
                    cal_status = has_rob ? 1u : 0u;
                else if (eff_model == PtModel::Blend)
                    cal_status = (fac_ok && has_rob) ? 1u : 0u;
                psi = g_pt_smoother.step(uid, psi);
                psi = std::isfinite(psi) ? std::clamp(psi, -3000.0, 20000.0) : 0.0;
                publish(psi, cal_status);
            } else if (t->channel.kind == "LC") {
                last_adc_map[uid] = code;
                capture_window.push(uid, code, ts_ns, rx_ns);
                const bool cubic_ok = lc_calibration.is_calibrated(t->logical_ch);
                const double kg_cubic =
                    cubic_ok ? lc_calibration.calculate(t->logical_ch, code) : 0.0;
                double kg_phys = fsw::t7::lc_kg(volts, t->channel);
                if (!std::isfinite(kg_phys))
                    kg_phys = 0.0;
                double kg = select_lc_kg(uid, kg_cubic, kg_phys, cubic_ok);
                const uint8_t cal_status =
                    lc_model_for(uid) == LcModel::Physics ? 1u : (cubic_ok ? 1u : 0u);
                publish(std::isfinite(kg) ? kg : 0.0, cal_status);
            } else if (t->channel.kind == "TC") {
                const auto cj = g_t7_cold_junction_c.find(slot);
                const double temp_c = cj != g_t7_cold_junction_c.end()
                                          ? fsw::t7::tc_c(volts, cj->second)
                                          : std::numeric_limits<double>::quiet_NaN();
                if (std::isfinite(temp_c))
                    publish(clamp_tc_rtd_temp_publish_c(temp_c), 1);
            } else if (t->channel.kind == "RTD") {
                // Physics only, as a T7 TC: the LJTick-Resistance divider and the IEC 60751 curve.
                const double temp_c = fsw::t7::rtd_c(volts, t->channel);
                if (std::isfinite(temp_c))
                    publish(clamp_tc_rtd_temp_publish_c(temp_c), 1);
            }
            elodin_client.flush_batch();
            packet_count++;
            continue;
        }

        if ((type_hi < 0x20 || type_hi > 0x24) && type_hi != 0x30 &&
            type_hi != fsw::elodin::kBallValveRawHi)
            continue;
        // Within each 32-slot block: raw = offset 0x01-0x0A, cal = offset 0x11-0x1A
        // Check if this is a calibrated packet (our own output) by testing if
        // the offset within the block is >= 0x10
        uint8_t block_offset = type_lo & 0x1F;  // position within 32-slot block
        if (type_hi != 0x30) {
            if (block_offset >= 0x10)
                continue;  // calibrated packet (our own output)
            if (block_offset == 0 || block_offset > 10)
                continue;  // channel must be 1-10
        } else {
            // ACT raw 0x30 only: our calibrated republish uses type_hi 0x31, so 0x30 is never our
            // echo. Allow 0x0B–0x0F (wire indices 11–15) which the old `> 10` guard dropped;
            // decodeLow uses (block_offset & 0x0F) for the logical channel nibble.
            if (block_offset == 0 || block_offset > 0x0F)
                continue;
        }

        const ssize_t payload_len = pkt_len - 8;
        if (payload_len < 21) {
            if (debug_limit < 20) {
                std::cout << "[Cal] Dropped small payload: " << payload_len << std::endl;
                debug_limit++;
            }
            continue;
        }

        // Parse 21-byte raw sensor payload directly (ADS1262 etc. use signed 32-bit codes at +12)
        const uint8_t* p = pkt_buf + 8;
        const uint64_t ts_ns = *reinterpret_cast<const uint64_t*>(p);
        // Arrival on our own monotonic clock, read once per packet: ts_ns says how samples
        // are SPACED, rx_ns says whether the sensor is still talking to us.
        const uint64_t rx_ns = mono_ns();
        const uint8_t ch_payload = p[8];
        const uint8_t ch_eff = block_offset;
        if (ch_payload != ch_eff && type_hi == 0x20) {
            static int ch_mismatch_warn = 0;
            if (ch_mismatch_warn < 8) {
                std::cerr << "[Cal] WARN: PT payload ch=" << static_cast<int>(ch_payload)
                          << " != packet-id ch=" << static_cast<int>(ch_eff) << " [0x" << std::hex
                          << static_cast<int>(type_hi) << "," << static_cast<int>(type_lo)
                          << std::dec << "]" << std::endl;
                ch_mismatch_warn++;
            }
        }
        const int32_t adc_i32 = *reinterpret_cast<const int32_t*>(p + 12);
        const uint32_t adc_u32 = *reinterpret_cast<const uint32_t*>(p + 12);
        // p[16-19] = sample_timestamp_ms (unused in calibration output)
        // p[20]    = status_flags        (unused in calibration output)

        // Board-namespaced: raw low byte = (board_number-1)*0x20 + channel
        // Calibrated = raw_lo + 0x10 (within same 32-slot block)
        uint8_t cal_lo = static_cast<uint8_t>(type_lo + 0x10);
        uint8_t board_number = static_cast<uint8_t>((type_lo >> 5) + 1);

        elodin_client.begin_batch();

        if (type_hi == 0x20) {  // PT raw — unified: every PT runs through model selection.
            const fsw::config::PtBoardConfig* loop_board = current_loop_board(board_number);
            const bool is_loop = loop_board != nullptr;
            const uint16_t uid = resolve_pt_sensor_uid(type_lo, ch_eff, pt_boards);

            // The ADC cubic/robust and captures work in: for a 4-20 mA board, the shunt code with a
            // negative reading (an open loop's noise below 0 V) taken as no current -- never as
            // full scale (see HpPtCode.hpp); else the raw i32.
            const uint32_t hp_wire_adc = is_loop ? fsw::calibration::hp_pt_shunt_code(adc_u32) : 0u;
            const int32_t cal_adc = is_loop ? static_cast<int32_t>(hp_wire_adc) : adc_i32;

            last_adc_map[uid] = cal_adc;
            capture_window.push(uid, cal_adc, ts_ns, rx_ns);

            const uint8_t pt_log_ch =
                fsw::calibration::pt_logical_calibration_channel(board_number, ch_eff);
            const bool fac_ok = pt_calibration.is_calibrated(pt_log_ch);
            const double psi_fac =
                fac_ok ? pt_calibration.calculate_pressure(pt_log_ch, cal_adc) : 0.0;
            const double psi_rob = robust_manager.predict_pressure_psi(uid, cal_adc);
            const double psi_phys =
                is_loop
                    ? convert_hp_pt_to_pressure(ch_eff, hp_wire_adc, *loop_board,
                                                pt_full_scale_for(uid), pt_sense_resistor_for(uid),
                                                g_hp_ma_live[board_number])
                    : convert_ratiometric_pt_to_pressure(adc_i32, pt_full_scale_for(uid));
            const bool has_rob = robust_manager.has_sensor(uid);

            double psi = select_pt_psi(uid, psi_fac, psi_rob, psi_phys, fac_ok, has_rob);

            // cal_status: 1 when the selected model's own source is ready (physics always); 0 means
            // it fell back to physics because the chosen cubic/robust model isn't calibrated yet.
            const PtModel eff_model = g_env_override ? *g_env_override : pt_model_for(uid);
            uint8_t cal_status = 1;
            if (eff_model == PtModel::Cubic)
                cal_status = fac_ok ? 1u : 0u;
            else if (eff_model == PtModel::Robust)
                cal_status = has_rob ? 1u : 0u;
            else if (eff_model == PtModel::Blend)
                cal_status = (fac_ok && has_rob) ? 1u : 0u;

            // EMA smoothing (zeroing is now a captured 0 psi point that flows through the fit
            // above, not a post-hoc offset).
            psi = g_pt_smoother.step(uid, psi);
            if (verbose() && packet_count % 100 == 0)
                std::cout << "[Cal] PT B" << static_cast<int>(board_number) << " ch"
                          << static_cast<int>(ch_eff) << (is_loop ? " (4-20mA)" : "")
                          << " adc=" << cal_adc << " psi=" << psi << std::endl;

            if (!std::isfinite(psi))
                psi = 0.0;
            else if (is_loop)
                psi = std::clamp(psi, 0.0, pt_full_scale_for(uid) * 1.2);
            else
                psi = std::clamp(psi, -3000.0, 20000.0);

            comms::messages::sensor::CalibratedPTMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(psi),
                is_loop ? adc_u32 : static_cast<uint32_t>(adc_i32), cal_status);
            elodin_client.publish(static_cast<uint16_t>((type_hi << 8) | cal_lo), cal_msg);

        } else if (type_hi == 0x21) {  // TC raw
            double temp_c;
            uint8_t cal_status;
            if (tc_calibration.is_calibrated(ch_eff)) {
                temp_c = tc_calibration.calculate(ch_eff, adc_i32);
                cal_status = 1;
            } else {
                temp_c = convert_tc_adc_to_temp_c(adc_i32, tc_adc_ref_voltage);
                cal_status = 0;
            }
            temp_c = clamp_tc_rtd_temp_publish_c(temp_c);
            comms::messages::sensor::CalibratedTCMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(temp_c),
                static_cast<uint32_t>(adc_i32), cal_status);
            elodin_client.publish(static_cast<uint16_t>((type_hi << 8) | cal_lo), cal_msg);

        } else if (type_hi == 0x22) {  // RTD raw
            double temp_c;
            uint8_t cal_status;
            if (rtd_calibration.is_calibrated(ch_eff)) {
                temp_c = rtd_calibration.calculate(ch_eff, adc_i32);
                cal_status = 1;
            } else {
                temp_c = convert_rtd_adc_to_temp_c(adc_i32, rtd_adc_ref_voltage, rtd_excitation_ua,
                                                   rtd_r0_ohm);
                cal_status = 0;
            }
            // An open or shorted element has no temperature. It used to publish one anyway: about
            // +395 C (open, ADC at the rail) or -242 C (short). Now the channel goes quiet and the
            // GUI shows it stale.
            if (std::isfinite(temp_c)) {
                temp_c = clamp_tc_rtd_temp_publish_c(temp_c);
                comms::messages::sensor::CalibratedRTDMessage cal_msg(
                    ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(temp_c),
                    static_cast<uint32_t>(adc_i32), cal_status);
                elodin_client.publish(static_cast<uint16_t>((type_hi << 8) | cal_lo), cal_msg);
            }

        } else if (type_hi == 0x23) {  // LC raw — unified: every LC runs through model selection
                                       // (cubic operator fit, or the datasheet physics formula).
            const uint16_t uid = resolve_lc_sensor_uid(type_lo, ch_eff, lc_boards);

            last_adc_map[uid] = adc_i32;
            capture_window.push(uid, adc_i32, ts_ns, rx_ns);

            const uint8_t lc_log_ch =
                fsw::calibration::pt_logical_calibration_channel(board_number, ch_eff);
            const bool cubic_ok = lc_calibration.is_calibrated(lc_log_ch);
            const double kg_cubic = cubic_ok ? lc_calibration.calculate(lc_log_ch, adc_i32) : 0.0;
            const double kg_phys = convert_lc_adc_to_force(
                adc_i32, lc_sensitivity_for(uid, lc_sensitivity_mv_per_v),
                lc_pga_gain_for(uid, lc_pga_gain), lc_full_scale_for(uid, lc_full_scale_value));

            double force_kg = select_lc_kg(uid, kg_cubic, kg_phys, cubic_ok);
            const uint8_t cal_status =
                lc_streams_physics(uid, cubic_ok) ? 1u : (cubic_ok ? 1u : 0u);
            if (!std::isfinite(force_kg))
                force_kg = 0.0;

            comms::messages::sensor::CalibratedLCMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(force_kg),
                static_cast<uint32_t>(adc_i32), cal_status);
            elodin_client.publish(static_cast<uint16_t>((type_hi << 8) | cal_lo), cal_msg);

        } else if (type_hi == 0x30) {  // Actuator raw current-sense (12-bit ADC)
            double current_a = convert_act_adc_to_current(adc_u32);
            uint8_t cal_status = 1;
            // ACT calibrated VTable registered under 0x31 (to avoid collision with raw 0x30)
            comms::messages::sensor::CalibratedACTMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(current_a),
                adc_u32, cal_status);
            elodin_client.publish(static_cast<uint16_t>((0x31 << 8) | cal_lo), cal_msg);
        } else if (type_hi == fsw::elodin::kBallValveRawHi) {  // Ball valve position (4-20 mA)
            const auto pos = fsw::calibration::valve_position::from_counts(adc_u32);
            comms::messages::sensor::CalibratedValvePositionMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, pos.percent_open, adc_u32,
                pos.status);
            elodin_client.publish(
                static_cast<uint16_t>((fsw::elodin::kBallValveCalHi << 8) | cal_lo), cal_msg);
        }

        elodin_client.flush_batch();

        packet_count++;
        if (packet_count % 10000 == 0)
            std::cout << "[Cal] Processed " << packet_count << " raw packets (type=0x" << std::hex
                      << static_cast<int>(type_hi) << " ch=" << static_cast<int>(ch_eff) << std::dec
                      << ")" << std::endl;

        // Periodic auto-save every 5 minutes
        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::seconds>(now - last_save).count() > 300) {
            robust_manager.save_adjustments(adjustments_path, &uid_role);
            last_save = now;
        }
    }

    // Persist on shutdown so a clean SIGINT/SIGTERM doesn't drop up to ~5 min of learning since the
    // last periodic auto-save. (The cubic store already saves per capture; this covers robust θ.)
    if (robust_manager.save_adjustments(adjustments_path, &uid_role))
        std::cout << "[Cal] Saved robust adjustments on shutdown → " << adjustments_path
                  << std::endl;
    cubic_store.save();

    std::cout << "[Cal] Stopped." << std::endl;
    return 0;
}
