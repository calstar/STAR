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
 *   CAL_USE_FACTORY_PT=1 / kLpPtDefaultFactoryOnly — LP PT = factory cubic (bypass robust)
 *   CAL_USE_ROBUST_PT=1 — force robust blend even if factory-only default is on
 *   CAL_BACKUP_PATH — override robust prior JSON (else latest calibration_backups/*.json)
 */

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "calibration/PTCalibration.hpp"
#include "calibration/RobustCalibrationManager.hpp"
#include "calibration/SensorCalibration.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

namespace {

/** Last raw u32 per local CH1..10 on the HP PT board slot (for excitation normalization). */
std::array<uint32_t, 11> g_hp_board_last_u32{};
/** Hysteresis: 0 = treat as below loop, 1 = in 4–20 mA band (stops 3.99↔4.01 PSI chatter). */
std::array<uint8_t, 11> g_hp_ma_live{};
/** Low-pass of measured excitation voltage (V) for slow supply tracking. */
double g_hp_v_exc_ema = -1.0;

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

/** Default true: streaming LP PT uses factory cubic when loaded (stable). Set CAL_USE_ROBUST_PT=1
 * to mix in robust (25%) for drift experiments — never uses the old |rob|<1e-3 discrete switch
 * (400↔0 spikes). */
static constexpr bool kLpPtDefaultFactoryOnly = true;

static bool lp_pt_use_factory_only() {
    if (env_flag_true("CAL_USE_ROBUST_PT"))
        return false;
    return kLpPtDefaultFactoryOnly || env_flag_true("CAL_USE_FACTORY_PT");
}

/**
 * 4-20 mA HP PT → PSI. Wire raw is u32 full-scale to 2^31.
 * Optional: normalize shunt voltage by a slow-tracked excitation ADC (config
 * excitation_connector_id
 * + excitation_divider_attenuation) so supply ripple on PT2 does not move all three HP channels
 * together. Optional: per-channel mA hysteresis kills threshold flicker at ~4 mA open-circuit
 * noise.
 */
static double convert_hp_pt_to_pressure(uint8_t local_ch, uint32_t adc_raw, double full_scale_psi,
                                        double sense_resistor_ohms, double adc_ref_voltage,
                                        uint32_t adc_exc_raw, bool use_excitation_norm,
                                        double exc_divider_attenuation) {
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
    if (adc_raw >= static_cast<uint32_t>(ADC_MAX))
        return 0.0;
    if (sense_resistor_ohms <= 0.0 || !std::isfinite(adc_ref_voltage))
        return 0.0;

    double v_sense = (static_cast<double>(adc_raw) / ADC_MAX) * adc_ref_voltage;

    if (use_excitation_norm && adc_exc_raw > 128u && adc_exc_raw < static_cast<uint32_t>(ADC_MAX) &&
        exc_divider_attenuation > 1e-9) {
        double v_e = (static_cast<double>(adc_exc_raw) / ADC_MAX) * adc_ref_voltage /
                     exc_divider_attenuation;
        if (std::isfinite(v_e) && v_e > 1e-5) {
            if (g_hp_v_exc_ema < 0.0)
                g_hp_v_exc_ema = v_e;
            else
                g_hp_v_exc_ema = 0.97 * g_hp_v_exc_ema + 0.03 * v_e;
            double ratio = g_hp_v_exc_ema / std::max(v_e, 1e-9);
            ratio = std::clamp(ratio, 0.88, 1.12);
            v_sense *= ratio;
        }
    }

    double i_ma = (v_sense / sense_resistor_ohms) * 1000.0;
    if (!std::isfinite(v_sense) || !std::isfinite(i_ma))
        return 0.0;

    uint8_t& live = g_hp_ma_live[local_ch];
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
 * Factory / robust PT polynomial lookup key (board-scoped).
 * Wire Elodin channel is always 1..10 per board; JSON must not reuse PT1.CH3 coeffs for PT2.CH3.
 * Mapping: board 1 → 1..10, board 2 → 11..20, board 3 → 21..30, …
 */
static uint8_t pt_calibration_logical_channel(uint8_t board_number, uint8_t local_ch) {
    if (local_ch == 0 || local_ch > 10)
        return local_ch;
    const int idx = (static_cast<int>(board_number) - 1) * 10 + static_cast<int>(local_ch);
    if (idx < 1 || idx > 255)
        return local_ch;
    return static_cast<uint8_t>(idx);
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
    using BoardChannels = fsw::elodin::BoardChannels;
    std::vector<BoardChannels> pt_boards, tc_boards, rtd_boards, lc_boards, enc_boards, act_boards;
    {
        std::ifstream cfg(config_path);
        if (cfg.is_open()) {
            std::string line, section;
            std::string board_type;
            int board_id = 0;
            bool board_enabled = true;
            std::vector<int> active_conn;
            int num_sensors = 0;

            auto flush_board = [&]() {
                if (board_type.empty() || !board_enabled || board_id == 0)
                    return;
                std::vector<uint8_t> channels;
                if (!active_conn.empty()) {
                    for (int c : active_conn)
                        channels.push_back(static_cast<uint8_t>(c));
                } else if (num_sensors > 0) {
                    for (int i = 1; i <= num_sensors; i++)
                        channels.push_back(static_cast<uint8_t>(i));
                }
                if (channels.empty())
                    return;
                int slot_mod = board_id % 10;
                uint8_t board_number = static_cast<uint8_t>(slot_mod == 0 ? 10 : slot_mod);
                BoardChannels bc{static_cast<uint8_t>(board_id), board_number, channels};
                if (board_type == "PT")
                    pt_boards.push_back(bc);
                else if (board_type == "TC")
                    tc_boards.push_back(bc);
                else if (board_type == "RTD")
                    rtd_boards.push_back(bc);
                else if (board_type == "LC")
                    lc_boards.push_back(bc);
                else if (board_type == "ENCODER")
                    enc_boards.push_back(bc);
                else if (board_type == "ACTUATOR")
                    act_boards.push_back(bc);
            };

            while (std::getline(cfg, line)) {
                size_t c = line.find('#');
                if (c != std::string::npos)
                    line = line.substr(0, c);
                while (!line.empty() && (line.back() == ' ' || line.back() == '\r'))
                    line.pop_back();
                size_t start = line.find_first_not_of(" \t");
                if (start != std::string::npos)
                    line = line.substr(start);
                if (line.empty())
                    continue;

                if (line.size() >= 2 && line[0] == '[' && line.back() == ']') {
                    flush_board();
                    section = line.substr(1, line.size() - 2);
                    if (section.rfind("boards.", 0) == 0) {
                        board_type.clear();
                        board_id = 0;
                        board_enabled = true;
                        active_conn.clear();
                        num_sensors = 0;
                    } else {
                        board_type.clear();
                    }
                    continue;
                }
                if (section.rfind("boards.", 0) != 0)
                    continue;
                size_t eq = line.find('=');
                if (eq == std::string::npos)
                    continue;
                std::string key = line.substr(0, eq);
                std::string val = line.substr(eq + 1);
                while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
                    key.pop_back();
                while (!val.empty() && val[0] == ' ')
                    val.erase(0, 1);

                if (key == "type") {
                    if (val.size() >= 2 && val.front() == '"' && val.back() == '"')
                        val = val.substr(1, val.size() - 2);
                    board_type = val;
                } else if (key == "enabled" && val == "false") {
                    board_enabled = false;
                } else if (key == "board_id") {
                    try {
                        board_id = std::stoi(val);
                    } catch (...) {
                    }
                } else if (key == "num_sensors") {
                    try {
                        num_sensors = std::stoi(val);
                    } catch (...) {
                    }
                } else if (key == "active_connectors") {
                    size_t b = val.find('['), e = val.find(']');
                    if (b != std::string::npos && e != std::string::npos) {
                        std::istringstream iss(val.substr(b + 1, e - b - 1));
                        std::string tok;
                        while (std::getline(iss, tok, ','))
                            try {
                                active_conn.push_back(std::stoi(tok));
                            } catch (...) {
                            }
                    }
                }
            }
            flush_board();
        }
    }

    // Parse HP PT config (4-20 mA) — uses local connector IDs (no channel_offset)
    // In simulation, synthetic PT ADC values are not a 4-20 mA current loop.
    const bool use_sim_mode = []() {
        const char* v = std::getenv("USE_SIM");
        return v && (v[0] == '1' || v[0] == 'y' || v[0] == 'Y' || v[0] == 't' || v[0] == 'T');
    }();
    std::set<uint8_t> hp_pt_channels;
    double hp_pt_full_scale_psi = 5000.0;
    double hp_pt_sense_resistor_ohms = 120.0;
    double hp_pt_adc_ref_voltage = 2.5;
    int hp_pt_excitation_connector_id = -1;
    double hp_pt_exc_div_atten = 1.0;
    // Elodin slot (board_id % 10, 0→10) of the board that defines hp_pt_connectors — only that
    // board's packets use the 4–20 mA path. Do NOT take board_id from unrelated [boards.*]
    // sections (e.g. encoder 61 → slot 1) or LP PT CH1/3/4 get misclassified as HP and read 0 PSI.
    uint8_t hp_pt_board_number = 255;  // no HP PT until we parse a non-empty hp_pt_connectors
    {
        std::ifstream cfg2(config_path);
        if (cfg2.is_open()) {
            std::string line, section, board_section;
            std::string hp_pt_source_section;     // [boards.*] that defined hp_pt_connectors
            uint8_t pending_slot_in_section = 0;  // board_id % 10 in current [boards.*]
            while (std::getline(cfg2, line)) {
                size_t c = line.find('#');
                if (c != std::string::npos)
                    line = line.substr(0, c);
                while (!line.empty() && (line.back() == ' ' || line.back() == '\r'))
                    line.pop_back();
                size_t start = line.find_first_not_of(" \t");
                if (start != std::string::npos)
                    line = line.substr(start);
                if (line.empty())
                    continue;
                if (line.size() >= 2 && line[0] == '[' && line.back() == ']') {
                    section = line.substr(1, line.size() - 2);
                    if (section.find("boards.") == 0) {
                        board_section = section;
                        pending_slot_in_section = 0;
                    }
                    continue;
                }
                if (board_section.empty())
                    continue;
                size_t eq = line.find('=');
                if (eq == std::string::npos)
                    continue;
                std::string key = line.substr(0, eq);
                while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
                    key.pop_back();
                std::string val = line.substr(eq + 1);
                while (!val.empty() && (val[0] == ' ' || val[0] == '\t'))
                    val.erase(0, 1);
                if (key == "hp_pt_connectors") {
                    hp_pt_channels.clear();
                    size_t pos = val.find('[');
                    if (pos == std::string::npos)
                        pos = 0;
                    else
                        pos++;
                    while (pos < val.size()) {
                        while (pos < val.size() && (val[pos] == ' ' || val[pos] == ','))
                            pos++;
                        if (pos >= val.size())
                            break;
                        size_t end = val.find_first_of(",]", pos);
                        if (end == std::string::npos)
                            end = val.size();
                        std::string num = val.substr(pos, end - pos);
                        try {
                            int conn = std::stoi(num);
                            if (conn >= 1 && conn <= 10)
                                hp_pt_channels.insert(static_cast<uint8_t>(conn));
                        } catch (...) {
                        }
                        pos = end + 1;
                    }
                    if (!hp_pt_channels.empty()) {
                        hp_pt_source_section = board_section;
                        if (pending_slot_in_section > 0)
                            hp_pt_board_number = pending_slot_in_section;
                    }
                } else if (key == "board_id") {
                    try {
                        int mod = std::stoi(val) % 10;
                        pending_slot_in_section = static_cast<uint8_t>(mod == 0 ? 10 : mod);
                        if (!hp_pt_channels.empty() && board_section == hp_pt_source_section)
                            hp_pt_board_number = pending_slot_in_section;
                    } catch (...) {
                    }
                } else if (key == "hp_pt_full_scale_psi") {
                    try {
                        hp_pt_full_scale_psi = std::stod(val);
                    } catch (...) {
                    }
                } else if (key == "hp_pt_sense_resistor_ohms") {
                    try {
                        hp_pt_sense_resistor_ohms = std::stod(val);
                    } catch (...) {
                    }
                } else if (key == "adc_ref_voltage") {
                    try {
                        hp_pt_adc_ref_voltage = std::stod(val);
                    } catch (...) {
                    }
                } else if (key == "excitation_connector_id" &&
                           board_section.find("pt_board_2") != std::string::npos) {
                    try {
                        hp_pt_excitation_connector_id = std::stoi(val);
                    } catch (...) {
                    }
                } else if (key == "excitation_divider_attenuation" &&
                           board_section.find("pt_board_2") != std::string::npos) {
                    try {
                        hp_pt_exc_div_atten = std::stod(val);
                    } catch (...) {
                    }
                }
            }
        }
        if (!hp_pt_channels.empty()) {
            std::cout << "[Calibration] HP PT: " << hp_pt_channels.size() << " channels (4-20 mA, "
                      << hp_pt_full_scale_psi << " PSI full scale)" << std::endl;
            if (hp_pt_excitation_connector_id >= 1 && hp_pt_excitation_connector_id <= 10)
                std::cout << "[Calibration] HP PT supply normalization: excitation connector "
                          << hp_pt_excitation_connector_id
                          << ", divider_attenuation=" << hp_pt_exc_div_atten << std::endl;
            // If board_id appears after hp_pt_connectors in the same [boards.*] section, we still
            // set hp_pt_board_number on the board_id line — but a malformed or hand-merged TOML can
            // leave 255. Robust PT math on 4–20 mA ADC codes then produces wild PSI (looks like
            // “HP PTs going crazy”). Fleet default: HP stack uses board_id 22 → Elodin slot 2.
            if (hp_pt_board_number == 255) {
                hp_pt_board_number = 2;
                std::cout
                    << "[Calibration] WARN: hp_pt_board_number unset after parse; defaulting "
                       "to slot 2. Ensure board_id is present in the HP PT [boards.*] section."
                    << std::endl;
            }
        }
    }

    // Parse [calibration.tc], [calibration.rtd], [calibration.lc] for default formula params
    double tc_adc_ref_voltage = 2.5;
    double rtd_adc_ref_voltage = 2.5;
    double rtd_excitation_ua = 1000.0;
    double rtd_r0_ohm = 1000.0;  // Pt1000
    double lc_sensitivity_mv_per_v = 2.0;
    double lc_pga_gain = 32.0;
    double lc_full_scale_value = 300.0;  // kg
    {
        std::ifstream cfg3(config_path);
        if (cfg3.is_open()) {
            std::string line, section;
            while (std::getline(cfg3, line)) {
                size_t c = line.find('#');
                if (c != std::string::npos)
                    line = line.substr(0, c);
                while (!line.empty() && (line.back() == ' ' || line.back() == '\r'))
                    line.pop_back();
                size_t start = line.find_first_not_of(" \t");
                if (start != std::string::npos)
                    line = line.substr(start);
                if (line.empty())
                    continue;
                if (line.size() >= 2 && line[0] == '[' && line.back() == ']') {
                    section = line.substr(1, line.size() - 2);
                    continue;
                }
                size_t eq = line.find('=');
                if (eq == std::string::npos)
                    continue;
                std::string key = line.substr(0, eq);
                while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
                    key.pop_back();
                std::string val = line.substr(eq + 1);
                while (!val.empty() && (val[0] == ' ' || val[0] == '\t'))
                    val.erase(0, 1);
                // Remove trailing quotes if present
                if (val.size() >= 2 && val.front() == '"' && val.back() == '"')
                    val = val.substr(1, val.size() - 2);

                try {
                    if (section == "calibration.tc") {
                        if (key == "adc_ref_voltage")
                            tc_adc_ref_voltage = std::stod(val);
                    } else if (section == "calibration.rtd") {
                        if (key == "adc_ref_voltage")
                            rtd_adc_ref_voltage = std::stod(val);
                        else if (key == "excitation_ua")
                            rtd_excitation_ua = std::stod(val);
                        else if (key == "r0_ohm")
                            rtd_r0_ohm = std::stod(val);
                    } else if (section == "calibration.lc") {
                        if (key == "sensitivity_mv_per_v")
                            lc_sensitivity_mv_per_v = std::stod(val);
                        else if (key == "pga_gain")
                            lc_pga_gain = std::stod(val);
                        else if (key == "full_scale_value")
                            lc_full_scale_value = std::stod(val);
                    }
                } catch (...) {
                }
            }
        }
    }
    std::cout << "[Calibration] TC default:  ITS-90 K-type, Vref=" << tc_adc_ref_voltage << "V"
              << std::endl;
    std::cout << "[Calibration] RTD default: CVD Pt" << (int)rtd_r0_ohm
              << ", Vref=" << rtd_adc_ref_voltage << "V, I=" << rtd_excitation_ua << "µA"
              << std::endl;
    std::cout << "[Calibration] LC default:  " << lc_sensitivity_mv_per_v
              << "mV/V, PGA=" << lc_pga_gain << ", FS=" << lc_full_scale_value << "kg" << std::endl;

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
            const uint8_t log_ch = pt_calibration_logical_channel(bc.board_number, local_ch);
            if (pt_calibration.is_calibrated(log_ch)) {
                robust_manager.initialize_sensor(uid, *pt_calibration.get_calibration(log_ch));
            } else if (fallback_pt_coeffs != nullptr) {
                // Keep channels alive even when per-channel baseline fit is missing.
                robust_manager.initialize_sensor(uid, *fallback_pt_coeffs);
            }
        }
    }

    std::cout << "[Calibration] Robust adjustments path: " << adjustments_path << std::endl;
    std::cout << "[Calibration]   (override with --adjustments, CAL_BACKUP_PATH, or "
                 "calibration_backups/calibration_backup_*.json mtime)"
              << std::endl;
    if (!robust_manager.load_adjustments(adjustments_path)) {
        std::cout << "[Calibration]   File missing/unreadable — using factory-seeded robust only"
                  << std::endl;
    }
    if (lp_pt_use_factory_only()) {
        std::cout << "[Calibration] LP PT: factory cubic for streaming (default). "
                     "Export CAL_USE_ROBUST_PT=1 for 75/25 factory/robust blend."
                  << std::endl;
    } else {
        std::cout << "[Calibration] LP PT: CAL_USE_ROBUST_PT=1 — 75% factory + 25% robust blend"
                  << std::endl;
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
            // CalibrationCommand: ts(8) | cmd(1) | sensor_id(2 LE) | pad(1) | ref_f32(4)
            if (pkt_len >= 8 + 16) {
                const uint8_t* p = pkt_buf + 8;
                uint8_t cmd_type = p[8];
                uint16_t sensor_id =
                    static_cast<uint16_t>(p[9]) | (static_cast<uint16_t>(p[10]) << 8);
                float ref_val = *reinterpret_cast<const float*>(p + 12);

                std::cout << "[Cal] Received CalibrationCommand: type=" << (int)cmd_type
                          << " sensor=" << static_cast<int>(sensor_id) << " ref=" << ref_val
                          << std::endl;

                if (cmd_type == 0) {       // Zero All
                    if (sensor_id == 0) {  // All sensors
                        for (auto const& [id, val] : last_adc_map) {
                            robust_manager.zero_sensor(id, val);
                        }
                        std::cout << "[Cal] Performed Zero All for " << last_adc_map.size()
                                  << " sensors" << std::endl;
                    } else {
                        if (last_adc_map.count(sensor_id)) {
                            robust_manager.zero_sensor(sensor_id, last_adc_map[sensor_id]);
                        }
                    }
                } else if (cmd_type == 1) {  // Capture Reference
                    if (last_adc_map.count(sensor_id)) {
                        robust_manager.update_calibration(sensor_id, last_adc_map[sensor_id],
                                                          ref_val);
                    }
                } else if (cmd_type == 2) {  // Save
                    robust_manager.save_adjustments(adjustments_path);
                    std::cout << "[Cal] Adjustments saved to " << adjustments_path << std::endl;
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
        if (block_offset >= 0x10)
            continue;  // calibrated packet (our own output)
        if (block_offset == 0 || block_offset > 10)
            continue;  // channel must be 1-10

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
            if (board_number == hp_pt_board_number && ch_eff >= 1 && ch_eff <= 10)
                g_hp_board_last_u32[static_cast<size_t>(ch_eff)] = adc_u32;

            uint16_t uid = resolve_pt_sensor_uid(type_lo, ch_eff, pt_boards);
            double psi;
            uint8_t cal_status;
            if (!use_sim_mode && board_number == hp_pt_board_number &&
                hp_pt_channels.count(ch_eff)) {
                const bool exc_ok =
                    hp_pt_excitation_connector_id >= 1 && hp_pt_excitation_connector_id <= 10;
                const uint32_t adc_exc =
                    exc_ok ? g_hp_board_last_u32[static_cast<size_t>(hp_pt_excitation_connector_id)]
                           : 0u;
                const bool use_norm = exc_ok && adc_exc >= 128u;
                psi = convert_hp_pt_to_pressure(ch_eff, adc_u32, hp_pt_full_scale_psi,
                                                hp_pt_sense_resistor_ohms, hp_pt_adc_ref_voltage,
                                                adc_exc, use_norm, hp_pt_exc_div_atten);
                cal_status = 1;
                last_adc_map[uid] = static_cast<int32_t>(adc_u32);
                if (verbose() && packet_count % 100 == 0)
                    std::cout << "[Cal] HP PT B" << static_cast<int>(board_number) << " ch"
                              << static_cast<int>(ch_eff)
                              << " adc=" << static_cast<int32_t>(adc_u32) << " psi=" << psi
                              << std::endl;
            } else if (!use_sim_mode && board_number == hp_pt_board_number &&
                       !hp_pt_channels.empty() && !hp_pt_channels.count(ch_eff)) {
                psi = 0.0;
                cal_status = 0;
                last_adc_map[uid] = adc_i32;
            } else {
                last_adc_map[uid] = adc_i32;
                const uint8_t pt_log_ch = pt_calibration_logical_channel(board_number, ch_eff);
                const bool fac_ok = pt_calibration.is_calibrated(pt_log_ch);
                const double psi_fac =
                    fac_ok ? pt_calibration.calculate_pressure(pt_log_ch, adc_i32) : 0.0;
                const double psi_rob = robust_manager.predict_pressure_psi(uid, adc_i32);

                if (!fac_ok) {
                    psi = psi_rob;
                } else if (!robust_manager.has_sensor(uid)) {
                    psi = psi_fac;
                } else if (lp_pt_use_factory_only()) {
                    psi = psi_fac;
                } else {
                    // CAL_USE_ROBUST_PT=1: weighted blend only (old |psi_rob|<1e-3 branch toggled
                    // factory vs robust sample-to-sample and produced full-scale GUI spikes).
                    constexpr double kRobustWeight = 0.25;
                    psi = (1.0 - kRobustWeight) * psi_fac + kRobustWeight * psi_rob;
                }
                cal_status = fac_ok ? 1u : 0u;
                if (verbose() && packet_count % 100 == 0)
                    std::cout << "[Cal] PT B" << static_cast<int>(board_number) << " ch"
                              << static_cast<int>(ch_eff) << " adc=" << adc_i32 << " psi=" << psi
                              << " (robust+fallback)" << std::endl;
            }
            if (!use_sim_mode && board_number == hp_pt_board_number &&
                hp_pt_channels.count(ch_eff)) {
                if (!std::isfinite(psi))
                    psi = 0.0;
                else
                    psi = std::clamp(psi, 0.0, hp_pt_full_scale_psi * 1.2);
            } else {
                if (!std::isfinite(psi))
                    psi = 0.0;
                else
                    psi = std::clamp(psi, -3000.0, 20000.0);
            }
            comms::messages::sensor::CalibratedPTMessage cal_msg(
                ts_ns, ch_eff, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(psi),
                (!use_sim_mode && board_number == hp_pt_board_number &&
                 hp_pt_channels.count(ch_eff))
                    ? adc_u32
                    : static_cast<uint32_t>(adc_i32),
                cal_status);
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
            robust_manager.save_adjustments(adjustments_path);
            last_save = now;
        }
    }

    std::cout << "[Cal] Stopped." << std::endl;
    return 0;
}
