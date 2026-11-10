#include "routing/HeartbeatRouter.hpp"

#include <chrono>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>

#include "comms/messages/board/BoardFirmwareMessage.hpp"
#include "comms/messages/board/BoardHeartbeatMessage.hpp"

namespace fsw {
namespace routing {

HeartbeatRouter::HeartbeatRouter(fsw::elodin::ElodinClient& elodin_client)
    : elodin_client_(elodin_client) {
}

HeartbeatRouter::BoardEvent HeartbeatRouter::process_heartbeat(
    const daq::PacketHeader& header, const daq::BoardHeartbeatPacket& heartbeat,
    uint8_t board_type_wire, uint64_t receive_ts_ns, int elodin_board_id_if_known) {
    uint8_t logical_id = heartbeat.board_id;
    if (elodin_board_id_if_known >= 0 && elodin_board_id_if_known <= 255) {
        logical_id = static_cast<uint8_t>(elodin_board_id_if_known);
    }
    const auto now = std::chrono::steady_clock::now();

    // ── Detect reconnect / Setup re-entry ────────────────────────────────────
    BoardEvent event = BoardEvent::NONE;
    auto& state = board_states_[logical_id];

    if (!state.seen_before) {
        state.seen_before = true;
        std::cout << "[HeartbeatRouter] New board seen: id=" << (int)logical_id
                  << " type_wire=" << (int)board_type_wire;
        if (logical_id != heartbeat.board_id) {
            std::cout << " (wire board_id=" << (int)heartbeat.board_id << " -> config board_id)";
        }
        std::cout << std::endl;
    } else {
        auto gap = std::chrono::duration_cast<std::chrono::milliseconds>(now - state.last_seen);
        if (gap >= RECONNECT_THRESHOLD) {
            event = BoardEvent::RECONNECTED;
            std::cout << "[HeartbeatRouter] Board " << (int)logical_id << " reconnected after "
                      << gap.count() << "ms" << std::endl;
        } else if (heartbeat.board_state == daq::BoardState::SETUP &&
                   state.last_board_state != daq::BoardState::SETUP) {
            event = BoardEvent::SETUP_REENTRY;
            std::cout << "[HeartbeatRouter] Board " << (int)logical_id << " re-entered SETUP state"
                      << std::endl;
        }
    }

    state.last_seen = now;
    state.last_board_state = heartbeat.board_state;

    // ── Publish to Elodin ─────────────────────────────────────────────────────
    if (elodin_client_.is_connected()) {
        comms::messages::board::BoardHeartbeatElodinMessage msg;
        msg.setField<0>(receive_ts_ns);
        msg.setField<1>(logical_id);
        msg.setField<2>(board_type_wire);
        msg.setField<3>(static_cast<uint8_t>(heartbeat.engine_state));
        msg.setField<4>(static_cast<uint8_t>(heartbeat.board_state));
        msg.setField<5>(header.timestamp);

        std::array<uint8_t, 2> pkt_id = {0x10, logical_id};
        elodin_client_.publish(pkt_id, msg);
    }

    // ── Publish the firmware digest, but only when it changes ────────────────
    // On every heartbeat this is the same 32 bytes; it moves only when the board
    // is reflashed. Elodin has no change detection, so writing it per tick would
    // cost ~144 KB/board/hour to store one value. See BoardFirmwareMessage.hpp.
    std::array<uint8_t, 32> digest{};
    std::memcpy(digest.data(), heartbeat.firmware_hash, digest.size());
    const bool digest_changed = !state.digest_known || digest != state.last_firmware_digest;

    if (digest_changed) {
        const bool was_known = state.digest_known;
        state.last_firmware_digest = digest;
        state.digest_known = true;

        std::ostringstream hex;
        for (uint8_t b : digest)
            hex << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(b);
        std::cout << "[HeartbeatRouter] Board " << (int)logical_id
                  << (was_known ? " firmware CHANGED to " : " firmware ") << hex.str()
                  << std::endl;

        if (elodin_client_.is_connected()) {
            comms::messages::board::BoardFirmwareElodinMessage fw;
            fw.setField<0>(receive_ts_ns);
            fw.setField<1>(logical_id);
            fw.setField<2>(digest);

            std::array<uint8_t, 2> fw_pkt_id = {0x11, logical_id};
            elodin_client_.publish(fw_pkt_id, fw);
        }
    }

    return event;
}

}  // namespace routing
}  // namespace fsw
