#pragma once

// Version information
#define DIABLO_COMMS_VERSION 0 // Protocol version (uint8_t)

// Maximum values
#define MAX_SENSORS_PER_BOARD 10
#define MAX_ACTUATORS_PER_BOARD 10
#define MAX_CHUNKS_PER_PACKET 10
#define MAX_PACKET_SIZE 512

// Maximum counts for actuator config packet (used for buffer sizing and validation)
#define MAX_ABORT_ACTUATORS 255
#define MAX_ABORT_PTS 255

// Include all other headers
#include "DiabloEnums.h"
#include "DiabloPackets.h"
#include "DiabloPacketUtils.h"


