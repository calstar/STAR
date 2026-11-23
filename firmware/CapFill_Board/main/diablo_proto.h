// Diablo DAQ packet encoding/decoding, byte-compatible with calstar/DAQv2-Comms
// (DiabloPackets.h / DiabloPacketUtils.cpp). All multi-byte fields are little-endian,
// matching the packed structs the ESP32 boards memcpy and the Python GUI's '<' formats.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define DIABLO_PROTO_VERSION     0      // DIABLO_COMMS_VERSION
#define DIABLO_HEADER_SIZE       6      // type(1) + version(1) + timestamp(4)
#define DIABLO_MAX_PACKET_SIZE   512
#define DIABLO_MAX_SENSORS       10     // MAX_SENSORS_PER_BOARD
#define DIABLO_MAX_CHUNKS        10     // MAX_CHUNKS_PER_PACKET
#define DIABLO_FW_HASH_LEN       32

typedef enum {
    PKT_BOARD_HEARTBEAT      = 1,
    PKT_SERVER_HEARTBEAT     = 2,
    PKT_SENSOR_DATA          = 3,
    PKT_ACTUATOR_COMMAND     = 4,
    PKT_SENSOR_CONFIG        = 5,
    PKT_ACTUATOR_CONFIG      = 6,
    PKT_ABORT                = 7,
    PKT_ABORT_DONE           = 8,
    PKT_CLEAR_ABORT          = 9,
    PKT_PWM_ACTUATOR_COMMAND = 10,
    PKT_NO_CONNECTION_ABORT  = 11,
    PKT_SELF_TEST            = 12,
    PKT_ENVIRONMENTAL_DATA   = 13,
    PKT_STACKLIGHT_COMMAND   = 14,
} diablo_pkt_type_t;

// BoardState values from DiabloEnums.h (only the ones a sense board uses are listed)
typedef enum {
    BOARD_STATE_SETUP            = 1,
    BOARD_STATE_ACTIVE           = 2,
    BOARD_STATE_STANDALONE_ABORT = 9,
    BOARD_STATE_SELF_TEST        = 10,
} diablo_board_state_t;

typedef struct {
    uint8_t  type;
    uint8_t  version;
    uint32_t timestamp_ms;
} diablo_header_t;

typedef struct {
    uint8_t  sensor_id;
    uint32_t data;
} diablo_datapoint_t;

typedef struct {
    uint32_t timestamp_ms;
    diablo_datapoint_t points[DIABLO_MAX_SENSORS];
} diablo_chunk_t;

typedef struct {
    uint8_t  num_sensors;
    uint8_t  sensor_ids[DIABLO_MAX_SENSORS];
    uint8_t  reference_voltage;
    bool     necessary_for_abort;
    uint8_t  controller_ip[4];      // octets in order, e.g. {192,168,2,11}; zero if not set
    uint8_t  enable_serial_printing;
} diablo_sensor_config_t;

typedef struct {
    uint8_t sensor_id;
    uint8_t result;   // 1 = good
} diablo_self_test_result_t;

// ---- Encoders: return bytes written, or 0 if the buffer is too small ----
size_t diablo_build_board_heartbeat(uint8_t *buf, size_t cap, uint32_t ts_ms,
                                    const uint8_t fw_hash[DIABLO_FW_HASH_LEN], uint8_t board_id,
                                    uint8_t engine_state, uint8_t board_state);

size_t diablo_build_sensor_data(uint8_t *buf, size_t cap, uint32_t ts_ms,
                                const diablo_chunk_t *chunks, uint8_t num_chunks, uint8_t num_sensors);

size_t diablo_build_self_test(uint8_t *buf, size_t cap, uint32_t ts_ms, uint8_t adc_good,
                              const diablo_self_test_result_t *results, uint8_t num_results);

// ---- Decoders ----
bool diablo_parse_header(const uint8_t *buf, size_t len, diablo_header_t *out);
bool diablo_parse_server_heartbeat(const uint8_t *buf, size_t len, uint8_t *engine_state_out);
bool diablo_parse_sensor_config(const uint8_t *buf, size_t len, diablo_sensor_config_t *out);
