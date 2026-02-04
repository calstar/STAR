#include "routing/SensorRouter.hpp"

#include <iostream>
#include <sstream>

namespace daq_comms {
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
    SensorChannelConfig pt_chamber{
        .channel_id = 0,
        .table_name = "pt_chamber_raw",
        .table_id = {0x20, 0x00}, // Table ID 0x2000
        .sensor_type = "PT",
        .location = "chamber"
    };
    add_channel(pt_chamber);
    
    SensorChannelConfig pt_fuel_inlet{
        .channel_id = 1,
        .table_name = "pt_fuel_inlet_raw",
        .table_id = {0x20, 0x01}, // Table ID 0x2001
        .sensor_type = "PT",
        .location = "fuel_inlet"
    };
    add_channel(pt_fuel_inlet);
    
    SensorChannelConfig pt_ox_inlet{
        .channel_id = 2,
        .table_name = "pt_ox_inlet_raw",
        .table_id = {0x20, 0x02}, // Table ID 0x2002
        .sensor_type = "PT",
        .location = "ox_inlet"
    };
    add_channel(pt_ox_inlet);
    
    // TC channels
    SensorChannelConfig tc_exhaust{
        .channel_id = 0,
        .table_name = "tc_exhaust_raw",
        .table_id = {0x21, 0x00}, // Table ID 0x2100
        .sensor_type = "TC",
        .location = "exhaust"
    };
    add_channel(tc_exhaust);
    
    SensorChannelConfig tc_chamber{
        .channel_id = 1,
        .table_name = "tc_chamber_raw",
        .table_id = {0x21, 0x01}, // Table ID 0x2101
        .sensor_type = "TC",
        .location = "chamber"
    };
    add_channel(tc_chamber);
    
    // RTD channels
    SensorChannelConfig rtd_fuel{
        .channel_id = 0,
        .table_name = "rtd_fuel_raw",
        .table_id = {0x22, 0x00}, // Table ID 0x2200
        .sensor_type = "RTD",
        .location = "fuel"
    };
    add_channel(rtd_fuel);
    
    SensorChannelConfig rtd_ox{
        .channel_id = 1,
        .table_name = "rtd_ox_raw",
        .table_id = {0x22, 0x01}, // Table ID 0x2201
        .sensor_type = "RTD",
        .location = "ox"
    };
    add_channel(rtd_ox);
    
    // LC channels
    SensorChannelConfig lc_thrust{
        .channel_id = 0,
        .table_name = "lc_thrust_raw",
        .table_id = {0x23, 0x00}, // Table ID 0x2300
        .sensor_type = "LC",
        .location = "thrust"
    };
    add_channel(lc_thrust);
    
    return true;
}

void SensorRouter::add_channel(const SensorChannelConfig& config) {
    std::string key = make_key(config.sensor_type, config.channel_id);
    channel_map_[key] = config;
}

std::array<uint8_t, 2> SensorRouter::get_table_id(const std::string& sensor_type, uint8_t channel_id) const {
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
SensorRouter::route_pt_samples(const protocol::SensorBatch& batch, uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawPTMessage>> messages;
    
    // Use ONE packet_id per sensor type (like FSW), not per channel
    static constexpr std::array<uint8_t, 2> PT_PACKET_ID = {0x20, 0x00};
    
    for (const auto& sample : batch.pt_samples) {
        comms::messages::sensor::RawPTMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(sample.channel_id);  // channel_id distinguishes channels
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding bytes for alignment
        msg.setField<3>(sample.raw_adc_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);
        
        // Debug: Verify message construction
        static size_t debug_count = 0;
        if (debug_count++ < 3) {
            std::cout << "[Router] PT message: ts=" << receive_timestamp_ns 
                      << ", ch=" << (int)sample.channel_id 
                      << ", adc=" << sample.raw_adc_counts
                      << ", packet_id=[" << std::hex << (int)PT_PACKET_ID[0] << ", " << (int)PT_PACKET_ID[1] << std::dec << "]\n";
        }
        
        messages.emplace_back(PT_PACKET_ID, msg);
    }
    
    return messages;
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawTCMessage>> 
SensorRouter::route_tc_samples(const protocol::SensorBatch& batch, uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawTCMessage>> messages;
    
    // Use ONE packet_id per sensor type (like FSW)
    static constexpr std::array<uint8_t, 2> TC_PACKET_ID = {0x21, 0x00};
    
    for (const auto& sample : batch.tc_samples) {
        comms::messages::sensor::RawTCMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(sample.channel_id);
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding bytes for alignment
        msg.setField<3>(sample.raw_adc_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);
        
        messages.emplace_back(TC_PACKET_ID, msg);
    }
    
    return messages;
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawRTDMessage>> 
SensorRouter::route_rtd_samples(const protocol::SensorBatch& batch, uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawRTDMessage>> messages;
    
    // Use ONE packet_id per sensor type (like FSW)
    static constexpr std::array<uint8_t, 2> RTD_PACKET_ID = {0x22, 0x00};
    
    for (const auto& sample : batch.rtd_samples) {
        comms::messages::sensor::RawRTDMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(sample.channel_id);
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding bytes for alignment
        msg.setField<3>(sample.raw_resistance_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);
        
        messages.emplace_back(RTD_PACKET_ID, msg);
    }
    
    return messages;
}

std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawLCMessage>> 
SensorRouter::route_lc_samples(const protocol::SensorBatch& batch, uint64_t receive_timestamp_ns) const {
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawLCMessage>> messages;
    
    // Use ONE packet_id per sensor type (like FSW)
    static constexpr std::array<uint8_t, 2> LC_PACKET_ID = {0x23, 0x00};
    
    for (const auto& sample : batch.lc_samples) {
        comms::messages::sensor::RawLCMessage msg;
        msg.setField<0>(receive_timestamp_ns);
        msg.setField<1>(sample.channel_id);
        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding bytes for alignment
        msg.setField<3>(sample.raw_adc_counts);
        msg.setField<4>(sample.sample_timestamp_ms);
        msg.setField<5>(sample.status_flags);
        
        messages.emplace_back(LC_PACKET_ID, msg);
    }
    
    return messages;
}

std::string SensorRouter::make_key(const std::string& sensor_type, uint8_t channel_id) const {
    return sensor_type + ":" + std::to_string(channel_id);
}

} // namespace routing
} // namespace daq_comms

