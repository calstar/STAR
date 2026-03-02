/**
 * @file calibration_main.cpp
 * @brief Standalone DB-centric Calibration Service
 *
 * Subscribes to Elodin DB for raw sensor data (PT, TC, RTD, LC).
 * Applies calibration using the loaded configurations.
 * Publishes calibrated sensor data back to Elodin DB.
 *
 * Usage:
 *   ./calibration_service [--config /path/to/config.toml] [--host HOST] [--port PORT]
 */

#include <csignal>
#include <iostream>
#include <map>
#include <string>
#include <thread>
#include <vector>

#include "calibration/PTCalibration.hpp"
#include "calibration/SensorCalibration.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "routing/SensorRouter.hpp"

// Message headers (need access to RawPTMessage to deserialize and CalibratedPTMessage to serialize)
#include "comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"

static std::atomic<bool> running{true};

static void signalHandler(int /*sig*/) {
    std::cout << "\n[CalibrationService] Caught signal, shutting down…" << std::endl;
    running = false;
}

int main(int argc, char* argv[]) {
    std::string config_path = "../../config/config.toml";
    std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc)
            config_path = argv[++i];
        else if (arg == "--host" && i + 1 < argc)
            elodin_host = argv[++i];
        else if (arg == "--port" && i + 1 < argc)
            elodin_port = static_cast<uint16_t>(std::atoi(argv[++i]));
    }

    std::cout << "=== Standalone Calibration Service ===" << std::endl;
    std::cout << "Elodin DB: " << elodin_host << ":" << elodin_port << std::endl;

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    // Initialize Calibration Managers
    fsw::calibration::PTCalibrationManager pt_calibration;
    pt_calibration
        .load_calibration();  // Loads PT configs using default directories OR we load manually.
    // Better to use a ConfigParser or explicitly load JSON
    // We'll let load_calibration() find the default json file.
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

    // We use ElodinClient to subscribe to RAW and publish CALIBRATED
    fsw::elodin::ElodinClient elodin_client;
    if (!elodin_client.connect(elodin_host, elodin_port)) {
        std::cerr << "❌ Failed to connect to Elodin DB at " << elodin_host << ":" << elodin_port
                  << std::endl;
        return 1;
    }

    // Register Tables (So that DB knows the structure of CALIBRATED packets we will push)
    fsw::elodin::DatabaseConfig::register_tables(elodin_client, nullptr, nullptr);

    // Setup Subscriptions to RAW Tables (0x20=PT, 0x21=TC, 0x22=RTD, 0x23=LC)
    // Send a TABLE subscribe stream command for 0x20_00 to 0x23_00 across necessary channels
    // Subscribe to all streaming data using the generic Stream message
    elodin_client.subscribe_stream();
    std::cout << "📡 Connected to Elodin DB. Subscribed to Raw tables. Awaiting raw stream (Note: "
                 "requires Elodin subscription relay) \n"
              << std::endl;

    // Use SensorRouter to actually convert raw samples to calibrated samples and build DB messages.
    // (A hack here is that we can pretend to build a SensorBatch, send it through router, and
    // publish)
    fsw::routing::SensorRouter router;
    router.set_pt_calibration(&pt_calibration);
    router.set_tc_calibration(&tc_calibration);
    router.set_rtd_calibration(&rtd_calibration);
    router.set_lc_calibration(&lc_calibration);

    // Buffer for reading incoming packets
    std::vector<uint8_t> rx_buffer(8192);

    int packet_count = 0;
    while (running && elodin_client.is_connected()) {
        // Read header first (12 bytes)
        uint8_t header[12];
        if (!elodin_client.read_packet_header(header)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }

        uint32_t packet_len = *reinterpret_cast<uint32_t*>(header);
        uint8_t packet_type = header[4];
        uint16_t packet_id = (static_cast<uint16_t>(header[5]) << 8) | header[6];

        if (packet_count % 100 == 0) {
            std::cout << "[Debug] Rx Header: len=" << packet_len << " type=" << (int)packet_type
                      << " id=" << packet_id << std::endl;
        }

        if (packet_len > rx_buffer.size()) {
            rx_buffer.resize(packet_len);
        }

        // Copy header to rx_buffer
        std::memcpy(rx_buffer.data(), header, 12);

        // Read payload
        size_t payload_len = packet_len - 12;
        if (payload_len > 0) {
            ssize_t read_bytes = elodin_client.read_data(rx_buffer.data() + 12, payload_len);
            if (read_bytes != static_cast<ssize_t>(payload_len))
                continue;
        }

        // We only care about TABLE publishes (type generic or 0) that have raw DB IDs.
        // E.g. 0x20_XX for PT, 0x21_XX for TC, etc. where XX is channel_id (1-10)
        uint8_t type_hi = header[5];
        uint8_t channel_id = header[6];

        if (channel_id > 0 && channel_id <= 15) {
            if (type_hi == 0x20) {  // PT Raw
                if (payload_len >= comms::messages::sensor::RawPTMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 12;

                    // Deserialize using CommsMessage — matches FSW pattern
                    comms::messages::sensor::RawPTMessage raw_msg;
                    raw_msg.deserialize(payload);

                    uint64_t ts_ns = raw_msg.getField<0>();  // timestamp_ns
                    uint8_t ch = raw_msg.getField<1>();      // channel_id
                    // field 2 = padding (skip)
                    uint32_t raw_adc = raw_msg.getField<3>();    // raw_adc_counts
                    uint32_t sample_ts = raw_msg.getField<4>();  // sample_timestamp_ms
                    uint8_t status = raw_msg.getField<5>();      // status_flags

                    daq_comms::protocol::SensorBatch batch;
                    daq_comms::protocol::RawPTSample pt;
                    pt.channel_id = ch;
                    pt.raw_adc_counts = raw_adc;
                    pt.sample_timestamp_ms = sample_ts;
                    pt.status_flags = status;
                    batch.pt_samples.push_back(pt);

                    auto cal_msgs = router.route_pt_samples_calibrated(batch, ts_ns);
                    for (const auto& [id, msg] : cal_msgs) {
                        elodin_client.publish(id, msg);
                    }
                }
            } else if (type_hi == 0x21) {  // TC Raw
                if (payload_len >= comms::messages::sensor::RawTCMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 12;

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
                    for (const auto& [id, msg] : cal_msgs)
                        elodin_client.publish(id, msg);
                }
            } else if (type_hi == 0x22) {  // RTD Raw
                if (payload_len >= comms::messages::sensor::RawRTDMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 12;

                    comms::messages::sensor::RawRTDMessage raw_msg;
                    raw_msg.deserialize(payload);

                    uint64_t ts_ns = raw_msg.getField<0>();
                    uint8_t ch = raw_msg.getField<1>();
                    uint32_t raw_adc = raw_msg.getField<3>();  // raw_resistance_counts
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
                    for (const auto& [id, msg] : cal_msgs)
                        elodin_client.publish(id, msg);
                }
            } else if (type_hi == 0x23) {  // LC Raw
                if (payload_len >= comms::messages::sensor::RawLCMessage::nbytes()) {
                    uint8_t* payload = rx_buffer.data() + 12;

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
                    for (const auto& [id, msg] : cal_msgs)
                        elodin_client.publish(id, msg);
                }
            }
        }

        packet_count++;
        if (packet_count % 500 == 0) {
            std::cout << "Processed " << packet_count << " raw packets..." << std::endl;
        }

        elodin_client.flush_buffer();
    }

    std::cout << "✅ Calibration Service stopped." << std::endl;
    return 0;
}
