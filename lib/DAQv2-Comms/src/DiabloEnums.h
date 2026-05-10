#pragma once

#include <stdint.h>

namespace Diablo {

/**
 * @brief Defines the type of data contained in a packet.
 */
enum class PacketType : uint8_t {
  BOARD_HEARTBEAT = 1,
  SERVER_HEARTBEAT = 2,
  SENSOR_DATA = 3,
  ACTUATOR_COMMAND = 4,
  SENSOR_CONFIG = 5,
  ACTUATOR_CONFIG = 6,
  ABORT = 7,
  ABORT_DONE = 8,
  CLEAR_ABORT = 9,
  PWM_ACTUATOR_COMMAND = 10,
  NO_CONNECTION_ABORT = 11,
  SELF_TEST = 12,
  ENVIRONMENTAL_DATA = 13,
  STACKLIGHT_COMMAND = 14
};

/**
 * @brief Defines the operational state of a board.
 */
enum class BoardState : uint8_t {
  SETUP = 1,
  ACTIVE = 2,
  CONNECTION_LOSS_DETECTED = 3,
  NO_CONNECTION_ABORT = 4,
  NO_CONN_ABORT_FOLLOWER = 5,
  PT_ABORT = 6,
  NO_PT_ABORT = 7,
  ABORT_FINISHED = 8,
  STANDALONE_ABORT = 9,
  SELF_TEST = 10
};

/**
 * @brief Defines the overall state of the engine system.
 * This is communicated from the server to the boards.
 */
enum class EngineState : uint8_t {
  // These are examples; the full list would be defined by the system leads.
  SAFE = 0,
  PRESSURIZING = 1,
  LOX_FILL = 2,
  FIRING = 3,
  POST_FIRE = 4
};

} // namespace Diablo
