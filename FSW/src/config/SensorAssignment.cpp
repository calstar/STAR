#include "config/SensorAssignment.hpp"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>

namespace fsw {
namespace config {

SensorAssignmentManager::SensorAssignmentManager()
    : gse_base_ip_("192.168.2.0"),
      flight_base_ip_("192.168.3.0"),
      gse_ip_range_start_(100),
      gse_ip_range_end_(150),
      flight_ip_range_start_(100),
      flight_ip_range_end_(150) {
}

bool SensorAssignmentManager::load_sensor_definitions(const std::string& /* config_path */) {
    // Initialize flight pressure sensors
    pressure_sensor_specs_["PT_HP"] = {"PT_HP",
                                       "High Pressure PT",
                                       "High pressure PT capable of going up to 5k PSI reading",
                                       5000,
                                       SystemState::FLIGHT,
                                       "Rocket",
                                       "High pressure"};

    pressure_sensor_specs_["PT_LP"] = {"PT_LP",
                                       "COPV PT Post Regulator",
                                       "COPV PT post regulator (1000psi)",
                                       1000,
                                       SystemState::FLIGHT,
                                       "Rocket",
                                       "COPV post regulator"};

    pressure_sensor_specs_["PT_FUP"] = {
        "PT_FUP", "Upstream Fuel PT", "Upstream Fuel PT (1000 psi)", 1000, SystemState::FLIGHT,
        "Rocket", "Fuel upstream"};

    pressure_sensor_specs_["PT_FDP"] = {
        "PT_FDP", "Downstream Fuel PT", "Downstream Fuel PT (1000 psi)", 1000, SystemState::FLIGHT,
        "Rocket", "Fuel downstream"};

    pressure_sensor_specs_["PT_OUP"] = {"PT_OUP",
                                        "Upstream Oxidizer PT",
                                        "Upstream Oxidizer PT (1000 PSI)",
                                        1000,
                                        SystemState::FLIGHT,
                                        "Rocket",
                                        "Oxidizer upstream"};

    pressure_sensor_specs_["PT_ODP"] = {"PT_ODP",
                                        "Downstream Oxidizer PT",
                                        "Downstream Oxidizer PT (1000 PSI)",
                                        1000,
                                        SystemState::FLIGHT,
                                        "Rocket",
                                        "Oxidizer downstream"};

    // Initialize GSE pressure sensors
    pressure_sensor_specs_["PT_OF"] = {"PT_OF",
                                       "LOX Fill PT",
                                       "LOX Fill PT that goes up to 1000 psi",
                                       1000,
                                       SystemState::GSE,
                                       "GSE - LOX Fill",
                                       "LOX fill pressure"};

    pressure_sensor_specs_["PT_FF"] = {"PT_FF",
                                       "Fuel Fill PT",
                                       "Fuel fill PT that goes up to 1000 psi",
                                       1000,
                                       SystemState::GSE,
                                       "GSE - Fuel Fill",
                                       "Fuel fill pressure"};

    pressure_sensor_specs_["PT_HPF"] = {"PT_HPF",
                                        "High Pressure Fill PT",
                                        "High pressure fill with PT rated to 5000 psi",
                                        5000,
                                        SystemState::GSE,
                                        "GSE - Pressurant Fill",
                                        "High pressure fill"};

    pressure_sensor_specs_["PT_MPF"] = {"PT_MPF",
                                        "Medium Pressure Fill PT",
                                        "Medium press fill with PT rated to 2000 PSI",
                                        2000,
                                        SystemState::GSE,
                                        "GSE - Pressurant Fill",
                                        "Medium pressure fill"};

    pressure_sensor_specs_["PT_LPF"] = {"PT_LPF",
                                        "Low Pressure Fill PT",
                                        "Low pressure line with PT rated to 1000 psi",
                                        1000,
                                        SystemState::GSE,
                                        "GSE - Pressurant Fill",
                                        "Low pressure fill"};

    std::cout << "[SensorAssignment] Loaded " << pressure_sensor_specs_.size()
              << " pressure sensor definitions" << std::endl;

    return true;
}

void SensorAssignmentManager::set_static_board_ip(uint8_t board_id, const std::string& ip) {
    if (!ip.empty()) {
        static_board_ips_[board_id] = ip;
        // If the board was already configured, update its IP
        auto it = board_configs_.find(board_id);
        if (it != board_configs_.end() && it->second.board_ip != ip) {
            std::cout << "[SensorAssignment] Forcing static IP for board " << (int)board_id
                      << " from " << it->second.board_ip << " to " << ip << std::endl;
            it->second.board_ip = ip;
            for (auto& sensor : it->second.sensors) {
                sensor.board_ip = ip;
            }
            for (auto& [sensor_id, assignment] : sensor_assignments_) {
                if (assignment.board_id == board_id) {
                    assignment.board_ip = ip;
                }
            }
        }
    }
}

std::string SensorAssignmentManager::assign_board_ip(uint8_t board_id,
                                                     const std::string& mac_address,
                                                     SystemState system_state,
                                                     const std::string& source_ip) {
    // Check if we have a static IP defined for this board
    std::string assigned_ip;
    auto static_it = static_board_ips_.find(board_id);
    if (static_it != static_board_ips_.end() && !static_it->second.empty()) {
        assigned_ip = static_it->second;
    }

    // Check if board already has IP assigned
    auto it = board_configs_.find(board_id);
    if (it != board_configs_.end() && !it->second.board_ip.empty()) {
        if (!assigned_ip.empty() && it->second.board_ip != assigned_ip) {
            std::cout << "[SensorAssignment] Updating IP for board " << (int)board_id
                      << " to static config IP " << assigned_ip << std::endl;
            it->second.board_ip = assigned_ip;
            // Update IP in assigned sensors
            for (auto& sensor : it->second.sensors) {
                sensor.board_ip = assigned_ip;
            }
            // Update sensor_assignments_ map
            for (auto& [sensor_id, assignment] : sensor_assignments_) {
                if (assignment.board_id == board_id) {
                    assignment.board_ip = assigned_ip;
                }
            }
        } else if (assigned_ip.empty() && !source_ip.empty() && it->second.board_ip != source_ip) {
            std::cout << "[SensorAssignment] Updating IP for unconfigured board " << (int)board_id
                      << " from " << it->second.board_ip << " to heartbeat source " << source_ip
                      << std::endl;
            it->second.board_ip = source_ip;
            // Update IP in assigned sensors
            for (auto& sensor : it->second.sensors) {
                sensor.board_ip = source_ip;
            }
            // Update sensor_assignments_ map
            for (auto& [sensor_id, assignment] : sensor_assignments_) {
                if (assignment.board_id == board_id) {
                    assignment.board_ip = source_ip;
                }
            }
        }
        return it->second.board_ip;
    }

    // If no static IP was defined, use source IP, else calculate from MAC
    if (assigned_ip.empty()) {
        assigned_ip =
            !source_ip.empty() ? source_ip : calculate_ip_from_mac(mac_address, system_state);
        std::cout << "[SensorAssignment] Board " << (int)board_id
                  << " not found in config.toml! Using pseudo-random auto-discovery IP."
                  << std::endl;
    }

    // Create or update board configuration
    BoardConfiguration& config = board_configs_[board_id];
    config.board_id = board_id;
    config.board_ip = assigned_ip;
    config.board_port = 5005;  // Default DiabloAvionics port
    config.mac_address = mac_address;
    config.system_state = system_state;
    config.is_configured = false;

    std::cout << "[SensorAssignment] Assigned IP " << assigned_ip << " to board " << (int)board_id
              << " (MAC: " << mac_address
              << ", State: " << (system_state == SystemState::GSE ? "GSE" : "FLIGHT") << ")"
              << std::endl;

    return assigned_ip;
}

bool SensorAssignmentManager::assign_sensors_to_board(uint8_t board_id,
                                                      const std::vector<std::string>& sensor_ids,
                                                      uint8_t start_channel) {
    // Verify board exists
    auto board_it = board_configs_.find(board_id);
    if (board_it == board_configs_.end()) {
        std::cerr << "[SensorAssignment] Error: Board " << (int)board_id << " not found"
                  << std::endl;
        return false;
    }

    BoardConfiguration& board_config = board_it->second;

    // Assign sensors
    uint8_t channel = start_channel;
    for (const auto& sensor_id : sensor_ids) {
        // Verify sensor exists
        auto sensor_it = pressure_sensor_specs_.find(sensor_id);
        if (sensor_it == pressure_sensor_specs_.end()) {
            std::cerr << "[SensorAssignment] Warning: Sensor " << sensor_id
                      << " not found, skipping" << std::endl;
            continue;
        }

        const auto& spec = sensor_it->second;

        // Create assignment
        SensorAssignment assignment;
        assignment.sensor_id = sensor_id;
        assignment.board_id = board_id;
        assignment.channel_id = channel++;
        assignment.sensor_type = SensorType::PT;  // All current sensors are PT
        assignment.system_state = spec.system_state;
        assignment.is_active = true;
        assignment.board_ip = board_config.board_ip;
        assignment.board_port = board_config.board_port;

        // Store assignment
        sensor_assignments_[sensor_id] = assignment;
        board_config.sensors.push_back(assignment);

        // Set primary sensor type if not set
        if (board_config.sensors.size() == 1) {
            board_config.primary_sensor_type = assignment.sensor_type;
        }

        std::cout << "[SensorAssignment] Assigned sensor " << sensor_id << " to board "
                  << (int)board_id << " channel " << (int)assignment.channel_id << std::endl;
    }

    return true;
}

std::vector<uint8_t> SensorAssignmentManager::generate_board_config_packet(uint8_t board_id) const {
    auto it = board_configs_.find(board_id);
    if (it == board_configs_.end()) {
        return {};
    }

    const auto& config = it->second;

    // Generate SENSOR_CONFIG packet (DAQv2-Comms format, NOT generate_packets.cpp)
    // Layout matches create_sensor_config_packet in DiabloPacketUtils.cpp
    // Body: num_sensors | sensor_ids | reference_voltage | necessary_for_abort
    //       | [controller_ip if necessary_for_abort] | enable_serial_printing
    std::vector<uint8_t> packet;

    // Header (6 bytes): type, version, timestamp LE
    packet.push_back(5);  // SENSOR_CONFIG packet type
    packet.push_back(0);  // Version

    uint32_t timestamp = static_cast<uint32_t>(std::time(nullptr)) * 1000;  // ms
    packet.push_back(timestamp & 0xFF);
    packet.push_back((timestamp >> 8) & 0xFF);
    packet.push_back((timestamp >> 16) & 0xFF);
    packet.push_back((timestamp >> 24) & 0xFF);

    // Body: num_sensors (1 byte)
    packet.push_back(static_cast<uint8_t>(config.sensors.size()));

    // sensor_ids (N bytes) - use channel_id as sensor ID
    for (const auto& sensor : config.sensors) {
        packet.push_back(sensor.channel_id);
    }

    // reference_voltage (1 byte): 0=Internal 2.5V, 1=VDD, 2=5V
    packet.push_back(0);

    // necessary_for_abort (1 byte)
    packet.push_back(0);

    // controller_ip (4 bytes) - OMITTED when necessary_for_abort is false

    // enable_serial_printing (1 byte)
    packet.push_back(0);

    return packet;
}

std::optional<SensorAssignment> SensorAssignmentManager::get_sensor_assignment(
    const std::string& sensor_id) const {
    auto it = sensor_assignments_.find(sensor_id);
    if (it == sensor_assignments_.end()) {
        return std::nullopt;
    }
    return it->second;
}

std::vector<SensorAssignment> SensorAssignmentManager::get_board_sensors(uint8_t board_id) const {
    auto it = board_configs_.find(board_id);
    if (it == board_configs_.end()) {
        return {};
    }
    return it->second.sensors;
}

std::vector<SensorAssignment> SensorAssignmentManager::get_system_sensors(SystemState state) const {
    std::vector<SensorAssignment> sensors;
    for (const auto& [sensor_id, assignment] : sensor_assignments_) {
        if (assignment.system_state == state) {
            sensors.push_back(assignment);
        }
    }
    return sensors;
}

std::optional<BoardConfiguration> SensorAssignmentManager::get_board_config(
    uint8_t board_id) const {
    auto it = board_configs_.find(board_id);
    if (it == board_configs_.end()) {
        return std::nullopt;
    }
    return it->second;
}

bool SensorAssignmentManager::update_board_config_from_packet(uint8_t board_id,
                                                              const uint8_t* /* data */,
                                                              size_t /* size */) {
    // TODO: Parse board response packet
    auto it = board_configs_.find(board_id);
    if (it != board_configs_.end()) {
        it->second.is_configured = true;

        // Notify callbacks
        for (const auto& callback : config_callbacks_) {
            callback(board_id, it->second);
        }

        return true;
    }
    return false;
}

bool SensorAssignmentManager::save_assignments_to_config(const std::string& output_path) const {
    std::ofstream file(output_path);
    if (!file.is_open()) {
        std::cerr << "[SensorAssignment] Failed to open config file: " << output_path << std::endl;
        return false;
    }

    file << "# Auto-generated sensor assignments\n";
    file << "# DO NOT EDIT MANUALLY\n\n";

    // Write board configurations
    for (const auto& [board_id, config] : board_configs_) {
        file << "[board_" << (int)board_id << "]\n";
        file << "ip = \"" << config.board_ip << "\"\n";
        file << "port = " << config.board_port << "\n";
        file << "mac_address = \"" << config.mac_address << "\"\n";
        file << "system_state = \"" << (config.system_state == SystemState::GSE ? "GSE" : "FLIGHT")
             << "\"\n";
        file << "primary_sensor_type = \"" << sensor_type_to_string(config.primary_sensor_type)
             << "\"\n";
        file << "is_configured = " << (config.is_configured ? "true" : "false") << "\n";
        file << "\n";

        // Write sensor assignments
        file << "[board_" << (int)board_id << ".sensors]\n";
        for (const auto& sensor : config.sensors) {
            file << sensor.sensor_id << " = { channel = " << (int)sensor.channel_id << ", type = \""
                 << sensor_type_to_string(sensor.sensor_type) << "\" }\n";
        }
        file << "\n";
    }

    file.close();
    std::cout << "[SensorAssignment] Saved assignments to: " << output_path << std::endl;
    return true;
}

std::string SensorAssignmentManager::calculate_ip_from_mac(const std::string& mac_address,
                                                           SystemState state) const {
    // Parse MAC address
    std::istringstream mac_stream(mac_address);
    std::string byte_str;
    uint32_t mac_hash = 0;
    int byte_count = 0;

    while (std::getline(mac_stream, byte_str, ':') && byte_count < 6) {
        uint8_t byte_val = static_cast<uint8_t>(std::stoul(byte_str, nullptr, 16));
        mac_hash = (mac_hash << 8) | byte_val;
        byte_count++;
    }

    // Choose IP range based on system state
    const std::string& base_ip = (state == SystemState::GSE) ? gse_base_ip_ : flight_base_ip_;
    uint8_t range_start =
        (state == SystemState::GSE) ? gse_ip_range_start_ : flight_ip_range_start_;
    uint8_t range_end = (state == SystemState::GSE) ? gse_ip_range_end_ : flight_ip_range_end_;

    // Calculate IP octet
    uint8_t ip_octet = range_start + (mac_hash % (range_end - range_start + 1));

    // Parse base IP
    size_t last_dot = base_ip.rfind('.');
    std::string base = base_ip.substr(0, last_dot);

    return base + "." + std::to_string(ip_octet);
}

SensorType SensorAssignmentManager::sensor_type_from_string(const std::string& type_str) const {
    if (type_str == "PT")
        return SensorType::PT;
    if (type_str == "TC")
        return SensorType::TC;
    if (type_str == "RTD")
        return SensorType::RTD;
    if (type_str == "LC")
        return SensorType::LC;
    if (type_str == "ACTUATOR")
        return SensorType::ACTUATOR;
    return SensorType::PT;  // Default
}

std::string SensorAssignmentManager::sensor_type_to_string(SensorType type) const {
    switch (type) {
        case SensorType::PT:
            return "PT";
        case SensorType::TC:
            return "TC";
        case SensorType::RTD:
            return "RTD";
        case SensorType::LC:
            return "LC";
        case SensorType::ACTUATOR:
            return "ACTUATOR";
        default:
            return "PT";
    }
}

void SensorAssignmentManager::register_config_update_callback(
    std::function<void(uint8_t, const BoardConfiguration&)> callback) {
    config_callbacks_.push_back(callback);
}

}  // namespace config
}  // namespace fsw
