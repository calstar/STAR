// Diablo DAQ link: UDP to the server, same state machine as the club's SensorHotfireCore.
//
//   WaitingForServer --SENSOR_CONFIG--> SelfTest --(sends SELF_TEST)--> Active
//   Active --NO_CONNECTION_ABORT (only if config says necessary_for_abort)--> StandaloneAbort
//   StandaloneAbort --CLEAR_ABORT--> Active
//   SENSOR_CONFIG received in any later state just updates the channel list.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "fdc1004.h"

typedef enum {
    DAQ_STATE_WAITING_FOR_SERVER = 1,
    DAQ_STATE_ACTIVE             = 2,
    DAQ_STATE_STANDALONE_ABORT   = 9,
    DAQ_STATE_SELF_TEST          = 10,
} daq_state_t;

// Start UDP socket, receive task and heartbeat/send task. Call after Ethernet is up.
esp_err_t daq_link_start(void);

// Called by the sensor task with every poll result. Builds a chunk once every requested
// channel has a fresh sample, and queues a packet every DAQ_CHUNKS_PER_PACKET chunks.
void daq_link_on_samples(const fdc1004_sample_t s[FDC1004_NUM_CH], bool sensor_ok);

daq_state_t daq_link_state(void);
uint8_t daq_link_engine_state(void);
