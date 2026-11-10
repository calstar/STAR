#ifndef STAR_DAQ_WIRE_H
#define STAR_DAQ_WIRE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* C encoder for lib/daq-protocol. Host compatibility tests use that library
 * as the independent encoder/parser. Timestamps are milliseconds, not the
 * microsecond timestamps in records.h. Values are the agreed channel's raw
 * uint32 representation; the transport does not invent units/calibration. */
enum { DAQ_CHANNELS = 10, DAQ_PACKET_MAX = 512 };
typedef struct {
    uint8_t id;
    uint32_t value;
} daq_value_t;
typedef struct {
    uint32_t timestamp_ms;
    uint8_t count;
    daq_value_t values[DAQ_CHANNELS];
} daq_sample_t;

typedef struct {
    uint16_t channels;
    uint8_t engine_state;
    bool configured, heard_server;
    uint32_t last_server_ms;
} daq_peer_t;

/* Only SERVER_HEARTBEAT and SENSOR_CONFIG are accepted. No arming,
 * actuator, abort, radio, or state-machine commands are dispatched. */
bool daq_peer_receive(daq_peer_t* peer, const uint8_t* data, size_t length,
                      uint32_t now_ms);
void daq_peer_expire(daq_peer_t* peer, uint32_t now_ms);
bool daq_sample_valid(const daq_sample_t* sample);
size_t daq_encode_sample(const daq_sample_t* sample, uint16_t channels,
                         uint8_t* out, size_t capacity);
size_t daq_encode_heartbeat(const daq_peer_t* peer, uint8_t board_id,
                            const uint8_t firmware_hash[32], uint32_t now_ms,
                            uint8_t* out, size_t capacity);
#endif
