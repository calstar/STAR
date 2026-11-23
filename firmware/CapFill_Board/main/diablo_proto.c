#include "diablo_proto.h"

#include <string.h>

static inline uint8_t *put_u8(uint8_t *p, uint8_t v) { *p = v; return p + 1; }

static inline uint8_t *put_u32le(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
    return p + 4;
}

static inline uint32_t get_u32le(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint8_t *put_header(uint8_t *p, uint8_t type, uint32_t ts_ms)
{
    p = put_u8(p, type);
    p = put_u8(p, DIABLO_PROTO_VERSION);
    return put_u32le(p, ts_ms);
}

size_t diablo_build_board_heartbeat(uint8_t *buf, size_t cap, uint32_t ts_ms,
                                    const uint8_t fw_hash[DIABLO_FW_HASH_LEN], uint8_t board_id,
                                    uint8_t engine_state, uint8_t board_state)
{
    const size_t total = DIABLO_HEADER_SIZE + DIABLO_FW_HASH_LEN + 3;
    if (!buf || cap < total) return 0;
    uint8_t *p = put_header(buf, PKT_BOARD_HEARTBEAT, ts_ms);
    memcpy(p, fw_hash, DIABLO_FW_HASH_LEN);
    p += DIABLO_FW_HASH_LEN;
    p = put_u8(p, board_id);
    p = put_u8(p, engine_state);
    p = put_u8(p, board_state);
    return (size_t)(p - buf);
}

size_t diablo_build_sensor_data(uint8_t *buf, size_t cap, uint32_t ts_ms,
                                const diablo_chunk_t *chunks, uint8_t num_chunks, uint8_t num_sensors)
{
    if (num_sensors > DIABLO_MAX_SENSORS) return 0;
    const size_t per_chunk = 4 + (size_t)num_sensors * 5;
    const size_t total = DIABLO_HEADER_SIZE + 2 + (size_t)num_chunks * per_chunk;
    if (!buf || cap < total) return 0;

    uint8_t *p = put_header(buf, PKT_SENSOR_DATA, ts_ms);
    p = put_u8(p, num_chunks);
    p = put_u8(p, num_sensors);
    for (uint8_t c = 0; c < num_chunks; c++) {
        p = put_u32le(p, chunks[c].timestamp_ms);
        for (uint8_t s = 0; s < num_sensors; s++) {
            p = put_u8(p, chunks[c].points[s].sensor_id);
            p = put_u32le(p, chunks[c].points[s].data);
        }
    }
    return (size_t)(p - buf);
}

size_t diablo_build_self_test(uint8_t *buf, size_t cap, uint32_t ts_ms, uint8_t adc_good,
                              const diablo_self_test_result_t *results, uint8_t num_results)
{
    const size_t total = DIABLO_HEADER_SIZE + 2 + (size_t)num_results * 2;
    if (!buf || cap < total) return 0;
    uint8_t *p = put_header(buf, PKT_SELF_TEST, ts_ms);
    p = put_u8(p, adc_good);
    p = put_u8(p, num_results);
    for (uint8_t i = 0; i < num_results; i++) {
        p = put_u8(p, results[i].sensor_id);
        p = put_u8(p, results[i].result);
    }
    return (size_t)(p - buf);
}

bool diablo_parse_header(const uint8_t *buf, size_t len, diablo_header_t *out)
{
    if (!buf || len < DIABLO_HEADER_SIZE) return false;
    out->type = buf[0];
    out->version = buf[1];
    out->timestamp_ms = get_u32le(buf + 2);
    return true;
}

bool diablo_parse_server_heartbeat(const uint8_t *buf, size_t len, uint8_t *engine_state_out)
{
    if (!buf || len < DIABLO_HEADER_SIZE + 1 || buf[0] != PKT_SERVER_HEARTBEAT) return false;
    *engine_state_out = buf[DIABLO_HEADER_SIZE];
    return true;
}

// Layout (after header): num_sensors(1), sensor_ids(N), reference_voltage(1), necessary_for_abort(1),
// [controller_ip(4) only if necessary_for_abort], enable_serial_printing(1).
// Same length checks as Diablo::parse_sensor_config_packet.
bool diablo_parse_sensor_config(const uint8_t *buf, size_t len, diablo_sensor_config_t *out)
{
    if (!buf || len < DIABLO_HEADER_SIZE + 4 || buf[0] != PKT_SENSOR_CONFIG) return false;

    const uint8_t *p = buf + DIABLO_HEADER_SIZE;
    const uint8_t *end = buf + len;
    uint8_t n = *p++;
    if ((size_t)(end - p) < (size_t)n + 3) return false;

    memset(out, 0, sizeof(*out));
    // Like the club core, keep at most MAX_SENSORS_PER_BOARD ids.
    out->num_sensors = n > DIABLO_MAX_SENSORS ? DIABLO_MAX_SENSORS : n;
    memcpy(out->sensor_ids, p, out->num_sensors);
    p += n;

    out->reference_voltage = *p++;
    out->necessary_for_abort = (*p++ != 0);
    if (out->necessary_for_abort) {
        if (end - p < 5) return false;
        memcpy(out->controller_ip, p, 4);   // wire bytes are the octets in order
        p += 4;
    }
    if (end - p < 1) return false;
    out->enable_serial_printing = *p;
    return true;
}
