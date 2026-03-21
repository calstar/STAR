#include "fsw/FSWConfigManager.hpp"

#include <chrono>
#include <iomanip>
#include <iostream>
#include <thread>

namespace fsw {
namespace fsw {

FSWConfigManager::FSWConfigManager() : current_state_(config::SystemState::GSE) {
}

bool FSWConfigManager::initialize(const std::string& bind_address, uint16_t bind_port) {
    config_socket_ = std::make_unique<daq_comms::transport::UDPSocket>(bind_address, bind_port);

    if (!config_socket_->is_valid()) {
        std::cerr << "[FSWConfig] Failed to create UDP socket: " << config_socket_->last_error()
                  << std::endl;
        return false;
    }

    // Load sensor definitions (will be loaded from specific config file)
    assignment_manager_.load_sensor_definitions("");

    std::cout << "[FSWConfig] Initialized FSW configuration manager" << std::endl;
    std::cout << "[FSWConfig] System state: "
              << (current_state_ == config::SystemState::GSE ? "GSE" : "FLIGHT") << std::endl;

    return true;
}

std::string FSWConfigManager::process_board_heartbeat(
    const daq_comms::protocol::DiabloBoardPacketParser::ParsedBoardHeartbeat& heartbeat,
    const std::string& source_ip, const std::string& mac_address) {
    uint8_t board_id = heartbeat.heartbeat.board_id;

    // Infer system state from board ID or IP
    config::SystemState system_state = infer_system_state(board_id, source_ip);

    // Assign IP address
    std::string assigned_ip =
        assignment_manager_.assign_board_ip(board_id, mac_address, system_state, source_ip);

    // Check if board needs sensor assignment
    auto board_config = assignment_manager_.get_board_config(board_id);
    if (board_config && board_config->sensors.empty()) {
        // Auto-assign sensors based on board type and system state
        std::vector<std::string> sensor_ids;

        if (system_state == config::SystemState::FLIGHT) {
            // Flight sensors based on board ID
            switch (board_id) {
                case 0:
                    sensor_ids = {"PT_HP", "PT_LP"};
                    break;
                case 1:
                    sensor_ids = {"PT_FUP", "PT_FDP"};
                    break;
                case 2:
                    sensor_ids = {"PT_OUP", "PT_ODP"};
                    break;
                default:
                    break;
            }
        } else {
            // GSE sensors based on board ID
            switch (board_id) {
                case 10:
                    sensor_ids = {"PT_OF"};
                    break;
                case 11:
                    sensor_ids = {"PT_FF"};
                    break;
                case 12:
                    sensor_ids = {"PT_HPF", "PT_MPF", "PT_LPF"};
                    break;
                default:
                    break;
            }
        }

        if (!sensor_ids.empty()) {
            assignment_manager_.assign_sensors_to_board(board_id, sensor_ids);
            std::cout << "[FSWConfig] Auto-assigned " << sensor_ids.size() << " sensors to board "
                      << (int)board_id << std::endl;
        }
    }

    // Send configuration to board if not already configured, OR if the board
    // is still in Setup state (e.g. after a reboot or missed config).
    bool board_in_setup = heartbeat.heartbeat.board_state ==
        daq_comms::protocol::DiabloBoardPacketParser::BoardState::SETUP;
    if (!boards_configured_[board_id] || board_in_setup) {
        if (board_in_setup && boards_configured_[board_id]) {
            std::cout << "[FSWConfig] Board " << (int)board_id
                      << " still in SETUP — re-sending SENSOR_CONFIG" << std::endl;
        }
        send_config_to_board(board_id);
    }

    return assigned_ip;
}

bool FSWConfigManager::assign_sensors(uint8_t board_id, const std::vector<std::string>& sensor_ids,
                                      uint8_t start_channel) {
    bool success = assignment_manager_.assign_sensors_to_board(board_id, sensor_ids, start_channel);

    if (success) {
        // Send updated configuration to board
        send_config_to_board(board_id);
    }

    return success;
}

bool FSWConfigManager::send_config_to_board(uint8_t board_id) {
    auto board_config = assignment_manager_.get_board_config(board_id);
    if (!board_config) {
        std::cerr << "[FSWConfig] Board " << (int)board_id << " not found" << std::endl;
        return false;
    }

    // Generate configuration packet
    auto packet = assignment_manager_.generate_board_config_packet(board_id);
    if (packet.empty()) {
        std::cerr << "[FSWConfig] Failed to generate config packet for board " << (int)board_id
                  << std::endl;
        return false;
    }

    // Dump packet contents for debugging / verification
    std::cout << "[FSWConfig] SENSOR_CONFIG packet for board " << static_cast<int>(board_id)
              << " len=" << packet.size() << " bytes: ";
    std::ios_base::fmtflags f(std::cout.flags());
    for (size_t i = 0; i < packet.size(); ++i) {
        std::cout << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
                  << static_cast<int>(packet[i]);
        if (i + 1 < packet.size()) {
            std::cout << ' ';
        }
    }
    std::cout.flags(f);
    std::cout << std::dec << std::setfill(' ') << std::endl;

    // Create UDP socket for sending to board
    daq_comms::transport::UDPSocket board_socket(board_config->board_ip, board_config->board_port,
                                                 true);

    // Send packet to board
    ssize_t sent = board_socket.send(packet.data(), packet.size());

    if (sent != static_cast<ssize_t>(packet.size())) {
        std::cerr << "[FSWConfig] Failed to send config to board " << (int)board_id << " at "
                  << board_config->board_ip << ":" << board_config->board_port << std::endl;
        return false;
    }

    boards_configured_[board_id] = true;
    std::cout << "[FSWConfig] Sent configuration to board " << (int)board_id << " ("
              << board_config->board_ip << ":" << board_config->board_port << ")" << std::endl;

    return true;
}

void FSWConfigManager::send_configs_to_all_boards() {
    // Get all board IDs from assignment manager
    // For now, iterate through configured boards
    for (uint8_t board_id = 0; board_id < 16; ++board_id) {
        auto config = assignment_manager_.get_board_config(board_id);
        if (config && !config->sensors.empty()) {
            send_config_to_board(board_id);
        }
    }
}

void FSWConfigManager::set_system_state(config::SystemState state) {
    current_state_ = state;
    std::cout << "[FSWConfig] System state changed to: "
              << (state == config::SystemState::GSE ? "GSE" : "FLIGHT") << std::endl;
}

void FSWConfigManager::set_board_static_ip(uint8_t board_id, const std::string& ip) {
    if (!ip.empty()) {
        assignment_manager_.set_static_board_ip(board_id, ip);
    }
}

config::SystemState FSWConfigManager::infer_system_state(uint8_t board_id,
                                                         const std::string& source_ip) const {
    // Infer from board ID: GSE boards typically use IDs 10-15, Flight uses 0-9
    if (board_id >= 10) {
        return config::SystemState::GSE;
    }

    // Infer from IP address: GSE uses 192.168.2.x, Flight uses 192.168.3.x
    if (source_ip.find("192.168.2.") == 0) {
        return config::SystemState::GSE;
    } else if (source_ip.find("192.168.3.") == 0) {
        return config::SystemState::FLIGHT;
    }

    // Default to current system state
    return current_state_;
}

}  // namespace fsw
}  // namespace fsw
