/**
 * @file calibration_main.cpp
 * @brief Standalone Calibration Service — subscribes directly to Elodin, applies calibration,
 *        publishes calibrated VTables back to Elodin.
 *
 * Connects directly to Elodin DB (port 2240) using subscribe_stream() to receive all raw sensor
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
 *   CAL_BACKUP_PATH — override robust prior JSON (else latest calibration_backups/*.json)
 */

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "calibration/CubicCalibrationStore.hpp"
#include "calibration/PTCalibration.hpp"
#include "calibration/RobustCalibrationManager.hpp"
#include "calibration/SensorCalibration.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

namespace {

/**
 * Hysteresis: 0 = treat as below loop, 1 = in 4–20 mA band (stops 3.99↔4.01 PSI chatter).
 * Keyed by board slot so one board's channel going live cannot unlatch another board's
 * same-numbered channel.
 */
std::map<uint8_t, std::array<uint8_t, 11>> g_hp_ma_live;

/** Per-sensor zero offsets (PSI) applied after LP PT path (factory or robust) and Zero All. */
std::unordered_map<uint16_t, double> g_zero_offsets;
std::mutex g_zero_offsets_mutex;

/** Per-sensor EMA state for LP PT output smoothing (initialized to NaN = not yet set). */
std::unordered_map<uint16_t, double> g_lp_ema;
constexpr double LP_EMA_ALPHA = 0.25;  // ~4-sample effective window

/**
 * Which model an LP PT streams: factory cubic (default), full robust, or the 75/25 blend.
 * Chosen per sensor from [calibration_model_<board>] in config.toml (see main); a CAL_USE_* env
 * var, when set, overrides all sensors via g_env_override.
 */
enum class PtModel { Cubic, Robust, Blend };

/** uid (board_id*100 + connector) -> streaming model. Only non-cubic sensors are stored; an absent
 *  uid means Cubic, so this stays small and the startup log lists only meaningful overrides. */
std::unordered_map<uint16_t, PtModel> g_pt_model;

/** uid -> role name (from [sensor_roles_*]). Durable calibration is filed under the role, so it
 *  follows the sensor when its connector changes (see re-file-by-role in the stores). Empty for
 *  connectors with no configured role. */
std::unordered_map<uint16_t, std::string> g_uid_role;

/** Set once at startup: when a CAL_USE_* PT env var is present it forces every sensor, else nullopt
 *  and the per-sensor config governs. */
std::optional<PtModel> g_env_override;

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
    if (s == "blend")
        return PtModel::Blend;
    return PtModel::Cubic;
}

/** Per-sensor streaming model; sensors absent from the map default to factory cubic. */
static PtModel pt_model_for(uint16_t uid) {
    auto it = g_pt_model.find(uid);
    return it == g_pt_model.end() ? PtModel::Cubic : it->second;
}

/** Config-string form of a model, for the cubic store's per-uid active_model tag. */
static const char* pt_model_name(PtModel m) {
    return m == PtModel::Robust ? "robust" : (m == PtModel::Blend ? "blend" : "cubic");
}

/**
 * The single LP PT source-selection rule, shared by the streaming path and the Zero-All helper so
 * both agree. Guards first: no factory fit -> robust; robust not seeded -> factory. Otherwise the
 * env override (if set) wins, else this sensor's configured model.
 */
static double select_lp_pt_psi(uint16_t uid, double psi_fac, double psi_rob, bool fac_ok,
                               bool has_robust) {
    if (!fac_ok)
        return psi_rob;
    if (!has_robust)
        return psi_fac;
    const PtModel m = g_env_override ? *g_env_override : pt_model_for(uid);
    switch (m) {
        case PtModel::Robust:
            return psi_rob;
        case PtModel::Blend: {
            constexpr double kFactoryWeight = 0.25;  // 75% robust + 25% factory
            return (1.0 - kFactoryWeight) * psi_rob + kFactoryWeight * psi_fac;
        }
        case PtModel::Cubic:
        default:
            return psi_fac;
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
/**
 * HP PT shunt codes are defined as unsigned in [0, 2^31) vs 2.5 V ref (see board_simulator).
 * The same 21-byte field is often viewed as int32 in tools; a "reasonable" negative signed code
 * becomes uint32 >= 2^31 and convert_hp_pt_to_pressure used to return 0 PSI for all channels.
 */
static uint32_t coerce_hp_pt_adc_counts(int32_t /* as_signed */, uint32_t as_unsigned) {
    constexpr uint32_t kMaxCode = 2147483647u;  // 2^31 - 1, top of normalized scale
    // HP 4–20 mA shunt codes are defined as unsigned vs 2.5 V ref. Always interpret the wire as
    // uint32 — int32 sign makes many valid codes look "negative" and the old path returned 0.
    return as_unsigned > kMaxCode ? kMaxCode : as_unsigned;
}

static double convert_hp_pt_to_pressure(uint8_t local_ch, uint32_t adc_raw,
                                        const fsw::config::PtBoardConfig& board,
                                        std::array<uint8_t, 11>& live_state) {
    const double full_scale_psi = board.full_scale_psi;
    const double sense_resistor_ohms = board.sense_resistor_ohms;
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

    // ITS-90 Type K inverse: (v_min_mV, v_max_mV, T0, V0, p1, p2, p3, p4, q1, q2, q3)
    static const double ranges[5][11] = {
        {-6.404, -3.554, -121.47164, -4.1790858, 36.069513, 30.722076, 7.791386, 0.52593997,
         0.93939547, 0.2779128, 0.02516334},
        {-3.554, 4.096, -8.7935962, -0.34489914, 25.678719, -0.49887904, -0.44705222, -0.044869202,
         0.00023893439, -0.02039775, -0.0018424107},
        {4.096, 16.397, 310.18976, 12.631386, 24.061949, 4.0158622, 0.26853917, -0.0097188544,
         0.16995872, 0.011413069, -0.00039275155},
        {16.397, 33.275, 605.72562, 25.148718, 23.539401, 0.046547228, 0.0134444, 0.0005923685,
         0.00083445513, 0.0004612144, 0.00002548812},
        {33.275, 69.553, 1018.4705, 41.99385, 25.783239, -1.8363403, 0.05617666, 0.000185324,
         -0.074803355, 0.002384186, 0.0},
    };

    for (const auto& r : ranges) {
        if (v_mv >= r[0] && v_mv <= r[1]) {
            double x = v_mv - r[3];  // x = V_mV - V0
            double num = r[4] + x * (r[5] + x * (r[6] + x * r[7]));
            double den = 1.0 + x * (r[8] + x * (r[9] + x * r[10]));
            if (std::abs(den) < 1e-20)
                return 0.0;
            return r[2] + (x * num) / den;  // T0 + (x * num) / den
        }
    }
    return 0.0;  // out of range
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
 * Pt1000 RTD: raw ADC → voltage → resistance → temperature (°C).
 * Uses Callendar-Van Dusen (IEC 60751) inverse via existing rtd::resistance_to_temp_cvd().
 */
static double convert_rtd_adc_to_temp_c(int32_t adc_raw, double adc_ref_voltage,
                                        double excitation_ua, double r0_ohm) {
    constexpr double ADC_MAX = 2147483648.0;
    if (excitation_ua <= 0.0)
        return 0.0;

    double voltage_v = (static_cast<double>(adc_raw) / ADC_MAX) * adc_ref_voltage;
    double resistance_ohm = (std::abs(voltage_v) * 1e6) / excitation_ua;

    fsw::calibration::rtd::CVDCoeffs cvd;
    cvd.R0 = r0_ohm;  // Pt1000: 1000.0 (not the header default of 100)
    return fsw::calibration::rtd::resistance_to_temp_cvd(resistance_ohm, cvd);
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
 * LP PT pressure exactly as published before zero offset and EMA — must match the streaming
 * branch so Zero All reads 0 PSI at the current ADC. (Using only factory psi for the offset while
 * streaming robust caused psi_display ≈ psi_rob - psi_fac, e.g. GN2 / GSE wrong after Zero All.)
 */
static double lp_pt_psi_before_offset(uint8_t board_number, uint8_t local_ch, uint16_t uid,
                                      int32_t adc_i32,
                                      const fsw::calibration::PTCalibrationManager& pt_calibration,
                                      fsw::calibration::RobustCalibrationManager& robust_manager) {
    const uint8_t pt_log_ch =
        fsw::calibration::pt_logical_calibration_channel(board_number, local_ch);
    const bool fac_ok = pt_calibration.is_calibrated(pt_log_ch);
    const double psi_fac = fac_ok ? pt_calibration.calculate_pressure(pt_log_ch, adc_i32) : 0.0;
    const double psi_rob = robust_manager.predict_pressure_psi(uid, adc_i32);
    return select_lp_pt_psi(uid, psi_fac, psi_rob, fac_ok, robust_manager.has_sensor(uid));
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

    // Load calibration coefficients
    fsw::calibration::PTCalibrationManager pt_calibration;
    pt_calibration.set_default_paths(
        "scripts/calibration/calibrations",
        "external/DiabloAvionics/PT_Board/Calibration/PT Calibration Attempt 2026-02-04_test2.csv");
    pt_calibration.load_calibration();

    fsw::calibration::RobustCalibrationManager robust_manager;

    fsw::calibration::SensorCalibrationManager tc_calibration("TC", "°C", 3);
    tc_calibration.load_calibration(
        "scripts/calibration/calibrations/tc",
        "external/DiabloAvionics/TC_Board/Calibration/tc_calibration.csv");

    fsw::calibration::SensorCalibrationManager rtd_calibration("RTD", "°C", 3);
    rtd_calibration.load_calibration(
        "scripts/calibration/calibrations/rtd",
        "external/DiabloAvionics/RTD_Board/Calibration/rtd_calibration.csv");

    fsw::calibration::SensorCalibrationManager lc_calibration("LC", "kg", 3);
    lc_calibration.load_calibration(
        "scripts/calibration/calibrations/lc",
        "external/DiabloAvionics/LC_Board/Calibration/lc_calibration.csv");

    std::cout << "[Calibration] PT:  " << pt_calibration.get_calibrated_count()
              << " logical channels (slot1→JSON 1..10, slot2→11..20, … — avoids reusing board1 "
                 "polynomials on PT2)"
              << std::endl;
    if (!pt_calibration.is_calibrated(5))
        std::cerr << "[Calibration] WARNING: PT ch5 (Ox Upstream) not calibrated" << std::endl;
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

    // [calibration.tc/.rtd/.lc] default formula params, via fsw::config (toml++).
    const fsw::config::Config cal_cfg = fsw::config::load(config_path);
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

    // ---- Per-sensor streaming model (cubic vs robust) from config ----
    // [calibration_model_<board_key>] maps a PT role name to "cubic"|"robust"|"blend"; resolve it
    // to the same uid the streaming path uses (board_id*100 + connector) via
    // [sensor_roles_<board_key>]. Absent/unknown => cubic. Current-loop (4-20 mA) boards are
    // skipped: they never take this path. A CAL_USE_* env var overrides every sensor (dev/testing)
    // — computed once here.
    if (env_flag_true("CAL_USE_FACTORY_PT"))
        g_env_override = PtModel::Cubic;
    else if (env_flag_true("CAL_USE_ROBUST_BLEND"))
        g_env_override = PtModel::Blend;
    else if (env_flag_true("CAL_USE_ROBUST_PT"))
        g_env_override = PtModel::Robust;

    g_pt_model.clear();
    g_uid_role.clear();
    for (const auto& b : cal_cfg.boards) {
        if (b.type != "PT" || !b.enabled || b.board_id < 0)
            continue;
        if (b.has_hp_pt_keys || b.pt_type == "4-20 mA absolute")
            continue;  // current-loop board — cubic/robust never applies
        const std::string board_key =
            b.section.rfind("boards.", 0) == 0 ? b.section.substr(7) : b.section;
        const auto* roles = cal_cfg.sensor_roles_for("sensor_roles_" + board_key);
        if (roles == nullptr)
            continue;  // no role map -> every connector defaults to cubic
        const auto* models = cal_cfg.calibration_model_for("calibration_model_" + board_key);
        for (const auto& [role, connector] : *roles) {
            if (connector < 1 || connector > 99)
                continue;
            const uint16_t uid = static_cast<uint16_t>(b.board_id * 100 + connector);
            g_uid_role[uid] = role;  // the identity durable cal is filed under
            PtModel m = PtModel::Cubic;
            if (models != nullptr) {
                auto it = models->find(role);
                if (it != models->end())
                    m = parse_pt_model(it->second);
            }
            if (m != PtModel::Cubic)  // only store overrides; absence means cubic
                g_pt_model[uid] = m;
        }
    }
    // Ordered uid->role for RobustCalibrationManager save/load, so the robust learned state is
    // filed by role and re-attaches to the role's current connector (mirrors the cubic store).
    const std::map<uint16_t, std::string> uid_role(g_uid_role.begin(), g_uid_role.end());

    const fsw::calibration::PTCalibrationCoeffs* fallback_pt_coeffs = nullptr;
    for (uint8_t probe_ch = 1; probe_ch <= 10; ++probe_ch) {
        if (pt_calibration.is_calibrated(probe_ch)) {
            fallback_pt_coeffs = pt_calibration.get_calibration(probe_ch);
            break;
        }
    }
    for (const auto& bc : pt_boards) {
        for (uint8_t local_ch : bc.channels) {
            uint16_t uid = static_cast<uint16_t>(bc.board_id) * 100u + local_ch;
            const uint8_t log_ch =
                fsw::calibration::pt_logical_calibration_channel(bc.board_number, local_ch);
            if (pt_calibration.is_calibrated(log_ch)) {
                robust_manager.initialize_sensor(uid, *pt_calibration.get_calibration(log_ch));
            } else if (fallback_pt_coeffs != nullptr) {
                // Keep channels alive even when per-channel baseline fit is missing.
                robust_manager.initialize_sensor(uid, *fallback_pt_coeffs);
            }
        }
    }

    // ---- Operator-built cubic PT calibration (see CubicCalibrationStore) ----
    // The store owns per-connector captured (adc, psi) points and the fitted cubic. Its file is
    // excluded from the factory-cubic overlay loader, so factory_pt_snapshot is pure factory and
    // the store is the sole applier of operator cubics (via pt_calibration.set_calibration).
    fsw::calibration::CubicCalibrationStore cubic_store(
        "scripts/calibration/calibrations/cubic_calibration.json");
    std::map<uint8_t, fsw::calibration::PTCalibrationCoeffs> factory_pt_snapshot;
    std::unordered_map<uint16_t, std::deque<int32_t>> pt_adc_ring;  // recent raw ADC per uid
    constexpr size_t kPtAdcRingMax = 128;                           // ~0.5 s of samples at ~250 Hz
    for (const auto& bc : pt_boards) {
        for (uint8_t local_ch : bc.channels) {
            const uint16_t uid = static_cast<uint16_t>(bc.board_id) * 100u + local_ch;
            const uint8_t log_ch =
                fsw::calibration::pt_logical_calibration_channel(bc.board_number, local_ch);
            const auto rit = g_uid_role.find(uid);
            const std::string role = rit != g_uid_role.end() ? rit->second : std::string();
            cubic_store.register_channel(uid, bc.board_id, local_ch, log_ch, role,
                                         pt_model_name(pt_model_for(uid)));
            if (pt_calibration.is_calibrated(log_ch))
                factory_pt_snapshot[log_ch] = *pt_calibration.get_calibration(log_ch);
        }
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
    auto apply_capture = [&](uint16_t uid, double adc_avg, double ref) {
        if (pt_model_for(uid) == PtModel::Robust) {
            cubic_store.add_point(uid, adc_avg, ref);  // display/audit only for robust
            robust_manager.update_calibration(uid, static_cast<int32_t>(std::llround(adc_avg)),
                                              ref);
            cubic_store.set_fit_curve(uid, sample_robust_curve(uid));
        } else {  // Cubic (and Blend, whose factory half is the cubic)
            const fsw::calibration::CubicFit fit = cubic_store.add_point(uid, adc_avg, ref);
            const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
            if (fit.valid && cch != nullptr)
                pt_calibration.set_calibration(
                    cch->logical_ch,
                    fsw::calibration::PTCalibrationCoeffs(fit.A, fit.B, fit.C, fit.D));
        }
        cubic_store.save();
    };
    auto apply_clear = [&](uint16_t uid) {
        cubic_store.clear_channel(uid);
        if (pt_model_for(uid) == PtModel::Robust) {
            robust_manager.reset_adjustment(uid);
        } else {
            const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
            if (cch != nullptr) {
                auto fac = factory_pt_snapshot.find(cch->logical_ch);
                if (fac != factory_pt_snapshot.end())
                    pt_calibration.set_calibration(cch->logical_ch, fac->second);
            }
        }
        cubic_store.save();
    };

    // Resume previously captured points and re-apply their fitted cubics to the live stream.
    const size_t cubic_loaded = cubic_store.load();
    if (cubic_loaded > 0) {
        for (uint16_t uid : cubic_store.uids()) {
            const fsw::calibration::CubicFit* fit = cubic_store.fit_for(uid);
            const fsw::calibration::CubicChannel* cch = cubic_store.channel(uid);
            if (fit != nullptr && cch != nullptr)
                pt_calibration.set_calibration(
                    cch->logical_ch,
                    fsw::calibration::PTCalibrationCoeffs(fit->A, fit->B, fit->C, fit->D));
        }
        std::cout << "[Calibration] Cubic: resumed " << cubic_loaded
                  << " channel(s) from cubic_calibration.json" << std::endl;
    }

    std::cout << "[Calibration] Robust adjustments path: " << adjustments_path << std::endl;
    std::cout << "[Calibration]   (override with --adjustments, CAL_BACKUP_PATH, or "
                 "calibration_backups/calibration_backup_*.json mtime)"
              << std::endl;
    if (!robust_manager.load_adjustments(adjustments_path, &uid_role)) {
        std::cout << "[Calibration]   File missing/unreadable — using factory-seeded robust only"
                  << std::endl;
    }
    // Robust uids: resume points are display-only, so re-sample the display curve from the now-
    // restored robust model (adjustments.json). Cubic uids already had their fit re-applied above.
    {
        bool any = false;
        for (uint16_t uid : cubic_store.uids())
            if (pt_model_for(uid) == PtModel::Robust) {
                cubic_store.set_fit_curve(uid, sample_robust_curve(uid));
                any = true;
            }
        if (any)
            cubic_store.save();
    }
    if (g_env_override) {
        const char* label = *g_env_override == PtModel::Cubic ? "factory cubic (CAL_USE_FACTORY_PT)"
                            : *g_env_override == PtModel::Blend
                                ? "75% robust + 25% factory (CAL_USE_ROBUST_BLEND)"
                                : "100% robust when initialized (CAL_USE_ROBUST_PT)";
        std::cout << "[Calibration] LP PT: env override — all sensors " << label << std::endl;
    } else {
        size_t robust_n = 0, blend_n = 0;
        for (const auto& [uid, m] : g_pt_model) {
            if (m == PtModel::Robust)
                ++robust_n;
            else if (m == PtModel::Blend)
                ++blend_n;
        }
        std::cout << "[Calibration] LP PT: per-sensor model from config — default factory cubic; "
                  << robust_n << " robust, " << blend_n << " blend" << std::endl;
        for (const auto& [uid, m] : g_pt_model)
            std::cout << "[Calibration]   uid " << uid << " -> "
                      << (m == PtModel::Robust ? "robust" : "blend") << std::endl;
    }

    if (verbose())
        std::cout << "[Cal] CAL_VERBOSE=1 — debug output enabled" << std::endl;

    // Single ElodinClient for both subscribe (read) and publish (write)
    fsw::elodin::ElodinClient elodin_client;

    auto connect_and_register = [&]() -> bool {
        if (!elodin_client.connect(elodin_host, elodin_port)) {
            std::cerr << "[Cal] Failed to connect to Elodin at " << elodin_host << ":"
                      << elodin_port << std::endl;
            return false;
        }
        fsw::elodin::DatabaseConfig::register_calibrated_tables(
            elodin_client, pt_boards, tc_boards, rtd_boards, lc_boards, enc_boards, act_boards);
        if (!elodin_client.subscribe_stream()) {
            std::cerr << "[Cal] Failed to subscribe to Elodin stream" << std::endl;
            return false;
        }
        if (!elodin_client.subscribe_tables({{0x46, 0x00}})) {
            std::cerr << "[Cal] Failed to subscribe to CalibrationCommand [0x46,0x00]" << std::endl;
            return false;
        }
        std::cout << "[Cal] Connected to Elodin, registered calibrated VTables, subscribed."
                  << std::endl;
        return true;
    };

    if (!connect_and_register())
        return 1;
    // Allow read_packet() to yield every 3 s so the re-subscribe check can fire
    // when Elodin silently drops subscriptions (daq_bridge VTables not yet registered).
    elodin_client.set_recv_timeout_ms(3000);

    uint8_t pkt_buf[65536];  // 64 KB — handles large Elodin subscription-ACK bursts
    int packet_count = 0;
    static std::atomic<bool> logged_ch5{false};
    auto last_save = std::chrono::steady_clock::now();
    auto last_packet_time = std::chrono::steady_clock::now();
    auto last_resubscribe = std::chrono::steady_clock::now();
    std::map<uint16_t, int32_t> last_adc_map;

    while (running) {
        if (!elodin_client.is_connected()) {
            std::cerr << "[Cal] Elodin disconnected, retrying in 2s..." << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(2));
            if (elodin_client.reconnect()) {
                fsw::elodin::DatabaseConfig::register_calibrated_tables(
                    elodin_client, pt_boards, tc_boards, rtd_boards, lc_boards, enc_boards,
                    act_boards);
                elodin_client.subscribe_stream();
                elodin_client.subscribe_tables({{0x46, 0x00}});
                elodin_client.set_recv_timeout_ms(3000);
                last_resubscribe = std::chrono::steady_clock::now();
                last_packet_time = std::chrono::steady_clock::now();
                std::cout << "[Cal] Reconnected to Elodin" << std::endl;
            }
            continue;
        }

        // If no raw sensor packets received for 5 s, daq_bridge may have registered
        // its VTables AFTER we subscribed — re-subscribe to pick them up.
        {
            auto now_s = std::chrono::steady_clock::now();
            auto since_pkt =
                std::chrono::duration_cast<std::chrono::seconds>(now_s - last_packet_time).count();
            auto since_sub =
                std::chrono::duration_cast<std::chrono::seconds>(now_s - last_resubscribe).count();
            if (since_pkt >= 5 && since_sub >= 5) {
                std::cout << "[Cal] No packets for " << since_pkt
                          << "s — re-subscribing to raw streams" << std::endl;
                elodin_client.subscribe_stream();
                elodin_client.subscribe_tables({{0x46, 0x00}});
                last_resubscribe = now_s;
            }
        }

        ssize_t pkt_len = elodin_client.read_packet(pkt_buf, sizeof(pkt_buf));
        if (pkt_len <= 0)
            continue;
        if (pkt_len < 8)
            continue;

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
                uint8_t cmd_type = p[8];
                uint16_t sensor_id =
                    static_cast<uint16_t>(p[10]) | (static_cast<uint16_t>(p[11]) << 8);
                float ref_val = *reinterpret_cast<const float*>(p + 12);

                std::cout << "[Cal] Received CalibrationCommand: type=" << (int)cmd_type
                          << " sensor=" << static_cast<int>(sensor_id) << " ref=" << ref_val
                          << std::endl;

                if (cmd_type == 0) {       // Zero All
                    if (sensor_id == 0) {  // All sensors
                        std::lock_guard<std::mutex> lk(g_zero_offsets_mutex);
                        g_lp_ema.clear();  // reset EMA so zeroed value reaches GUI immediately
                        for (auto const& [id, val] : last_adc_map) {
                            const uint8_t bid = static_cast<uint8_t>(id / 100);
                            const uint8_t lch = static_cast<uint8_t>(id % 100);
                            const uint8_t bn = (bid % 10) == 0 ? 10u : (bid % 10);
                            const bool is_hp = current_loop_board(bn) != nullptr;
                            robust_manager.zero_sensor(id, val);
                            if (is_hp) {
                                g_zero_offsets.erase(id);
                                continue;
                            }
                            // Offset must match streaming path (robust vs factory), after RCF zero.
                            const double psi_base = lp_pt_psi_before_offset(
                                bn, lch, id, val, pt_calibration, robust_manager);
                            if (std::isfinite(psi_base))
                                g_zero_offsets[id] = -psi_base;
                        }
                        std::cout << "[Cal] Performed Zero All for " << last_adc_map.size()
                                  << " sensors" << std::endl;
                    } else {
                        if (last_adc_map.count(sensor_id)) {
                            std::lock_guard<std::mutex> lk(g_zero_offsets_mutex);
                            const uint8_t bid = static_cast<uint8_t>(sensor_id / 100);
                            const uint8_t lch = static_cast<uint8_t>(sensor_id % 100);
                            const uint8_t bn = (bid % 10) == 0 ? 10u : (bid % 10);
                            const bool is_hp = current_loop_board(bn) != nullptr;
                            robust_manager.zero_sensor(sensor_id, last_adc_map[sensor_id]);
                            if (!is_hp) {
                                const double psi_base = lp_pt_psi_before_offset(
                                    bn, lch, sensor_id, last_adc_map[sensor_id], pt_calibration,
                                    robust_manager);
                                if (std::isfinite(psi_base))
                                    g_zero_offsets[sensor_id] = -psi_base;
                            } else {
                                g_zero_offsets.erase(sensor_id);
                            }
                            g_lp_ema.erase(sensor_id);
                        }
                    }
                } else if (cmd_type == 1) {  // Capture Reference
                    if (last_adc_map.count(sensor_id)) {
                        robust_manager.update_calibration(sensor_id, last_adc_map[sensor_id],
                                                          ref_val);
                    }
                } else if (cmd_type == 2) {  // Save
                    robust_manager.save_adjustments(adjustments_path, &uid_role);
                    std::cout << "[Cal] Adjustments saved to " << adjustments_path << std::endl;
                } else if (cmd_type == 3) {  // Capture cubic point (operator-built factory cubic)
                    bool have_adc = false;
                    double adc_avg = 0.0;
                    auto rit = pt_adc_ring.find(sensor_id);
                    if (rit != pt_adc_ring.end() && !rit->second.empty()) {
                        double sum = 0.0;
                        for (int32_t a : rit->second)
                            sum += static_cast<double>(a);
                        adc_avg = sum / static_cast<double>(rit->second.size());
                        have_adc = true;
                    } else if (last_adc_map.count(sensor_id)) {
                        adc_avg = static_cast<double>(last_adc_map[sensor_id]);
                        have_adc = true;
                    }
                    if (have_adc) {
                        const fsw::calibration::CubicFit fit =
                            cubic_store.add_point(sensor_id, adc_avg, ref_val);
                        const fsw::calibration::CubicChannel* cch = cubic_store.channel(sensor_id);
                        if (fit.valid && cch != nullptr)
                            pt_calibration.set_calibration(
                                cch->logical_ch,
                                fsw::calibration::PTCalibrationCoeffs(fit.A, fit.B, fit.C, fit.D));
                        cubic_store.save();
                        std::cout << "[Cal] Cubic capture uid=" << static_cast<int>(sensor_id)
                                  << " adc=" << adc_avg << " psi=" << ref_val
                                  << (fit.valid ? " (fit ok)" : " (pending/err)") << std::endl;
                    } else {
                        std::cout << "[Cal] Cubic capture: no ADC seen yet for uid "
                                  << static_cast<int>(sensor_id) << std::endl;
                    }
                } else if (cmd_type == 4) {  // Clear cubic channel (revert to factory)
                    cubic_store.clear_channel(sensor_id);
                    const fsw::calibration::CubicChannel* cch = cubic_store.channel(sensor_id);
                    if (cch != nullptr) {
                        auto fac = factory_pt_snapshot.find(cch->logical_ch);
                        if (fac != factory_pt_snapshot.end())
                            pt_calibration.set_calibration(cch->logical_ch, fac->second);
                    }
                    cubic_store.save();
                    std::cout << "[Cal] Cubic cleared uid=" << static_cast<int>(sensor_id)
                              << std::endl;
                } else if (cmd_type == 5) {  // Unified capture point — routed by configured model
                    bool have_adc = false;
                    double adc_avg = 0.0;
                    auto rit = pt_adc_ring.find(sensor_id);
                    if (rit != pt_adc_ring.end() && !rit->second.empty()) {
                        double sum = 0.0;
                        for (int32_t a : rit->second)
                            sum += static_cast<double>(a);
                        adc_avg = sum / static_cast<double>(rit->second.size());
                        have_adc = true;
                    } else if (last_adc_map.count(sensor_id)) {
                        adc_avg = static_cast<double>(last_adc_map[sensor_id]);
                        have_adc = true;
                    }
                    if (have_adc) {
                        apply_capture(sensor_id, adc_avg, ref_val);
                        std::cout << "[Cal] Capture uid=" << static_cast<int>(sensor_id) << " ("
                                  << pt_model_name(pt_model_for(sensor_id)) << ") adc=" << adc_avg
                                  << " psi=" << ref_val << std::endl;
                    } else {
                        std::cout << "[Cal] Capture: no ADC seen yet for uid "
                                  << static_cast<int>(sensor_id) << std::endl;
                    }
                } else if (cmd_type == 6) {  // Unified new calibration / clear — routed by model
                    apply_clear(sensor_id);
                    std::cout << "[Cal] New calibration uid=" << static_cast<int>(sensor_id) << " ("
                              << pt_model_name(pt_model_for(sensor_id)) << ")" << std::endl;
                }
            }
            continue;
        }

        if ((type_hi < 0x20 || type_hi > 0x24) && type_hi != 0x30)
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

        if (type_hi == 0x20) {  // PT raw
            const fsw::config::PtBoardConfig* loop_board = current_loop_board(board_number);

            uint16_t uid = resolve_pt_sensor_uid(type_lo, ch_eff, pt_boards);
            double psi;
            uint8_t cal_status;
            // board_simulator.py generates valid 4-20 mA ADC codes for current-loop connectors
            // (back-calculates i_ma from target PSI), so apply the 4-20 mA path in both
            // sim and real-hardware modes — no use_sim_mode guard needed here.
            if (loop_board != nullptr) {
                // The ADC reference is set once per board, so every active connector on a
                // current-loop board is a loop channel.
                const uint32_t hp_wire_adc = coerce_hp_pt_adc_counts(adc_i32, adc_u32);
                psi = convert_hp_pt_to_pressure(ch_eff, hp_wire_adc, *loop_board,
                                                g_hp_ma_live[board_number]);
                cal_status = 1;
                last_adc_map[uid] = static_cast<int32_t>(hp_wire_adc);
                if (verbose() && packet_count % 100 == 0)
                    std::cout << "[Cal] HP PT B" << static_cast<int>(board_number) << " ch"
                              << static_cast<int>(ch_eff) << " adc_s=" << adc_i32
                              << " adc_hp=" << hp_wire_adc << " psi=" << psi << std::endl;
            } else {
                last_adc_map[uid] = adc_i32;
                // Feed the cubic-calibration ADC ring so a capture averages a short window.
                {
                    auto& ring = pt_adc_ring[uid];
                    ring.push_back(adc_i32);
                    if (ring.size() > kPtAdcRingMax)
                        ring.pop_front();
                }
                const uint8_t pt_log_ch =
                    fsw::calibration::pt_logical_calibration_channel(board_number, ch_eff);
                const bool fac_ok = pt_calibration.is_calibrated(pt_log_ch);
                const double psi_fac =
                    fac_ok ? pt_calibration.calculate_pressure(pt_log_ch, adc_i32) : 0.0;
                const double psi_rob = robust_manager.predict_pressure_psi(uid, adc_i32);

                psi =
                    select_lp_pt_psi(uid, psi_fac, psi_rob, fac_ok, robust_manager.has_sensor(uid));
                cal_status = fac_ok ? 1u : 0u;
                // Apply zero offset then EMA for LP PT channels.
                {
                    std::lock_guard<std::mutex> lk(g_zero_offsets_mutex);
                    auto it_off = g_zero_offsets.find(uid);
                    if (it_off != g_zero_offsets.end())
                        psi += it_off->second;
                }
                {
                    auto& ema = g_lp_ema[uid];
                    if (!std::isfinite(ema))
                        ema = psi;
                    else
                        ema = LP_EMA_ALPHA * psi + (1.0 - LP_EMA_ALPHA) * ema;
                    psi = ema;
                }
                if (verbose() && packet_count % 100 == 0)
                    std::cout << "[Cal] PT B" << static_cast<int>(board_number) << " ch"
                              << static_cast<int>(ch_eff) << " adc=" << adc_i32 << " psi=" << psi
                              << std::endl;
            }
            if (loop_board != nullptr) {
                if (!std::isfinite(psi))
                    psi = 0.0;
                else
                    psi = std::clamp(psi, 0.0, loop_board->full_scale_psi * 1.2);
            } else {
                if (!std::isfinite(psi))
                    psi = 0.0;
                else
                    psi = std::clamp(psi, -3000.0, 20000.0);
            }
            comms::messages::sensor::CalibratedPTMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(psi),
                loop_board != nullptr ? adc_u32 : static_cast<uint32_t>(adc_i32), cal_status);
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
            temp_c = clamp_tc_rtd_temp_publish_c(temp_c);
            comms::messages::sensor::CalibratedRTDMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(temp_c),
                static_cast<uint32_t>(adc_i32), cal_status);
            elodin_client.publish(static_cast<uint16_t>((type_hi << 8) | cal_lo), cal_msg);

        } else if (type_hi == 0x23) {  // LC raw
            double force_kg;
            uint8_t cal_status;
            if (lc_calibration.is_calibrated(ch_eff)) {
                force_kg = lc_calibration.calculate(ch_eff, adc_i32);
                cal_status = 1;
            } else {
                force_kg = convert_lc_adc_to_force(adc_i32, lc_sensitivity_mv_per_v, lc_pga_gain,
                                                   lc_full_scale_value);
                cal_status = 0;
            }
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
        }

        elodin_client.flush_batch();

        last_packet_time = std::chrono::steady_clock::now();
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
