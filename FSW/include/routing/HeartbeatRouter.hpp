#ifndef FSW_HEARTBEAT_ROUTER_HPP
#define FSW_HEARTBEAT_ROUTER_HPP

#include <chrono>
#include <cstdint>
#include <map>

#include "DiabloEnums.h"
#include "DiabloPackets.h"
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

    explicit HeartbeatRouter(elodin::ElodinClient& elodin_client);
    ~HeartbeatRouter() = default;

    /**
     * @brief Process one BOARD_HEARTBEAT and publish to Elodin.
     *
     * @param header     Parsed packet header (for timestamp).
     * @param heartbeat  Parsed heartbeat body (DAQv2: firmware hash + id + states; no board_type on
     * wire).
     * @param board_type_wire  Legacy wire enum byte for Elodin (from config when known, else 0).
     * @param receive_ts_ns  Monotonic receive timestamp (nanoseconds).
     */
    BoardEvent process_heartbeat(const Diablo::PacketHeader& header,
                                 const Diablo::BoardHeartbeatPacket& heartbeat,
                                 uint8_t board_type_wire, uint64_t receive_ts_ns);

private:
    struct PerBoardState {
        std::chrono::steady_clock::time_point last_seen;
        Diablo::BoardState last_board_state = Diablo::BoardState::SETUP;
        bool seen_before = false;
    };

    elodin::ElodinClient& elodin_client_;
    std::map<uint8_t, PerBoardState> board_states_;

    static constexpr auto RECONNECT_THRESHOLD = std::chrono::milliseconds(2500);
};

}  // namespace routing
}  // namespace fsw

#endif  // FSW_HEARTBEAT_ROUTER_HPP
