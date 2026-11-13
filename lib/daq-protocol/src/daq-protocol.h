#pragma once

#include <stdint.h>

// Protocol version: the header's version byte. A typed constant, not a macro, so a
// file that declares its own COMMS_VERSION gets a compile error, not a silent rewrite.
static constexpr uint8_t COMMS_VERSION = 0;

// Maximum values
#define MAX_SENSORS_PER_BOARD 10
#define MAX_ACTUATORS_PER_BOARD 10
#define MAX_CHUNKS_PER_PACKET 10
#define MAX_PACKET_SIZE 512

// Maximum counts for actuator config packet (used for buffer sizing and validation)
#define MAX_ABORT_ACTUATORS 255
#define MAX_ABORT_PTS 255

// Include all other headers
#include "DaqEnums.h"
#include "DaqPackets.h"
#include "DaqPacketUtils.h"


