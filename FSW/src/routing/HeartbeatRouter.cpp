#include "routing/HeartbeatRouter.hpp"

#include <chrono>
#include <iostream>

#include "../../../daq_comms/include/comms/messages/board/BoardHeartbeatMessage.hpp"

namespace fsw {
namespace routing {

HeartbeatRouter::HeartbeatRouter(fsw::elodin::ElodinClient& elodin_client)
    : elodin_client_(elodin_client) {}

HeartbeatRouter::BoardEvent HeartbeatRouter::process_heartbeat(
    const daq_comms::protocol::DiabloBoardPacketParser::ParsedBoardHeartbeat& hb,
    uint64_t receive_ts_ns) {

    if (!hb.is_valid) return BoardEvent::NONE;

    const uint8_t board_id = hb.heartbeat.board_id;
    const auto now = std::chrono::steady_clock::now();

    // ── Detect reconnect / Setup re-entry ────────────────────────────────────
    BoardEvent event = BoardEvent::NONE;
    auto& state = board_states_[board_id];

    if (!state.seen_before) {
        state.seen_before = true;
        std::cout << "[HeartbeatRouter] New board seen: id=" << (int)board_id
                  << " type=" << (int)static_cast<uint8_t>(hb.heartbeat.board_type) << std::endl;
    } else {
        auto gap = std::chrono::duration_cast<std::chrono::milliseconds>(now - state.last_seen);
        if (gap >= RECONNECT_THRESHOLD) {
            event = BoardEvent::RECONNECTED;
            std::cout << "[HeartbeatRouter] Board " << (int)board_id << " reconnected after "
                      << gap.count() << "ms" << std::endl;
        } else if (hb.heartbeat.board_state == BoardState::SETUP &&
                   state.last_board_state != BoardState::SETUP) {
            event = BoardEvent::SETUP_REENTRY;
            std::cout << "[HeartbeatRouter] Board " << (int)board_id
                      << " re-entered SETUP state" << std::endl;
        }
    }

    state.last_seen = now;
    state.last_board_state = hb.heartbeat.board_state;

    // ── Publish to Elodin ─────────────────────────────────────────────────────
    if (elodin_client_.is_connected()) {
        comms::messages::board::BoardHeartbeatElodinMessage msg;
        msg.setField<0>(receive_ts_ns);
        msg.setField<1>(board_id);
        msg.setField<2>(static_cast<uint8_t>(hb.heartbeat.board_type));
        msg.setField<3>(static_cast<uint8_t>(hb.heartbeat.engine_state));
        msg.setField<4>(static_cast<uint8_t>(hb.heartbeat.board_state));
        msg.setField<5>(hb.header.timestamp);

        std::array<uint8_t, 2> pkt_id = {0x10, board_id};
        elodin_client_.publish(pkt_id, msg);
    }

    return event;
}

}  // namespace routing
}  // namespace fsw
