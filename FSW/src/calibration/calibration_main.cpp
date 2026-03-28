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
 */

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "calibration/PTCalibration.hpp"
#include "calibration/SensorCalibration.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

static std::atomic<bool> running{true};

static bool verbose() {
    const char* v = std::getenv("CAL_VERBOSE");
    return v && (v[0] == '1' || v[0] == 'y' || v[0] == 'Y');
}

/** 4-20 mA HP PT: psi = (i_ma - 4) / 16 * full_scale_psi. ADC signed, ADC_MAX=2^31. */
static double convert_hp_pt_to_pressure(int32_t adc_sensor, double full_scale_psi,
                                        double sense_resistor_ohms, double adc_ref_voltage) {
    constexpr double ADC_MAX = 2147483648.0;
    constexpr double I_MIN_MA = 4.0;
    constexpr double I_SPAN_MA = 16.0;

    if (adc_sensor >= static_cast<int32_t>(ADC_MAX) || adc_sensor < 0)
        return 0.0;
    double v_sense = (static_cast<double>(adc_sensor) / ADC_MAX) * adc_ref_voltage;
    double i_ma = (v_sense / sense_resistor_ohms) * 1000.0;
    if (i_ma < I_MIN_MA)
        return 0.0;
    if (i_ma > 20.0)
        return full_scale_psi;
    return ((i_ma - I_MIN_MA) / I_SPAN_MA) * full_scale_psi;
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

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc)
            config_path = argv[++i];
        else if ((arg == "--host" || arg == "--elodin-host") && i + 1 < argc)
            elodin_host = argv[++i];
        else if ((arg == "--port" || arg == "--elodin-port") && i + 1 < argc)
            elodin_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: " << argv[0]
                      << " [--config PATH] [--elodin-host HOST] [--elodin-port PORT]\n";
            return 0;
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

    std::cout << "[Calibration] PT:  " << pt_calibration.get_calibrated_count() << " channels"
              << std::endl;
    if (!pt_calibration.is_calibrated(5))
        std::cerr << "[Calibration] WARNING: PT ch5 (Ox Upstream) not calibrated" << std::endl;
    std::cout << "[Calibration] TC:  " << tc_calibration.calibrated_count() << " channels"
              << std::endl;
    std::cout << "[Calibration] RTD: " << rtd_calibration.calibrated_count() << " channels"
              << std::endl;
    std::cout << "[Calibration] LC:  " << lc_calibration.calibrated_count() << " channels"
              << std::endl;

    // Parse PT channel names from config for VTable registration
    std::map<int, std::string> pt_channel_to_name;
    {
        std::ifstream cfg(config_path);
        if (cfg.is_open()) {
            std::string line, section;
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
                    section = line.substr(1, line.size() - 2);
                    continue;
                }
                if (section != "sensor_roles_pt_board" && section != "sensor_roles_pt2" &&
                    section != "sensor_roles")
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
                if (key.size() >= 2 && key.front() == '"' && key.back() == '"')
                    key = key.substr(1, key.size() - 2);
                for (auto& ch : key)
                    if (ch == ' ')
                        ch = '_';
                int channel = 0;
                try {
                    channel = std::stoi(val);
                } catch (...) {
                    continue;
                }
                if (channel > 0)
                    pt_channel_to_name[channel] = key;
            }
        }
    }
    const std::map<int, std::string>* pt_names =
        pt_channel_to_name.empty() ? nullptr : &pt_channel_to_name;

    // Parse HP PT config (4-20 mA)
    std::set<uint8_t> hp_pt_channels;
    double hp_pt_full_scale_psi = 5000.0;
    double hp_pt_sense_resistor_ohms = 120.0;
    double hp_pt_adc_ref_voltage = 2.5;
    int channel_offset = 10;
    {
        std::ifstream cfg2(config_path);
        if (cfg2.is_open()) {
            std::string line, section, board_section;
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
                    if (section.find("boards.") == 0)
                        board_section = section;
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
                                hp_pt_channels.insert(static_cast<uint8_t>(conn + channel_offset));
                        } catch (...) {
                        }
                        pos = end + 1;
                    }
                } else if (key == "channel_offset") {
                    try {
                        channel_offset = std::stoi(val);
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
                }
            }
        }
        if (!hp_pt_channels.empty()) {
            std::cout << "[Calibration] HP PT: " << hp_pt_channels.size() << " channels (4-20 mA, "
                      << hp_pt_full_scale_psi << " PSI full scale)" << std::endl;
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
        fsw::elodin::DatabaseConfig::register_calibrated_tables(elodin_client, pt_names,
                                                                 nullptr, nullptr, nullptr, nullptr);
        if (!elodin_client.subscribe_stream()) {
            std::cerr << "[Cal] Failed to subscribe to Elodin stream" << std::endl;
            return false;
        }
        std::cout << "[Cal] Connected to Elodin, registered calibrated VTables, subscribed."
                  << std::endl;
        return true;
    };

    if (!connect_and_register())
        return 1;

    uint8_t pkt_buf[8192];
    int packet_count = 0;
    static std::atomic<bool> logged_ch5{false};

    while (running) {
        if (!elodin_client.is_connected()) {
            std::cerr << "[Cal] Elodin disconnected, retrying in 2s..." << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(2));
            if (elodin_client.reconnect()) {
                fsw::elodin::DatabaseConfig::register_calibrated_tables(elodin_client, pt_names,
                                                                         nullptr, nullptr, nullptr, nullptr);
                elodin_client.subscribe_stream();
                std::cout << "[Cal] Reconnected to Elodin" << std::endl;
            }
            continue;
        }

        ssize_t pkt_len = elodin_client.read_packet(pkt_buf, sizeof(pkt_buf));
        if (pkt_len <= 0)
            continue;
        if (pkt_len < 8)
            continue;

        const uint8_t type_hi = pkt_buf[5];
        const uint8_t type_lo = pkt_buf[6];
        const uint8_t ty = pkt_buf[4];

        static int debug_limit = 0;
        if (debug_limit < 10) {
            std::cout << "[Cal] Received packet ty=" << (int)ty << " id=[" << std::hex
                      << (int)type_hi << "," << (int)type_lo << std::dec << "]"
                      << " pkt_len=" << pkt_len << std::endl;
            debug_limit++;
        }

        if (ty != 1)
            continue;  // Only process TABLE packets

        // Only process raw sensor VTables
        if (type_hi < 0x20 || type_hi > 0x23)
            continue;

        const ssize_t payload_len = pkt_len - 8;
        if (payload_len < 21) {
            if (debug_limit < 20) {
                std::cout << "[Cal] Dropped small payload: " << payload_len << std::endl;
                debug_limit++;
            }
            continue;
        }

        // Parse 21-byte raw sensor payload directly
        const uint8_t* p = pkt_buf + 8;
        const uint64_t ts_ns = *reinterpret_cast<const uint64_t*>(p);
        const uint8_t ch = p[8];
        const uint32_t raw_adc = *reinterpret_cast<const uint32_t*>(p + 12);
        // p[16-19] = sample_timestamp_ms (unused in calibration output)
        // p[20]    = status_flags        (unused in calibration output)

        if (ch == 0 || ch > 20)
            continue;

        elodin_client.begin_batch();

        if (type_hi == 0x20 && ch <= 14) {  // PT raw
            double psi;
            uint8_t cal_status;
            if (hp_pt_channels.count(ch)) {
                psi = convert_hp_pt_to_pressure(static_cast<int32_t>(raw_adc), hp_pt_full_scale_psi,
                                                hp_pt_sense_resistor_ohms, hp_pt_adc_ref_voltage);
                cal_status = 1;
                if (verbose() && packet_count % 100 == 0)
                    std::cout << "[Cal] HP PT ch" << (int)ch
                              << " adc=" << static_cast<int32_t>(raw_adc) << " psi=" << psi
                              << std::endl;
            } else {
                psi = pt_calibration.calculate_pressure(ch, static_cast<int32_t>(raw_adc));
                cal_status = pt_calibration.is_calibrated(ch) ? 1u : 0u;
                if (ch == 5 && !logged_ch5.exchange(true))
                    std::cout << "[Cal] PT ch5 (Ox Up) first publish: " << psi << " psi"
                              << std::endl;
                if (verbose() && packet_count % 100 == 0)
                    std::cout << "[Cal] PT ch" << (int)ch << " adc=" << raw_adc << " psi=" << psi
                              << std::endl;
            }
            comms::messages::sensor::CalibratedPTMessage cal_msg(
                ts_ns, ch, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(psi), raw_adc,
                cal_status);
            elodin_client.publish(static_cast<uint16_t>(0x2000 | (0x10 + ch)), cal_msg);

        } else if (type_hi == 0x21) {  // TC raw
            double temp_c;
            uint8_t cal_status;
            if (tc_calibration.is_calibrated(ch)) {
                temp_c = tc_calibration.calculate(ch, static_cast<int32_t>(raw_adc));
                cal_status = 1;
            } else {
                temp_c =
                    convert_tc_adc_to_temp_c(static_cast<int32_t>(raw_adc), tc_adc_ref_voltage);
                cal_status = 0;  // default ITS-90 formula, not calibrated
            }
            if (verbose() && packet_count % 100 == 0)
                std::cout << "[Cal] TC ch" << (int)ch << " adc=" << raw_adc << " temp=" << temp_c
                          << "°C (cal=" << (int)cal_status << ")" << std::endl;
            comms::messages::sensor::CalibratedTCMessage cal_msg(
                ts_ns, ch, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(temp_c), raw_adc,
                cal_status);
            elodin_client.publish(static_cast<uint16_t>(0x2100 | (0x10 + ch)), cal_msg);

        } else if (type_hi == 0x22) {  // RTD raw
            double temp_c;
            uint8_t cal_status;
            if (rtd_calibration.is_calibrated(ch)) {
                temp_c = rtd_calibration.calculate(ch, static_cast<int32_t>(raw_adc));
                cal_status = 1;
            } else {
                temp_c =
                    convert_rtd_adc_to_temp_c(static_cast<int32_t>(raw_adc), rtd_adc_ref_voltage,
                                              rtd_excitation_ua, rtd_r0_ohm);
                cal_status = 0;  // default CVD formula, not calibrated
            }
            if (verbose() && packet_count % 100 == 0)
                std::cout << "[Cal] RTD ch" << (int)ch << " adc=" << raw_adc << " temp=" << temp_c
                          << "°C (cal=" << (int)cal_status << ")" << std::endl;
            comms::messages::sensor::CalibratedRTDMessage cal_msg(
                ts_ns, ch, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(temp_c), raw_adc,
                cal_status);
            elodin_client.publish(static_cast<uint16_t>(0x2200 | (0x10 + ch)), cal_msg);

        } else if (type_hi == 0x23) {  // LC raw
            double force_kg;
            uint8_t cal_status;
            if (lc_calibration.is_calibrated(ch)) {
                force_kg = lc_calibration.calculate(ch, static_cast<int32_t>(raw_adc));
                cal_status = 1;
            } else {
                force_kg =
                    convert_lc_adc_to_force(static_cast<int32_t>(raw_adc), lc_sensitivity_mv_per_v,
                                            lc_pga_gain, lc_full_scale_value);
                cal_status = 0;  // default ratiometric formula, not calibrated
            }
            if (verbose() && packet_count % 100 == 0)
                std::cout << "[Cal] LC ch" << (int)ch << " adc=" << raw_adc << " force=" << force_kg
                          << "kg (cal=" << (int)cal_status << ")" << std::endl;
            comms::messages::sensor::CalibratedLCMessage cal_msg(
                ts_ns, ch, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(force_kg), raw_adc,
                cal_status);
            elodin_client.publish(static_cast<uint16_t>(0x2300 | (0x10 + ch)), cal_msg);
        }

        elodin_client.flush_batch();

        packet_count++;
        if (packet_count % 10000 == 0)
            std::cout << "[Cal] Processed " << packet_count << " raw packets (type=0x" << std::hex
                      << (int)type_hi << " ch=" << (int)ch << std::dec << ")" << std::endl;
    }

    std::cout << "[Cal] Stopped." << std::endl;
    return 0;
}
