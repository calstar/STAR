#pragma once

#include "comms/CommsMessage.hpp"

namespace comms::messages::sensor {

// [0x25, board_id]: epoch ns, temperature (C), absolute pressure (Pa), humidity (%RH), board ms.
using EnvironmentalMessage = comms::CommsMessage<uint64_t, float, uint32_t, float, uint32_t>;
static_assert(EnvironmentalMessage::nbytes() == 24);

}  // namespace comms::messages::sensor
