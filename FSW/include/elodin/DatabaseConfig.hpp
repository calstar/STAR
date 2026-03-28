#ifndef DAQ_DATABASE_CONFIG_HPP
#define DAQ_DATABASE_CONFIG_HPP

#include <cstdint>
#include <string>
#include <vector>

#include "ElodinClient.hpp"

namespace fsw {
namespace elodin {

/**
 * @brief Register sensor table schemas with Elodin database.
 *
 * All VTables use generic channel-based entity names (e.g. PT.CH1, TC.CH5,
 * ACT.CH3).  Role names (e.g. "Fuel Upstream") are metadata only — the
 * frontend maps channel → display name from config.toml at render time.
 *
 * Two separate entry points:
 *   - register_tables()            → RAW VTables only  (called by daq_bridge)
 *   - register_calibrated_tables() → CALIBRATED VTables (called by calibration_service)
 */
class DatabaseConfig {
public:
    /**
     * @brief Register RAW sensor / actuator VTables.
     *
     * Each vector lists global channel numbers for that sensor type.
     * Entity names: PT.CH<n>, ACT.CH<n>, TC.CH<n>, RTD.CH<n>, LC.CH<n>, ENC.CH<n>.
     */
    static bool register_tables(ElodinClient& client,
                                const std::vector<uint8_t>& pt_channels,
                                const std::vector<uint8_t>& act_channels,
                                const std::vector<uint8_t>& tc_channels,
                                const std::vector<uint8_t>& rtd_channels,
                                const std::vector<uint8_t>& lc_channels,
                                const std::vector<uint8_t>& enc_channels);

    /**
     * @brief Register CALIBRATED VTables.
     *
     * Entity names: PT_Cal.CH<n>, TC_Cal.CH<n>, RTD_Cal.CH<n>, LC_Cal.CH<n>, ENC_Cal.CH<n>.
     */
    static bool register_calibrated_tables(ElodinClient& client,
                                           const std::vector<uint8_t>& pt_channels,
                                           const std::vector<uint8_t>& tc_channels,
                                           const std::vector<uint8_t>& rtd_channels,
                                           const std::vector<uint8_t>& lc_channels,
                                           const std::vector<uint8_t>& enc_channels);

    /**
     * @brief Register BOARD_HEARTBEAT VTables for specific board IDs.
     */
    static bool register_heartbeat_tables(ElodinClient& client,
                                          const std::vector<uint8_t>& board_ids);

    /**
     * @brief Register SELF_TEST VTables for specific board IDs.
     */
    static bool register_self_test_tables(ElodinClient& client,
                                          const std::vector<uint8_t>& board_ids);

    /** @brief Placeholder for navigation / engine control tables */
    static bool register_non_sensor_tables(ElodinClient& client);
};

}  // namespace elodin
}  // namespace fsw

#endif  // DAQ_DATABASE_CONFIG_HPP
