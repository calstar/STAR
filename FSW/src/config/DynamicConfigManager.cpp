#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>

#include "config/BoardDiscovery.hpp"

namespace fsw {
namespace config {

DynamicConfigManager::DynamicConfigManager() {
}

bool DynamicConfigManager::load_base_config(const std::string& config_path) {
    base_config_path_ = config_path;

    // TODO: Load TOML file using a TOML library
    // For now, create empty config structure
    config_["network"] = {};
    config_["database"] = {};
    config_["sensors"] = {};

    std::cout << "[DynamicConfig] Loaded base config from: " << config_path << std::endl;
    return true;
}

bool DynamicConfigManager::update_with_boards(const std::vector<DiscoveredBoard>& boards) {
    // Clear existing board configs
    auto it = config_.begin();
    while (it != config_.end()) {
        if (it->first.find("board_") == 0) {
            it = config_.erase(it);
        } else {
            ++it;
        }
    }

    // Update sensor counts based on discovered boards
    std::map<uint8_t, size_t> sensor_counts;
    std::map<uint8_t, std::vector<uint8_t>> sensor_channels;

    for (const auto& board : boards) {
        for (const auto& sensor : board.sensors) {
            sensor_counts[sensor.sensor_type]++;
            sensor_channels[sensor.sensor_type].push_back(sensor.channel_id);
        }
    }

    // Update sensor configuration
    if (sensor_counts.find(0x01) != sensor_counts.end()) {
        config_["sensors"]["enable_pt"] = "true";
        config_["sensors"]["pt_count"] = std::to_string(sensor_counts[0x01]);
        std::string channels;
        for (size_t i = 0; i < sensor_channels[0x01].size(); ++i) {
            if (i > 0)
                channels += ",";
            channels += std::to_string(sensor_channels[0x01][i]);
        }
        config_["sensors"]["pt_channels"] = channels;
    }

    if (sensor_counts.find(0x02) != sensor_counts.end()) {
        config_["sensors"]["enable_tc"] = "true";
        config_["sensors"]["tc_count"] = std::to_string(sensor_counts[0x02]);
        std::string channels;
        for (size_t i = 0; i < sensor_channels[0x02].size(); ++i) {
            if (i > 0)
                channels += ",";
            channels += std::to_string(sensor_channels[0x02][i]);
        }
        config_["sensors"]["tc_channels"] = channels;
    }

    if (sensor_counts.find(0x03) != sensor_counts.end()) {
        config_["sensors"]["enable_rtd"] = "true";
        config_["sensors"]["rtd_count"] = std::to_string(sensor_counts[0x03]);
        std::string channels;
        for (size_t i = 0; i < sensor_channels[0x03].size(); ++i) {
            if (i > 0)
                channels += ",";
            channels += std::to_string(sensor_channels[0x03][i]);
        }
        config_["sensors"]["rtd_channels"] = channels;
    }

    if (sensor_counts.find(0x04) != sensor_counts.end()) {
        config_["sensors"]["enable_lc"] = "true";
        config_["sensors"]["lc_count"] = std::to_string(sensor_counts[0x04]);
        std::string channels;
        for (size_t i = 0; i < sensor_channels[0x04].size(); ++i) {
            if (i > 0)
                channels += ",";
            channels += std::to_string(sensor_channels[0x04][i]);
        }
        config_["sensors"]["lc_channels"] = channels;
    }

    // Add board configurations
    size_t board_idx = 0;
    for (const auto& board : boards) {
        std::string board_key = "board_" + std::to_string(board_idx++);
        config_[board_key]["ip"] = board.current_ip;
        config_[board_key]["port"] = std::to_string(board.port);
        config_[board_key]["mac_address"] = board.mac_address;
        config_[board_key]["board_id"] = "0x" + std::to_string(board.signature.board_id);
        config_[board_key]["board_type"] = std::to_string(board.signature.board_type);
        config_[board_key]["max_sensors"] = std::to_string(board.max_sensors);
        config_[board_key]["active_sensors"] = std::to_string(board.active_sensors);
    }

    std::cout << "[DynamicConfig] Updated config with " << boards.size() << " boards" << std::endl;
    return true;
}

bool DynamicConfigManager::save_config(const std::string& output_path) const {
    std::ofstream file(output_path);
    if (!file.is_open()) {
        std::cerr << "[DynamicConfig] Failed to open config file: " << output_path << std::endl;
        return false;
    }

    // Write TOML format (simplified - use proper TOML library in production)
    file << "# Auto-generated configuration from board discovery\n";
    file << "# DO NOT EDIT MANUALLY - This file is updated automatically\n\n";

    for (const auto& [section, values] : config_) {
        file << "[" << section << "]\n";
        for (const auto& [key, value] : values) {
            file << key << " = ";
            // Check if value is a number or string
            bool is_number =
                !value.empty() && (std::isdigit(value[0]) || value[0] == '-' || value[0] == '+');
            if (is_number || value == "true" || value == "false") {
                file << value;
            } else {
                file << "\"" << value << "\"";
            }
            file << "\n";
        }
        file << "\n";
    }

    file.close();
    std::cout << "[DynamicConfig] Saved config to: " << output_path << std::endl;
    return true;
}

}  // namespace config
}  // namespace fsw
