#ifndef DAQ_DATABASE_CONFIG_HPP
#define DAQ_DATABASE_CONFIG_HPP

#include <array>
#include <cstdint>
#include <string>

#include "../../daq_comms/include/comms/CommsMessage.hpp"
#include "../../daq_comms/include/comms/messages/sensor/SensorMessages.hpp"
#include "ElodinClient.hpp"
#include "config/ConfigParser.hpp"

namespace fsw {
namespace elodin {

/**
 * @brief Register sensor table schemas with Elodin database
 *
 * This must be called after connecting to Elodin but before publishing messages.
 * It registers the table structures so the editor can display data.
 */
class DatabaseConfig {
public:
    /**
     * @brief Register all sensor tables with the Elodin database (per sensor type)
     * @param client Connected ElodinClient instance
     * @return true if registration successful
     */
    static bool register_tables(ElodinClient& client);

    /**
     * @brief Register VTables per sensor instance from config (per sensor, not per type)
     * @param client Connected ElodinClient instance
     * @param config_path Path to TOML config file
     * @return true if registration successful
     */
    static bool register_tables_from_config(ElodinClient& client, const std::string& config_path);

    /**
     * @brief Register VTables for non-sensor message types (calibrated, filtered, navigation, etc.)
     * @param client Connected ElodinClient instance
     * @return true if registration successful
     */
    static bool register_non_sensor_tables(ElodinClient& client);

private:
    // Packet IDs: ONE per sensor TYPE (like FSW), not per channel
    // Elodin uses packet_id to look up VTable, so we need one VTable per sensor type
    static constexpr std::array<uint8_t, 2> PT_PACKET_ID = {0x20,
                                                            0x00};  // All PT channels use this
    static constexpr std::array<uint8_t, 2> TC_PACKET_ID = {0x21,
                                                            0x00};  // All TC channels use this
    static constexpr std::array<uint8_t, 2> RTD_PACKET_ID = {0x22,
                                                             0x00};  // All RTD channels use this
    static constexpr std::array<uint8_t, 2> LC_PACKET_ID = {0x23,
                                                            0x00};  // All LC channels use this

    // Note: External FSW uses component() instead of pair() - no entity_id in VTable
    // Entity IDs are not used in VTable registration (match external FSW pattern)

    // Helper to calculate message size
    template <typename MessageType>
    static constexpr size_t get_message_size() {
        return MessageSize<MessageType>::value;
    }
};

}  // namespace elodin
}  // namespace fsw

#endif  // DAQ_DATABASE_CONFIG_HPP
