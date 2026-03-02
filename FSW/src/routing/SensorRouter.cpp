#include "routing/SensorRouter.hpp"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <sstream>

namespace fsw {
namespace routing {

SensorRouter::SensorRouter() {
    // Default table IDs (can be overridden by config)
    // These should match what's configured in Elodin
    // For now, use simple sequential IDs
}

bool SensorRouter::load_config(const std::string& config_path) {
    // TODO: Implement TOML parsing
    // For now, use hardcoded defaults matching config/sensor_routing.toml
    // This will be implemented when we add TOML parsing library

    // PT channels
    SensorChannelConfig pt_chamber{.channel_id = 0,
                                   .table_name = "pt_chamber_raw",
                                   .table_id = {0x20, 0x00},  // Table ID 0x2000
                                   .sensor_type = "PT",
                                   .location = "chamber"};
    add_channel(pt_chamber);

    SensorChannelConfig pt_fuel_inlet{.channel_id = 1,
                                      .table_name = "pt_fuel_inlet_raw",
                                      .table_id = {0x20, 0x01},  // Table ID 0x2001
                                      .sensor_type = "PT",
                                      .location = "fuel_inlet"};
    add_channel(pt_fuel_inlet);

    SensorChannelConfig pt_ox_inlet{.channel_id = 2,
                                    .table_name = "pt_ox_inlet_raw",
                                    .table_id = {0x20, 0x02},  // Table ID 0x2002
                                    .sensor_type = "PT",
                                    .location = "ox_inlet"};
    add_channel(pt_ox_inlet);

    // TC channels
    SensorChannelConfig tc_exhaust{.channel_id = 0,
                                   .table_name = "tc_exhaust_raw",
                                   .table_id = {0x21, 0x00},  // Table ID 0x2100
                                   .sensor_type = "TC",
                                   .location = "exhaust"};
    add_channel(tc_exhaust);

    SensorChannelConfig tc_chamber{.channel_id = 1,
                                   .table_name = "tc_chamber_raw",
                                   .table_id = {0x21, 0x01},  // Table ID 0x2101
                                   .sensor_type = "TC",
                                   .location = "chamber"};
    add_channel(tc_chamber);

    // RTD channels
    SensorChannelConfig rtd_fuel{.channel_id = 0,
                                 .table_name = "rtd_fuel_raw",
                                 .table_id = {0x22, 0x00},  // Table ID 0x2200
                                 .sensor_type = "RTD",
                                 .location = "fuel"};
    add_channel(rtd_fuel);

    SensorChannelConfig rtd_ox{.channel_id = 1,
                               .table_name = "rtd_ox_raw",
                               .table_id = {0x22, 0x01},  // Table ID 0x2201
                               .sensor_type = "RTD",
                               .location = "ox"};
    add_channel(rtd_ox);

    // LC channels
    SensorChannelConfig lc_thrust{.channel_id = 0,
                                  .table_name = "lc_thrust_raw",
                                  .table_id = {0x23, 0x00},  // Table ID 0x2300
                                  .sensor_type = "LC",
                                  .location = "thrust"};
    add_channel(lc_thrust);

    return true;
}

void SensorRouter::add_channel(const SensorChannelConfig& config) {
    std::string key = make_key(config.sensor_type, config.channel_id);
    channel_map_[key] = config;
}

std::array<uint8_t, 2> SensorRouter::get_table_id(const std::string& sensor_type,
                                                  uint8_t channel_id) const {
    std::string key = make_key(sensor_type, channel_id);
    auto it = channel_map_.find(key);
    if (it != channel_map_.end()) {
        return it->second.table_id;
    }
    // Default fallback table ID
    return {0x00, 0x00};
}

std::string SensorRouter::get_table_name(const std::string& sensor_type, uint8_t channel_id) const {
    std::string key = make_key(sensor_type, channel_id);
    auto it = channel_map_.find(key);
    if (it != channel_map_.end()) {
        return it->second.table_name;
    }
    return "unknown_" + sensor_type + "_" + std::to_string(channel_id);
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawPTMessage>>
SensorRouter::route_pt_samples(const daq_comms::protocol::SensorBatch& batch,
                               uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawPTMessage>> messages;

    for (const auto& sample : batch.pt_samples) {
        // Per-channel packet_id: {0x20, channel_id} — channel_id is already 1-indexed connector
        std::array<uint8_t, 2> pkt_id = {0x20, static_cast<uint8_t>(sample.channel_id)};

        comms::messages::sensor::RawPTMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(sample.raw_adc_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);

        messages.emplace_back(pkt_id, msg);
    }

    return messages;
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedPTMessage>>
SensorRouter::route_pt_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                          uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedPTMessage>>
        messages;

    if (!pt_calibration_) {
        return messages;
    }

    for (const auto& sample : batch.pt_samples) {
        // Per-channel calibrated packet_id: {0x20, 0x10 + channel_id} — channel_id is already
        // 1-indexed connector
        std::array<uint8_t, 2> pkt_id = {0x20, static_cast<uint8_t>(0x10 + sample.channel_id)};

        int32_t adc_code = static_cast<int32_t>(sample.raw_adc_counts);
        double pressure_psi = pt_calibration_->calculate_pressure(sample.channel_id, adc_code);
        uint8_t calibration_status = pt_calibration_->is_calibrated(sample.channel_id) ? 1 : 0;

        comms::messages::sensor::CalibratedPTMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(static_cast<float>(pressure_psi));
        msg.setField<4>(sample.raw_adc_counts);
        msg.setField<5>(calibration_status);

        messages.emplace_back(pkt_id, msg);
    }

    return messages;
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawTCMessage>>
SensorRouter::route_tc_samples(const daq_comms::protocol::SensorBatch& batch,
                               uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawTCMessage>> messages;

    for (const auto& sample : batch.tc_samples) {
        std::array<uint8_t, 2> pkt_id = {0x21, static_cast<uint8_t>(sample.channel_id)};

        comms::messages::sensor::RawTCMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(sample.raw_adc_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);

        messages.emplace_back(pkt_id, msg);
    }

    return messages;
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawRTDMessage>>
SensorRouter::route_rtd_samples(const daq_comms::protocol::SensorBatch& batch,
                                uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawRTDMessage>> messages;

    for (const auto& sample : batch.rtd_samples) {
        std::array<uint8_t, 2> pkt_id = {0x22, static_cast<uint8_t>(sample.channel_id)};

        comms::messages::sensor::RawRTDMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(sample.raw_resistance_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);

        messages.emplace_back(pkt_id, msg);
    }

    return messages;
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawLCMessage>>
SensorRouter::route_lc_samples(const daq_comms::protocol::SensorBatch& batch,
                               uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawLCMessage>> messages;

    for (const auto& sample : batch.lc_samples) {
        std::array<uint8_t, 2> pkt_id = {0x23, static_cast<uint8_t>(sample.channel_id)};

        comms::messages::sensor::RawLCMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(sample.raw_adc_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);

        messages.emplace_back(pkt_id, msg);
    }

    return messages;
}

// ── Calibrated TC ─────────────────────────────────────────────────────────
std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedTCMessage>>
SensorRouter::route_tc_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                          uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedTCMessage>>
        messages;
    if (!tc_calibration_)
        return messages;

    for (const auto& sample : batch.tc_samples) {
        // Calibrated TC packet_id: {0x21, 0x10 + channel_id} — channel_id is already 1-indexed
        // connector
        std::array<uint8_t, 2> pkt_id = {0x21, static_cast<uint8_t>(0x10 + sample.channel_id)};
        int32_t raw = static_cast<int32_t>(sample.raw_adc_counts);
        double temp_c = tc_calibration_->calculate(sample.channel_id, raw);
        uint8_t status = tc_calibration_->is_calibrated(sample.channel_id) ? 1 : 0;

        comms::messages::sensor::CalibratedTCMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(static_cast<float>(temp_c));
        msg.setField<4>(sample.raw_adc_counts);
        msg.setField<5>(status);
        messages.emplace_back(pkt_id, msg);
    }
    return messages;
}

// ── Calibrated RTD ────────────────────────────────────────────────────────
std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedRTDMessage>>
SensorRouter::route_rtd_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                           uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedRTDMessage>>
        messages;
    if (!rtd_calibration_)
        return messages;

    for (const auto& sample : batch.rtd_samples) {
        // Calibrated RTD packet_id: {0x22, 0x10 + channel_id} — channel_id is already 1-indexed
        // connector
        std::array<uint8_t, 2> pkt_id = {0x22, static_cast<uint8_t>(0x10 + sample.channel_id)};
        int32_t raw = static_cast<int32_t>(sample.raw_resistance_counts);
        double temp_c = rtd_calibration_->calculate(sample.channel_id, raw);
        uint8_t status = rtd_calibration_->is_calibrated(sample.channel_id) ? 1 : 0;

        comms::messages::sensor::CalibratedRTDMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(static_cast<float>(temp_c));
        msg.setField<4>(sample.raw_resistance_counts);
        msg.setField<5>(status);
        messages.emplace_back(pkt_id, msg);
    }
    return messages;
}

// ── Calibrated LC ─────────────────────────────────────────────────────────
std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedLCMessage>>
SensorRouter::route_lc_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                          uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedLCMessage>>
        messages;
    if (!lc_calibration_)
        return messages;

    for (const auto& sample : batch.lc_samples) {
        // Calibrated LC packet_id: {0x23, 0x10 + channel_id} — channel_id is already 1-indexed
        // connector
        std::array<uint8_t, 2> pkt_id = {0x23, static_cast<uint8_t>(0x10 + sample.channel_id)};
        int32_t raw = static_cast<int32_t>(sample.raw_adc_counts);
        double force = lc_calibration_->calculate(sample.channel_id, raw);
        uint8_t status = lc_calibration_->is_calibrated(sample.channel_id) ? 1 : 0;

        comms::messages::sensor::CalibratedLCMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(static_cast<uint8_t>(sample.channel_id));
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
        msg.setField<3>(static_cast<float>(force));
        msg.setField<4>(sample.raw_adc_counts);
        msg.setField<5>(status);
        messages.emplace_back(pkt_id, msg);
    }
    return messages;
}

std::string SensorRouter::make_key(const std::string& sensor_type, uint8_t channel_id) const {
    return sensor_type + ":" + std::to_string(channel_id);
}

}  // namespace routing
}  // namespace fsw
