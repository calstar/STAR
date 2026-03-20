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

    /**
     * @brief Register BOARD_HEARTBEAT VTables (one per board_id in [1, max_board_id]).
     *
     * packet_id: {0x10, board_id}
     * Layout: u64 timestamp_ns | u8 board_id | u8 board_type | u8 engine_state |
     *         u8 board_state | u32 packet_ts_ms  (16 bytes)
     */
    static bool register_heartbeat_tables(ElodinClient& client, uint8_t max_board_id = 64);

    /**
     * @brief Register SELF_TEST VTables
     *
     * packet_id: {0x60, board_id}
     * Layout: u64 timestamp_ns | u8 sensor_id | u8 result
     */
    static bool register_self_test_tables(ElodinClient& client, uint8_t max_board_id = 64);

    /** @brief Legacy: register from config path (delegates to register_tables with no maps) */
    static bool register_tables_from_config(ElodinClient& client, const std::string& config_path);

    /** @brief Placeholder for navigation / engine control tables */
    static bool register_non_sensor_tables(ElodinClient& client);
};

}  // namespace elodin
}  // namespace fsw

#endif  // DAQ_DATABASE_CONFIG_HPP
