#ifndef DAQ_DATABASE_CONFIG_HPP
#define DAQ_DATABASE_CONFIG_HPP

#include <cstdint>
#include <string>
#include <utility>
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
 * @brief Elodin table ids (hi, lo) for the RAW sensor VTables the given boards publish.
 *
 * The (type_hi, (board_number-1)*0x20 + channel) encoding is defined by
 * DatabaseConfig::register_tables(), so it lives here beside it rather than being re-derived by
 * every subscriber. Built from the boards actually in config — the version this replaced guessed
 * boards 1-8 x channels 1-10 and subscribed to 480 tables whether they existed or not.
 */
std::vector<std::pair<uint8_t, uint8_t>> raw_sensor_tables(
    const std::vector<BoardChannels>& pt_boards, const std::vector<BoardChannels>& act_boards,
    const std::vector<BoardChannels>& tc_boards, const std::vector<BoardChannels>& rtd_boards,
    const std::vector<BoardChannels>& lc_boards, const std::vector<BoardChannels>& enc_boards);

/**
 * @brief Elodin table ids for the CALIBRATED VTables, matching register_calibrated_tables()
 *        (same encoding as above with a +0x10 channel offset, and ACT at 0x31 rather than 0x30).
 */
std::vector<std::pair<uint8_t, uint8_t>> calibrated_sensor_tables(
    const std::vector<BoardChannels>& pt_boards, const std::vector<BoardChannels>& tc_boards,
    const std::vector<BoardChannels>& rtd_boards, const std::vector<BoardChannels>& lc_boards,
    const std::vector<BoardChannels>& enc_boards, const std::vector<BoardChannels>& act_boards);

/** Non-sensor tables, named rather than spelled as literals at each use site. */
constexpr std::pair<uint8_t, uint8_t> kTableSequencerState{0x50, 0x00};
constexpr std::pair<uint8_t, uint8_t> kTableControllerState{0x43, 0x00};
constexpr std::pair<uint8_t, uint8_t> kTableCalibrationCommand{0x46, 0x00};

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
