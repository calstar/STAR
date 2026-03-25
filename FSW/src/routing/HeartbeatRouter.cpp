#include "routing/HeartbeatRouter.hpp"

#include <chrono>
#include <iostream>

#include "../../../daq_comms/include/comms/messages/board/BoardHeartbeatMessage.hpp"

namespace fsw {
namespace routing {

HeartbeatRouter::HeartbeatRouter(fsw::elodin::ElodinClient& elodin_client)
    : elodin_client_(elodin_client) {
}

HeartbeatRouter::BoardEvent HeartbeatRouter::process_heartbeat(
    const Diablo::PacketHeader& header, const Diablo::BoardHeartbeatPacket& heartbeat,
    uint8_t board_type_wire, uint64_t receive_ts_ns) {
    const uint8_t board_id = heartbeat.board_id;
    const auto now = std::chrono::steady_clock::now();

    // ── Detect reconnect / Setup re-entry ────────────────────────────────────
    BoardEvent event = BoardEvent::NONE;
    auto& state = board_states_[board_id];

    if (!state.seen_before) {
        state.seen_before = true;
        std::cout << "[HeartbeatRouter] New board seen: id=" << (int)board_id
                  << " type_wire=" << (int)board_type_wire << std::endl;
    } else {
        auto gap = std::chrono::duration_cast<std::chrono::milliseconds>(now - state.last_seen);
        if (gap >= RECONNECT_THRESHOLD) {
            event = BoardEvent::RECONNECTED;
            std::cout << "[HeartbeatRouter] Board " << (int)board_id << " reconnected after "
                      << gap.count() << "ms" << std::endl;
        } else if (heartbeat.board_state == Diablo::BoardState::SETUP &&
                   state.last_board_state != Diablo::BoardState::SETUP) {
            event = BoardEvent::SETUP_REENTRY;
            std::cout << "[HeartbeatRouter] Board " << (int)board_id << " re-entered SETUP state"
                      << std::endl;
        }
    }

    state.last_seen = now;
    state.last_board_state = heartbeat.board_state;

    // ── Publish to Elodin ─────────────────────────────────────────────────────
    if (elodin_client_.is_connected()) {
        comms::messages::board::BoardHeartbeatElodinMessage msg;
        msg.setField<0>(receive_ts_ns);
        msg.setField<1>(board_id);
        msg.setField<2>(board_type_wire);
        msg.setField<3>(static_cast<uint8_t>(heartbeat.engine_state));
        msg.setField<4>(static_cast<uint8_t>(heartbeat.board_state));
        msg.setField<5>(header.timestamp);

        std::array<uint8_t, 2> pkt_id = {0x10, board_id};
        elodin_client_.publish(pkt_id, msg);
    }

    return event;
}

}  // namespace routing
}  // namespace fsw
