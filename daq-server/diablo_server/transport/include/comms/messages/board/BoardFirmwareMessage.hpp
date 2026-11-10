#ifndef BOARD_FIRMWARE_MESSAGE_HPP
#define BOARD_FIRMWARE_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace board {

/**
 * @brief The firmware image a board is running, published only when it changes.
 *
 * packet_id: {0x11, board_id}
 *
 * Every BOARD_HEARTBEAT carries this 32-byte digest, once a second, forever. It
 * changes only when the board is reflashed, and Elodin is append-only with no
 * change detection -- every field of every publish is written -- so carrying it
 * on the heartbeat table would spend ~144 KB per board per hour storing the same
 * 32 bytes 3600 times. HeartbeatRouter therefore publishes here on the first
 * heartbeat from a board and on any change after that, which costs ~40 bytes per
 * reflash and leaves this component a timestamped history of every firmware
 * change on every board.
 *
 * The digest is what esp_partition_get_sha256() returns: the SHA-256 ESP-IDF
 * appends to the app image, NOT sha256(firmware.bin). Turn one into a commit with
 * firmware/tools/which_firmware.py; see
 * firmware/Hotfire_Code/common/FIRMWARE_HASH_VERIFICATION.md.
 *
 * Layout (41 bytes, written field by field with no padding):
 *   u64      timestamp_ns     (0)  -- monotonic receive timestamp
 *   u8       board_id         (8)
 *   u8[32]   firmware_digest  (9)
 */
using BoardFirmwareElodinMessage = CommsMessage<uint64_t,                // (0) timestamp_ns
                                                uint8_t,                 // (1) board_id
                                                std::array<uint8_t, 32>  // (2) firmware_digest
                                                >;

}  // namespace board
}  // namespace messages
}  // namespace comms

#endif  // BOARD_FIRMWARE_MESSAGE_HPP
