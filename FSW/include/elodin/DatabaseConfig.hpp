#ifndef DAQ_DATABASE_CONFIG_HPP
#define DAQ_DATABASE_CONFIG_HPP

#include <cstdint>
#include <string>
#include <vector>

#include "ElodinClient.hpp"

namespace fsw {
namespace elodin {

/**
 * @brief Per-board channel info for board-namespaced entity registration.
 *
 * board_id:     raw board ID from config (e.g. 21, 22, 12, 14)
 * board_number: Elodin / daq slot = (board_id % 10) with 0 → 10 (e.g. id 12→2, id 10→10)
 * channels:     local connector IDs (1-10) that are active on this board
 */
struct BoardChannels {
    uint8_t board_id;
    uint8_t board_number;           // board_id % 10
    std::vector<uint8_t> channels;  // local channels (1-10)
};

/**
 * @brief Register sensor table schemas with Elodin database.
 *
 * All VTables use board-namespaced entity names (e.g. PT1.CH1, TC1.CH5,
 * ACT2.CH3).  Role names (e.g. "Fuel Upstream") are metadata only — the
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
     * Each vector lists boards with their local channels.
     * Entity names: PT<board_number>.CH<n>, ACT<board_number>.CH<n>, etc.
     */
    static bool register_tables(ElodinClient& client, const std::vector<BoardChannels>& pt_boards,
                                const std::vector<BoardChannels>& act_boards,
                                const std::vector<BoardChannels>& tc_boards,
                                const std::vector<BoardChannels>& rtd_boards,
                                const std::vector<BoardChannels>& lc_boards,
                                const std::vector<BoardChannels>& enc_boards);

    /**
     * @brief Register CALIBRATED VTables.
     *
     * Entity names: PT<board_number>_Cal.CH<n>, TC<board_number>_Cal.CH<n>, etc.
     */
    static bool register_calibrated_tables(ElodinClient& client,
                                           const std::vector<BoardChannels>& pt_boards,
                                           const std::vector<BoardChannels>& tc_boards,
                                           const std::vector<BoardChannels>& rtd_boards,
                                           const std::vector<BoardChannels>& lc_boards,
                                           const std::vector<BoardChannels>& enc_boards,
                                           const std::vector<BoardChannels>& act_boards);

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

    /** @brief Register sequencer/controller and ACT_CMD tables */
    static bool register_non_sensor_tables(ElodinClient& client,
                                           const std::vector<BoardChannels>& act_boards = {});
};

}  // namespace elodin
}  // namespace fsw

#endif  // DAQ_DATABASE_CONFIG_HPP
