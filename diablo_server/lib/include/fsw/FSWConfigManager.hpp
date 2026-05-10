#ifndef DAQ_FSW_CONFIG_MANAGER_HPP
#define DAQ_FSW_CONFIG_MANAGER_HPP

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>

#include "config/SensorAssignment.hpp"
#include "transport/NetworkSocket.hpp"

namespace Diablo {
struct PacketHeader;
struct BoardHeartbeatPacket;
}  // namespace Diablo

namespace fsw {
namespace fsw {

/**
 * @brief FSW Configuration Manager
 *
 * Manages IP assignment and sensor configuration distribution to boards.
 * This runs on the FSW side and assigns configurations to boards.
 */
class FSWConfigManager {
public:
    FSWConfigManager();
    ~FSWConfigManager() = default;

    /**
     * @brief Initialize FSW config manager
     * @param bind_address Address to bind UDP socket for sending configs
     * @param bind_port Port for sending configs
     */
    bool initialize(const std::string& bind_address, uint16_t bind_port);

    /**
     * @brief Process board heartbeat and assign IP if needed
     * @param heartbeat Parsed heartbeat packet
     * @param source_ip Source IP address
     * @param mac_address Board MAC address
     * @return Assigned IP address
     */
    std::string process_board_heartbeat(const Diablo::PacketHeader& header,
                                        const Diablo::BoardHeartbeatPacket& body,
                                        const std::string& source_ip,
                                        const std::string& mac_address);

    /**
     * @brief Assign sensors to a board
     * @param board_id Board ID
     * @param sensor_ids List of sensor IDs to assign
     * @param start_channel Starting channel on board
     * @return true if successful
     */
    bool assign_sensors(uint8_t board_id, const std::vector<std::string>& sensor_ids,
                        uint8_t start_channel = 0);

    /**
     * @brief Send configuration packet to board
     * @param board_id Board ID
     * @return true if sent successfully
     */
    bool send_config_to_board(uint8_t board_id);

    /**
     * @brief Send configuration to all configured boards
     */
    void send_configs_to_all_boards();

    /**
     * @brief Get sensor assignment manager
     */
    config::SensorAssignmentManager& get_assignment_manager() {
        return assignment_manager_;
    }

    /**
     * @brief Set system state (GSE or FLIGHT)
     */
    void set_system_state(config::SystemState state);

    /**
     * @brief Configure static board IP address loaded from config.toml
     */
    void set_board_static_ip(uint8_t board_id, const std::string& ip);

    /**
     * @brief Get current system state
     */
    config::SystemState get_system_state() const {
        return current_state_;
    }

private:
    config::SensorAssignmentManager assignment_manager_;
    std::unique_ptr<daq_comms::transport::UDPSocket> config_socket_;
    config::SystemState current_state_;

    // Track which boards have been configured
    std::map<uint8_t, bool> boards_configured_;

    // Helper to determine system state from board type/IP
    config::SystemState infer_system_state(uint8_t board_id, const std::string& source_ip) const;
};

}  // namespace fsw
}  // namespace fsw

#endif  // DAQ_FSW_CONFIG_MANAGER_HPP
