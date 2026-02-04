#ifndef DAQ_CONFIG_PARSER_HPP
#define DAQ_CONFIG_PARSER_HPP

#include <array>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "SensorAssignment.hpp"

namespace daq_comms {
namespace config {

/**
 * @brief Simple TOML config parser for sensor definitions
 *
 * Parses TOML config files to extract sensor definitions with packet IDs.
 * Supports nested tables like [sensors.flight.pt], [sensors.gse.rtd], etc.
 */
class ConfigParser {
public:
    ConfigParser() = default;
    ~ConfigParser() = default;

    /**
     * @brief Load and parse TOML config file
     * @param config_path Path to TOML config file
     * @return true if parsing successful
     */
    bool load_config(const std::string& config_path);

    /**
     * @brief Get all sensor assignments from config
     * @return Vector of sensor assignments with packet IDs
     */
    std::vector<SensorAssignment> get_all_sensor_assignments() const;

    /**
     * @brief Get sensor assignments for a specific sensor type
     * @param sensor_type Sensor type (PT, TC, RTD, LC, ACTUATOR)
     * @return Vector of sensor assignments
     */
    std::vector<SensorAssignment> get_sensor_assignments(SensorType sensor_type) const;

    /**
     * @brief Get sensor assignment by sensor ID
     * @param sensor_id Sensor identifier (e.g., "PT_HP", "RTD_COPV")
     * @return Sensor assignment if found, nullopt otherwise
     */
    std::optional<SensorAssignment> get_sensor_assignment(const std::string& sensor_id) const;

    /**
     * @brief Get all packet IDs from config
     * @return Map of sensor_id -> packet_id
     */
    std::map<std::string, std::array<uint8_t, 2>> get_all_packet_ids() const;

private:
    // Internal storage: sensor_id -> SensorAssignment
    std::map<std::string, SensorAssignment> sensor_assignments_;

    // Helper methods
    SensorType parse_sensor_type(const std::string& section_path) const;
    SystemState parse_system_state(const std::string& section_path) const;
    std::array<uint8_t, 2> parse_packet_id(const std::string& packet_id_str) const;
    bool parse_sensor_entry(const std::string& sensor_id, const std::string& section_path,
                            const std::map<std::string, std::string>& fields);
};

}  // namespace config
}  // namespace daq_comms

#endif  // DAQ_CONFIG_PARSER_HPP
