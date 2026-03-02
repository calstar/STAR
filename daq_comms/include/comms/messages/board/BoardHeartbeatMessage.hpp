#ifndef BOARD_HEARTBEAT_MESSAGE_HPP
#define BOARD_HEARTBEAT_MESSAGE_HPP

#include <cstdint>

#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace board {

/**
 * @brief Board heartbeat status record for Elodin
 *
 * Published to Elodin each time a BOARD_HEARTBEAT is received, keyed by board_id.
 * packet_id: {0x10, board_id}
 *
 * Layout (16 bytes, no padding needed — u32 falls on 4-byte-aligned offset 12):
 *   u64 timestamp_ns  (0)  — monotonic receive timestamp
 *   u8  board_id      (8)
 *   u8  board_type    (9)  — DiabloBoardPacketParser::BoardType raw value
 *   u8  engine_state  (10) — DiabloBoardPacketParser::EngineState raw value
 *   u8  board_state   (11) — DiabloBoardPacketParser::BoardState raw value
 *   u32 packet_ts_ms  (12) — board-reported timestamp from packet header
 */
using BoardHeartbeatElodinMessage =
    CommsMessage<uint64_t,  // (0) timestamp_ns
                 uint8_t,   // (1) board_id
                 uint8_t,   // (2) board_type
                 uint8_t,   // (3) engine_state
                 uint8_t,   // (4) board_state
                 uint32_t   // (5) packet_ts_ms
                 >;

}  // namespace board
}  // namespace messages
}  // namespace comms

#endif  // BOARD_HEARTBEAT_MESSAGE_HPP
