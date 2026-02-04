#ifndef DAQ_SENSOR_ASSIGNMENT_HPP
#define DAQ_SENSOR_ASSIGNMENT_HPP

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace daq_comms {
namespace config {

/**
 * @brief System state (GSE or Flight)
 */
enum class SystemState {
    GSE,    // Ground Support Equipment
    FLIGHT  // Flight/rocket system
};

/**
 * @brief Sensor types
 */
enum class SensorType {
    PT,       // Pressure Transducer
    TC,       // Thermocouple
    RTD,      // RTD Temperature Sensor
    LC,       // Load Cell
    ACTUATOR  // Actuator/Valve
};

/**
 * @brief Pressure sensor specifications
 */
struct PressureSensorSpec {
    std::string sensor_id;      // Unique identifier (e.g., "PT_HP", "PT_LP")
    std::string name;           // Human-readable name
    std::string description;    // Description
    uint16_t max_pressure_psi;  // Maximum pressure rating (PSI)
    SystemState system_state;   // GSE or FLIGHT
    std::string location;       // Physical location
    std::string purpose;        // Purpose (e.g., "High pressure", "Fuel upstream")

    // Calibration info
    std::string calibration_file;  // Path to calibration data
    bool requires_calibration;
};

/**
 * @brief Sensor assignment to board
 */
struct SensorAssignment {
    std::string sensor_id;     // Sensor identifier
    uint8_t board_id;          // Board ID (0-15)
    uint8_t channel_id;        // Channel ID on board (0-indexed)
    SensorType sensor_type;    // Type of sensor
    SystemState system_state;  // GSE or FLIGHT
    bool is_active;            // Whether sensor is currently active
    std::string board_ip;      // Board IP address (assigned by FSW)
    uint16_t board_port;       // Board port (default 5005)
};

/**
 * @brief Board configuration (assigned by FSW)
 */
struct BoardConfiguration {
    uint8_t board_id;                       // Board ID (0-15)
    std::string board_ip;                   // Assigned IP address
    uint16_t board_port;                    // Communication port
    std::string mac_address;                // Board MAC address
    SensorType primary_sensor_type;         // Primary sensor type on board
    std::vector<SensorAssignment> sensors;  // Assigned sensors
    SystemState system_state;               // GSE or FLIGHT
    bool is_configured;                     // Whether board has been configured
    std::string firmware_version;           // Board firmware version
};

/**
 * @brief Sensor Assignment Manager
 *
 * Manages sensor-to-board assignments, IP assignment from FSW,
 * and configuration distribution to boards.
 */
class SensorAssignmentManager {
public:
    SensorAssignmentManager();
    ~SensorAssignmentManager() = default;

    /**
     * @brief Load sensor definitions from config
     */
    bool load_sensor_definitions(const std::string& config_path);

    /**
     * @brief Assign IP address to board (called by FSW)
     * @param board_id Board identifier
     * @param mac_address Board MAC address
     * @param system_state GSE or FLIGHT
     * @return Assigned IP address
     */
    std::string assign_board_ip(uint8_t board_id, const std::string& mac_address,
                                SystemState system_state);

    /**
     * @brief Assign sensors to board (called by FSW)
     * @param board_id Board identifier
     * @param sensor_ids List of sensor IDs to assign
     * @param start_channel Starting channel ID on board
     * @return true if assignment successful
     */
    bool assign_sensors_to_board(uint8_t board_id, const std::vector<std::string>& sensor_ids,
                                 uint8_t start_channel = 0);

    /**
     * @brief Get board configuration for sending to board
     * @param board_id Board identifier
     * @return Board configuration packet data
     */
    std::vector<uint8_t> generate_board_config_packet(uint8_t board_id) const;

    /**
     * @brief Get sensor assignment for a sensor ID
     */
    std::optional<SensorAssignment> get_sensor_assignment(const std::string& sensor_id) const;

    /**
     * @brief Get all sensors for a board
     */
    std::vector<SensorAssignment> get_board_sensors(uint8_t board_id) const;

    /**
     * @brief Get all sensors for a system state
     */
    std::vector<SensorAssignment> get_system_sensors(SystemState state) const;

    /**
     * @brief Get board configuration
     */
    std::optional<BoardConfiguration> get_board_config(uint8_t board_id) const;

    /**
     * @brief Update board configuration from received packet
     */
    bool update_board_config_from_packet(uint8_t board_id, const uint8_t* data, size_t size);

    /**
     * @brief Generate configuration file with assignments
     */
    bool save_assignments_to_config(const std::string& output_path) const;

    /**
     * @brief Load assignments from config file
     */
    bool load_assignments_from_config(const std::string& config_path);

    /**
     * @brief Get all pressure sensor specs
     */
    const std::map<std::string, PressureSensorSpec>& get_pressure_sensor_specs() const {
        return pressure_sensor_specs_;
    }

    /**
     * @brief Register callback for board configuration updates
     */
    void register_config_update_callback(
        std::function<void(uint8_t, const BoardConfiguration&)> callback);

private:
    // Sensor definitions
    std::map<std::string, PressureSensorSpec> pressure_sensor_specs_;

    // Board configurations
    std::map<uint8_t, BoardConfiguration> board_configs_;

    // Sensor assignments (sensor_id -> assignment)
    std::map<std::string, SensorAssignment> sensor_assignments_;

    // IP assignment ranges
    std::string gse_base_ip_;
    std::string flight_base_ip_;
    uint8_t gse_ip_range_start_;
    uint8_t gse_ip_range_end_;
    uint8_t flight_ip_range_start_;
    uint8_t flight_ip_range_end_;

    // Callbacks
    std::vector<std::function<void(uint8_t, const BoardConfiguration&)>> config_callbacks_;

    // Helper methods
    std::string calculate_ip_from_mac(const std::string& mac_address, SystemState state) const;
    SensorType sensor_type_from_string(const std::string& type_str) const;
    std::string sensor_type_to_string(SensorType type) const;
};

}  // namespace config
}  // namespace daq_comms

#endif  // DAQ_SENSOR_ASSIGNMENT_HPP
