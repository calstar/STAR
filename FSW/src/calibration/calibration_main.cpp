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

    fsw::calibration::SensorCalibrationManager lc_calibration("LC", "lbf", 3);
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
        fsw::elodin::DatabaseConfig::register_calibrated_tables(elodin_client, pt_names);
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
                fsw::elodin::DatabaseConfig::register_calibrated_tables(elodin_client, pt_names);
                elodin_client.subscribe_stream();
                std::cout << "[Cal] Reconnected to Elodin" << std::endl;
            }
            continue;
        }

        ssize_t pkt_len = elodin_client.read_packet(pkt_buf, sizeof(pkt_buf));
        if (pkt_len == 0) {
            continue;
        }
        if (pkt_len < 0) {
            // Disconnect detected by read_packet
            continue;
        }
        if (pkt_len < 8) {
            continue;
        }

        // Elodin packet header: [0-3]=len, [4]=type, [5]=vtable_hi, [6]=vtable_lo, [7]=req_id
        const uint8_t type_hi = pkt_buf[5];

        // Only process raw sensor VTables
        if (type_hi < 0x20 || type_hi > 0x23)
            continue;

        const ssize_t payload_len = pkt_len - 8;
        if (payload_len < 21)
            continue;

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
            double temp_c = tc_calibration.calculate(ch, static_cast<int32_t>(raw_adc));
            uint8_t cal_status = tc_calibration.is_calibrated(ch) ? 1u : 0u;
            comms::messages::sensor::CalibratedTCMessage cal_msg(
                ts_ns, ch, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(temp_c), raw_adc,
                cal_status);
            elodin_client.publish(static_cast<uint16_t>(0x2100 | (0x10 + ch)), cal_msg);

        } else if (type_hi == 0x22) {  // RTD raw
            double temp_c = rtd_calibration.calculate(ch, static_cast<int32_t>(raw_adc));
            uint8_t cal_status = rtd_calibration.is_calibrated(ch) ? 1u : 0u;
            comms::messages::sensor::CalibratedRTDMessage cal_msg(
                ts_ns, ch, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(temp_c), raw_adc,
                cal_status);
            elodin_client.publish(static_cast<uint16_t>(0x2200 | (0x10 + ch)), cal_msg);

        } else if (type_hi == 0x23) {  // LC raw
            double lbf = lc_calibration.calculate(ch, static_cast<int32_t>(raw_adc));
            uint8_t cal_status = lc_calibration.is_calibrated(ch) ? 1u : 0u;
            comms::messages::sensor::CalibratedLCMessage cal_msg(
                ts_ns, ch, std::array<uint8_t, 3>{0, 0, 0}, static_cast<float>(lbf), raw_adc,
                cal_status);
            elodin_client.publish(static_cast<uint16_t>(0x2300 | (0x10 + ch)), cal_msg);
        }

        elodin_client.flush_batch();

        packet_count++;
        if (packet_count % 500 == 0)
            std::cout << "[Cal] Processed " << packet_count << " raw packets (type=0x" << std::hex
                      << (int)type_hi << " ch=" << (int)ch << std::dec << ")" << std::endl;
    }

    std::cout << "[Cal] Stopped." << std::endl;
    return 0;
}
