#ifndef STAR_DAQ_TASK_H
#define STAR_DAQ_TASK_H

#include "daq_records.h"
#include "daq_wire.h"
#include "w5500_udp.h"

typedef struct {
    bool enabled;
    bool discover_server;
    uint8_t board_id;
    w5500_net_t network;
    uint8_t server_ip[4];
    uint16_t server_port;
    uint8_t firmware_hash[32];
    daq_source_t sources[DAQ_CHANNELS];
} daq_config_t;

/* Proposed issue #180 profile: board .81:5005, server .20:5006, UID MAC.
 * Disabled pending sign-off and DAQ routing. Static only for now; DHCP and
 * the five-second lease fallback are not implemented. Override as a whole. */
void daq_board_config(daq_config_t* out);
bool daq_task_start(void);
/* Task context only. Copies immediately to a bounded queue without waiting.
 * false means disabled, invalid sample, or queue full. A producer must map
 * its measurements to the server's agreed channels before calling. */
bool daq_publish(const daq_sample_t* sample);
void daq_record(uint8_t type, const void* data, uint8_t length);
#endif
