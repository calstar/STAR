#ifndef FSW_HEARTBEAT_ROUTER_HPP
#define FSW_HEARTBEAT_ROUTER_HPP

#include <chrono>
#include <cstdint>
#include <map>

#include "../../../daq_comms/include/protocol/DiabloBoardPacketParser.hpp"
#include "elodin/ElodinClient.hpp"

namespace fsw {
namespace routing {

/**
 * @brief Routes incoming BOARD_HEARTBEAT packets to Elodin DB.
 *
 * On each heartbeat:
 *  - Publishes a BoardHeartbeatElodinMessage to packet_id {0x10, board_id}.
 *  - Tracks per-board last-seen time to detect reconnects and Setup re-entry.
 *  - Returns a BoardEvent so the caller (daq_bridge_main) can gate SENSOR_CONFIG re-sends.
 */
class HeartbeatRouter {
public:
    enum class BoardEvent {
        NONE,
        RECONNECTED,    // board was silent >2.5 s, now seen again
        SETUP_REENTRY,  // board transitioned back to SETUP state
    };

    explicit HeartbeatRouter(fsw::elodin::ElodinClient& elodin_client);
    ~HeartbeatRouter() = default;

    /**
     * @brief Process one BOARD_HEARTBEAT and publish to Elodin.
     *
     * @param hb             Parsed heartbeat (must be valid).
     * @param receive_ts_ns  Monotonic receive timestamp (nanoseconds).
     * @return BoardEvent indicating whether a reconnect or Setup re-entry was detected.
     */
    BoardEvent process_heartbeat(
        const daq_comms::protocol::DiabloBoardPacketParser::ParsedBoardHeartbeat& hb,
        uint64_t receive_ts_ns);

private:
    using BoardState = daq_comms::protocol::DiabloBoardPacketParser::BoardState;

    struct PerBoardState {
        std::chrono::steady_clock::time_point last_seen;
        BoardState last_board_state = BoardState::SETUP;
        bool seen_before = false;
    };

    fsw::elodin::ElodinClient& elodin_client_;
    std::map<uint8_t, PerBoardState> board_states_;

    static constexpr auto RECONNECT_THRESHOLD = std::chrono::milliseconds(2500);
};

}  // namespace routing
}  // namespace fsw

#endif  // FSW_HEARTBEAT_ROUTER_HPP
