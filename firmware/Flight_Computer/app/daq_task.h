#ifndef STAR_DAQ_TASK_H
#define STAR_DAQ_TASK_H

#include "daq_records.h"
#include "daq_wire.h"
#include "w5500_udp.h"

typedef struct {
    bool enabled;
    uint8_t board_id;
    w5500_net_t network;
    uint8_t server_ip[4];
    uint16_t server_port;
    uint8_t firmware_hash[32];
    daq_source_t sources[DAQ_CHANNELS];
} daq_config_t;

/* Override this weak function in a deployment-specific source file. The
 * default is disabled: no board ID, IP, or server-side channel schema has
 * been assigned. Static addressing only; no implicit DHCP/static fallback. */
void daq_board_config(daq_config_t* out);
bool daq_task_start(void);
/* Task context only. Copies immediately to a bounded queue without waiting.
 * false means disabled, invalid sample, or queue full. A producer must map
 * its measurements to the server's agreed channels before calling. */
bool daq_publish(const daq_sample_t* sample);
void daq_record(uint8_t type, const void* data, uint8_t length);
#endif
