/**
 * @file calibration_main.cpp
 * @brief Standalone Calibration Service — receives raw from relay, applies calibration, writes to
 * DB
 *
 * Subscribes to the Elodin Relay TCP forward (port 9091) for raw sensor data (PT, TC, RTD, LC).
 * Applies calibration using loaded JSON/CSV coefficients (same format as original backend).
 * HP PT channels (4-20 mA) use linear conversion from config.toml hp_pt_*.
 * Publishes calibrated sensor data to Elodin DB.
 *
 * Usage:
 *   ./calibration_service [--config PATH] [--elodin-host HOST] [--elodin-port PORT] \
 *                         [--relay-host HOST] [--relay-port PORT]
 *   CAL_VERBOSE=1 for per-packet debug output
 */

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
#include "comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "routing/SensorRouter.hpp"
#include "transport/TCPClient.hpp"

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
    std::cout << "\n[CalibrationService] Caught signal, shutting down…" << std::endl;
    running = false;
}

int main(int argc, char* argv[]) {
    std::string config_path = "config/config.toml";
    std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;
    std::string relay_host = "127.0.0.1";
    uint16_t relay_port = 9091;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc)
            config_path = argv[++i];
        else if ((arg == "--host" || arg == "--elodin-host") && i + 1 < argc)
            elodin_host = argv[++i];
        else if ((arg == "--port" || arg == "--elodin-port") && i + 1 < argc)
            elodin_port = static_cast<uint16_t>(std::atoi(argv[++i]));
        else if (arg == "--relay-host" && i + 1 < argc)
            relay_host = argv[++i];
        else if (arg == "--relay-port" && i + 1 < argc)
            relay_port = static_cast<uint16_t>(std::atoi(argv[++i]));
    }

    std::cout << "=== Calibration Service (C++) ===" << std::endl;
    std::cout << "  Elodin DB (publish): " << elodin_host << ":" << elodin_port << std::endl;
    std::cout << "  Relay TCP (receive): " << relay_host << ":" << relay_port << std::endl;

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    // Load calibration (same JSON/CSV format as original backend)
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

    // Parse HP PT config (4-20 mA) from [boards.pt_board_2] or any board with hp_pt_connectors
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

    // Connect to Elodin for publishing only (no subscription)
    fsw::elodin::ElodinClient elodin_client;
    if (!elodin_client.connect(elodin_host, elodin_port)) {
        std::cerr << "❌ Failed to connect to Elodin DB at " << elodin_host << ":" << elodin_port
                  << std::endl;
        return 1;
    }

    fsw::elodin::DatabaseConfig::register_calibrated_tables(elodin_client, pt_names);
    std::cout << "📡 Elodin connected (publish only). Registered calibrated VTables." << std::endl;

    // Connect to relay TCP for receiving raw packets
    daq_comms::transport::TCPClient relay_client;
    if (!relay_client.connect(relay_host, relay_port)) {
        std::cerr << "❌ Failed to connect to relay at " << relay_host << ":" << relay_port
                  << " (ensure relay is running with RELAY_TCP_FORWARD_PORT=" << relay_port << ")"
                  << std::endl;
        return 1;
    }
    std::cout << "📡 Relay TCP connected. Receiving raw stream." << std::endl;
    if (verbose())
        std::cout << "[Cal] CAL_VERBOSE=1 — debug output enabled" << std::endl;

    fsw::routing::SensorRouter router;
    router.set_pt_calibration(&pt_calibration);
    router.set_tc_calibration(&tc_calibration);
    router.set_rtd_calibration(&rtd_calibration);
    router.set_lc_calibration(&lc_calibration);

    std::vector<uint8_t> rx_buffer(8192);
    int packet_count = 0;

    while (running && relay_client.is_connected() && elodin_client.is_connected()) {
        uint8_t header[8];
        if (!relay_client.read_exact(header, 8)) {
            if (!relay_client.is_connected())
                break;
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }

        uint32_t packet_len = *reinterpret_cast<uint32_t*>(header);
        uint8_t type_hi = header[5];
        uint8_t channel_id = header[6];

        if (packet_len < 4 || packet_len > 65536) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }

        size_t payload_len = packet_len - 4;
        if (payload_len + 8 > rx_buffer.size())
            rx_buffer.resize(payload_len + 8);

        std::memcpy(rx_buffer.data(), header, 8);
        if (payload_len > 0) {
            if (!relay_client.read_exact(rx_buffer.data() + 8, payload_len))
                break;
        }

        if (channel_id > 0 && channel_id <= 15) {
            if (type_hi == 0x20) {  // PT Raw
                if (payload_len >= comms::messages::sensor::RawPTMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 8;
                    comms::messages::sensor::RawPTMessage raw_msg;
                    raw_msg.deserialize(payload);

                    uint64_t ts_ns = raw_msg.getField<0>();
                    uint8_t ch = raw_msg.getField<1>();
                    int32_t raw_adc = static_cast<int32_t>(raw_msg.getField<3>());
                    uint32_t sample_ts = raw_msg.getField<4>();
                    uint8_t status = raw_msg.getField<5>();

                    elodin_client.begin_batch();

                    if (hp_pt_channels.count(ch)) {
                        double psi = convert_hp_pt_to_pressure(raw_adc, hp_pt_full_scale_psi,
                                                               hp_pt_sense_resistor_ohms,
                                                               hp_pt_adc_ref_voltage);
                        std::array<uint8_t, 2> pkt_id = {0x20, static_cast<uint8_t>(0x10 + ch)};
                        comms::messages::sensor::CalibratedPTMessage cal_msg;
                        cal_msg.setField<0>(ts_ns);
                        cal_msg.setField<1>(ch);
                        cal_msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                        cal_msg.setField<3>(static_cast<float>(psi));
                        cal_msg.setField<4>(static_cast<uint32_t>(raw_adc));
                        cal_msg.setField<5>(static_cast<uint8_t>(1));
                        elodin_client.publish(pkt_id, cal_msg);
                        if (verbose() && (packet_count % 100 == 0))
                            std::cout << "[Cal] HP PT ch" << (int)ch << " adc=" << raw_adc
                                      << " psi=" << psi << std::endl;
                    } else {
                        daq_comms::protocol::SensorBatch batch;
                        daq_comms::protocol::RawPTSample pt;
                        pt.channel_id = ch;
                        pt.raw_adc_counts = static_cast<uint32_t>(raw_adc);
                        pt.sample_timestamp_ms = sample_ts;
                        pt.status_flags = status;
                        batch.pt_samples.push_back(pt);
                        auto cal_msgs = router.route_pt_samples_calibrated(batch, ts_ns);
                        for (const auto& [id, msg] : cal_msgs) {
                            elodin_client.publish(id, msg);
                            if (verbose() && (packet_count % 100 == 0))
                                std::cout << "[Cal] PT ch" << (int)ch << " poly" << std::endl;
                        }
                    }
                    elodin_client.flush_batch();
                }
            } else if (type_hi == 0x21) {  // TC Raw
                if (payload_len >= comms::messages::sensor::RawTCMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 8;
                    comms::messages::sensor::RawTCMessage raw_msg;
                    raw_msg.deserialize(payload);

                    uint64_t ts_ns = raw_msg.getField<0>();
                    uint8_t ch = raw_msg.getField<1>();
                    uint32_t raw_adc = raw_msg.getField<3>();
                    uint32_t sample_ts = raw_msg.getField<4>();
                    uint8_t status = raw_msg.getField<5>();

                    daq_comms::protocol::SensorBatch batch;
                    daq_comms::protocol::RawTCSample tc;
                    tc.channel_id = ch;
                    tc.raw_adc_counts = raw_adc;
                    tc.sample_timestamp_ms = sample_ts;
                    tc.status_flags = status;
                    batch.tc_samples.push_back(tc);
                    auto cal_msgs = router.route_tc_samples_calibrated(batch, ts_ns);
                    elodin_client.begin_batch();
                    for (const auto& [id, msg] : cal_msgs)
                        elodin_client.publish(id, msg);
                    elodin_client.flush_batch();
                }
            } else if (type_hi == 0x22) {  // RTD Raw
                if (payload_len >= comms::messages::sensor::RawRTDMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 8;
                    comms::messages::sensor::RawRTDMessage raw_msg;
                    raw_msg.deserialize(payload);

                    uint64_t ts_ns = raw_msg.getField<0>();
                    uint8_t ch = raw_msg.getField<1>();
                    uint32_t raw_adc = raw_msg.getField<3>();
                    uint32_t sample_ts = raw_msg.getField<4>();
                    uint8_t status = raw_msg.getField<5>();

                    daq_comms::protocol::SensorBatch batch;
                    daq_comms::protocol::RawRTDSample rtd;
                    rtd.channel_id = ch;
                    rtd.raw_resistance_counts = raw_adc;
                    rtd.sample_timestamp_ms = sample_ts;
                    rtd.status_flags = status;
                    batch.rtd_samples.push_back(rtd);
                    auto cal_msgs = router.route_rtd_samples_calibrated(batch, ts_ns);
                    elodin_client.begin_batch();
                    for (const auto& [id, msg] : cal_msgs)
                        elodin_client.publish(id, msg);
                    elodin_client.flush_batch();
                }
            } else if (type_hi == 0x23) {  // LC Raw
                if (payload_len >= comms::messages::sensor::RawLCMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 8;
                    comms::messages::sensor::RawLCMessage raw_msg;
                    raw_msg.deserialize(payload);

                    uint64_t ts_ns = raw_msg.getField<0>();
                    uint8_t ch = raw_msg.getField<1>();
                    uint32_t raw_adc = raw_msg.getField<3>();
                    uint32_t sample_ts = raw_msg.getField<4>();
                    uint8_t status = raw_msg.getField<5>();

                    daq_comms::protocol::SensorBatch batch;
                    daq_comms::protocol::RawLCSample lc;
                    lc.channel_id = ch;
                    lc.raw_adc_counts = raw_adc;
                    lc.sample_timestamp_ms = sample_ts;
                    lc.status_flags = status;
                    batch.lc_samples.push_back(lc);
                    auto cal_msgs = router.route_lc_samples_calibrated(batch, ts_ns);
                    elodin_client.begin_batch();
                    for (const auto& [id, msg] : cal_msgs)
                        elodin_client.publish(id, msg);
                    elodin_client.flush_batch();
                }
            }
        }

        packet_count++;
        if (packet_count % 500 == 0)
            std::cout << "[Cal] Processed " << packet_count << " raw packets (type=0x" << std::hex
                      << (int)type_hi << " ch=" << (int)channel_id << std::dec << ")" << std::endl;
    }

    std::cout << "✅ Calibration Service stopped." << std::endl;
    return 0;
}
