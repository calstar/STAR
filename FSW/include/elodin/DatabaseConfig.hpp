#ifndef DAQ_DATABASE_CONFIG_HPP
#define DAQ_DATABASE_CONFIG_HPP

#include <cstdint>
#include <map>
#include <string>

#include "ElodinClient.hpp"

namespace fsw {
namespace elodin {

/**
 * @brief Register sensor table schemas with Elodin database
 *
 * Two separate entry points:
 *   - register_tables()            → RAW VTables only  (called by daq_bridge)
 *   - register_calibrated_tables() → CALIBRATED VTables (called by calibration_service)
 *
 * Both are config-driven: they only register VTables for channels present in
 * the config maps parsed from [sensor_roles_*] and [actuator_roles].
 */
class DatabaseConfig {
public:
    /**
     * @brief Register RAW sensor / actuator VTables (for daq_bridge).
     *
     * Only registers channels that appear in the provided maps.
     * If a map is nullptr or empty, the corresponding sensor type is skipped.
     */
    static bool register_tables(ElodinClient& client,
                                const std::map<int, std::string>* pt_channel_to_name = nullptr,
                                const std::map<int, std::string>* act_channel_to_name = nullptr);

    /**
     * @brief Register CALIBRATED VTables (for calibration_service).
     *
     * Registers calibrated PT VTables (and TC/RTD/LC when those boards exist).
     * Separate from register_tables() so that calibrated data is owned by the
     * calibration service, not the raw data ingestion bridge.
     */
    static bool register_calibrated_tables(
        ElodinClient& client, const std::map<int, std::string>* pt_channel_to_name = nullptr);

    /** @brief Legacy: register from config path (delegates to register_tables with no maps) */
    static bool register_tables_from_config(ElodinClient& client, const std::string& config_path);

    /** @brief Placeholder for navigation / engine control tables */
    static bool register_non_sensor_tables(ElodinClient& client);
};

}  // namespace elodin
}  // namespace fsw

#endif  // DAQ_DATABASE_CONFIG_HPP
