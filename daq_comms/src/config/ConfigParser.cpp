#include "config/ConfigParser.hpp"

#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>

namespace daq_comms {
namespace config {

bool ConfigParser::load_config(const std::string& config_path) {
    std::ifstream file(config_path);
    if (!file.is_open()) {
        std::cerr << "[ConfigParser] Failed to open config file: " << config_path << std::endl;
        return false;
    }

    std::string line;
    std::string current_section;
    std::map<std::string, std::string> current_fields;
    std::string current_sensor_id;

    // Simple TOML parser - handles:
    // [section.subsection]
    // key = value
    // key = [value1, value2]  # For arrays like packet_id
    // sensor_id = { key1 = value1, key2 = value2 }

    while (std::getline(file, line)) {
        // Remove comments
        size_t comment_pos = line.find('#');
        if (comment_pos != std::string::npos) {
            line = line.substr(0, comment_pos);
        }

        // Trim whitespace
        line.erase(0, line.find_first_not_of(" \t"));
        line.erase(line.find_last_not_of(" \t") + 1);

        if (line.empty()) {
            continue;
        }

        // Check for section header [section.subsection]
        if (line.front() == '[' && line.back() == ']') {
            // Save previous sensor entry if any
            if (!current_sensor_id.empty() && !current_fields.empty()) {
                parse_sensor_entry(current_sensor_id, current_section, current_fields);
                current_fields.clear();
            }
            current_section = line.substr(1, line.length() - 2);
            current_sensor_id.clear();
            continue;
        }

        // Check for sensor entry: sensor_id = { ... }
        std::regex sensor_entry_regex(R"((\w+)\s*=\s*\{)");
        std::smatch match;
        if (std::regex_search(line, match, sensor_entry_regex)) {
            // Save previous sensor entry if any
            if (!current_sensor_id.empty() && !current_fields.empty()) {
                parse_sensor_entry(current_sensor_id, current_section, current_fields);
                current_fields.clear();
            }
            current_sensor_id = match[1].str();
            continue;
        }

        // Check for field: key = value or key = [value1, value2]
        std::regex field_regex(R"((\w+)\s*=\s*(.+))");
        if (std::regex_search(line, match, field_regex)) {
            std::string key = match[1].str();
            std::string value = match[2].str();

            // Trim value
            value.erase(0, value.find_first_not_of(" \t"));
            value.erase(value.find_last_not_of(" \t") + 1);

            // Handle array values like packet_id = [0x20, 0x00]
            if (value.front() == '[' && value.back() == ']') {
                value = value.substr(1, value.length() - 2);  // Remove brackets
                // Parse array elements
                std::istringstream iss(value);
                std::string element;
                std::vector<std::string> elements;
                while (std::getline(iss, element, ',')) {
                    element.erase(0, element.find_first_not_of(" \t"));
                    element.erase(element.find_last_not_of(" \t") + 1);
                    elements.push_back(element);
                }
                if (key == "packet_id" && elements.size() == 2) {
                    // Parse hex values
                    uint8_t msb = static_cast<uint8_t>(std::stoul(elements[0], nullptr, 16));
                    uint8_t lsb = static_cast<uint8_t>(std::stoul(elements[1], nullptr, 16));
                    current_fields["packet_id_msb"] = std::to_string(msb);
                    current_fields["packet_id_lsb"] = std::to_string(lsb);
                }
            } else {
                // Remove quotes if present
                if (value.front() == '"' && value.back() == '"') {
                    value = value.substr(1, value.length() - 2);
                }
                current_fields[key] = value;
            }
            continue;
        }

        // Check for closing brace }
        if (line.find('}') != std::string::npos) {
            if (!current_sensor_id.empty() && !current_fields.empty()) {
                parse_sensor_entry(current_sensor_id, current_section, current_fields);
                current_fields.clear();
                current_sensor_id.clear();
            }
        }
    }

    // Save last sensor entry if any
    if (!current_sensor_id.empty() && !current_fields.empty()) {
        parse_sensor_entry(current_sensor_id, current_section, current_fields);
    }

    std::cout << "[ConfigParser] Loaded " << sensor_assignments_.size()
              << " sensor definitions from " << config_path << std::endl;
    return true;
}

bool ConfigParser::parse_sensor_entry(const std::string& sensor_id, const std::string& section_path,
                                      const std::map<std::string, std::string>& fields) {
    SensorAssignment assignment;
    assignment.sensor_id = sensor_id;
    assignment.sensor_type = parse_sensor_type(section_path);
    assignment.system_state = parse_system_state(section_path);

    // Parse required fields
    if (fields.find("board_id") != fields.end()) {
        assignment.board_id = static_cast<uint8_t>(std::stoul(fields.at("board_id")));
    } else {
        std::cerr << "[ConfigParser] Missing board_id for sensor: " << sensor_id << std::endl;
        return false;
    }

    if (fields.find("channel") != fields.end()) {
        assignment.channel_id = static_cast<uint8_t>(std::stoul(fields.at("channel")));
    } else {
        std::cerr << "[ConfigParser] Missing channel for sensor: " << sensor_id << std::endl;
        return false;
    }

    // Parse packet_id
    if (fields.find("packet_id_msb") != fields.end() &&
        fields.find("packet_id_lsb") != fields.end()) {
        assignment.packet_id[0] = static_cast<uint8_t>(std::stoul(fields.at("packet_id_msb")));
        assignment.packet_id[1] = static_cast<uint8_t>(std::stoul(fields.at("packet_id_lsb")));
    } else {
        std::cerr << "[ConfigParser] Missing packet_id for sensor: " << sensor_id << std::endl;
        return false;
    }

    // Parse optional fields
    if (fields.find("purpose") != fields.end()) {
        assignment.purpose = fields.at("purpose");
    }
    if (fields.find("location") != fields.end()) {
        assignment.location = fields.at("location");
    }
    if (fields.find("max_psi") != fields.end()) {
        // Store max_psi in purpose for now (could add to struct later)
    }

    assignment.is_active = true;
    assignment.board_port = 5005;  // Default port

    sensor_assignments_[sensor_id] = assignment;
    return true;
}

SensorType ConfigParser::parse_sensor_type(const std::string& section_path) const {
    if (section_path.find(".pt") != std::string::npos) {
        return SensorType::PT;
    } else if (section_path.find(".tc") != std::string::npos) {
        return SensorType::TC;
    } else if (section_path.find(".rtd") != std::string::npos) {
        return SensorType::RTD;
    } else if (section_path.find(".lc") != std::string::npos) {
        return SensorType::LC;
    } else if (section_path.find(".actuator") != std::string::npos) {
        return SensorType::ACTUATOR;
    }
    return SensorType::PT;  // Default
}

SystemState ConfigParser::parse_system_state(const std::string& section_path) const {
    if (section_path.find("flight") != std::string::npos ||
        section_path.find("hotfire") != std::string::npos) {
        return SystemState::FLIGHT;
    } else if (section_path.find("gse") != std::string::npos ||
               section_path.find("ground") != std::string::npos) {
        return SystemState::GSE;
    }
    return SystemState::GSE;  // Default
}

std::vector<SensorAssignment> ConfigParser::get_all_sensor_assignments() const {
    std::vector<SensorAssignment> assignments;
    for (const auto& [sensor_id, assignment] : sensor_assignments_) {
        assignments.push_back(assignment);
    }
    return assignments;
}

std::vector<SensorAssignment> ConfigParser::get_sensor_assignments(SensorType sensor_type) const {
    std::vector<SensorAssignment> assignments;
    for (const auto& [sensor_id, assignment] : sensor_assignments_) {
        if (assignment.sensor_type == sensor_type) {
            assignments.push_back(assignment);
        }
    }
    return assignments;
}

std::optional<SensorAssignment> ConfigParser::get_sensor_assignment(
    const std::string& sensor_id) const {
    auto it = sensor_assignments_.find(sensor_id);
    if (it != sensor_assignments_.end()) {
        return it->second;
    }
    return std::nullopt;
}

std::map<std::string, std::array<uint8_t, 2>> ConfigParser::get_all_packet_ids() const {
    std::map<std::string, std::array<uint8_t, 2>> packet_ids;
    for (const auto& [sensor_id, assignment] : sensor_assignments_) {
        packet_ids[sensor_id] = assignment.packet_id;
    }
    return packet_ids;
}

}  // namespace config
}  // namespace daq_comms
