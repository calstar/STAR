#include "daq_wire.h"

#include <string.h>

static void le32(uint8_t* p, uint32_t v) {
    for (unsigned i = 0; i < 4; ++i)
        p[i] = (uint8_t)(v >> (8 * i));
}
static void header(uint8_t* p, uint8_t type, uint32_t ms) {
    p[0] = type;
    p[1] = 0; /* DIABLO_COMMS_VERSION */
    le32(p + 2, ms);
}
static uint16_t channel(uint8_t id) {
    return id >= 1 && id <= DAQ_CHANNELS ? (uint16_t)(1U << (id - 1)) : 0;
}
bool daq_peer_receive(daq_peer_t* p, const uint8_t* b, size_t n, uint32_t ms) {
    if (!p || !b || n < 7 || b[1] != 0)
        return false;
    if (b[0] == 2) {
        if (n != 7 || b[6] > 4)
            return false;
        p->engine_state = b[6];
    } else if (b[0] == 5) {
        uint8_t count = b[6];
        /* num, ids, ref, necessary_for_abort, print. This flight transport
         * cannot participate in the hotfire abort-controller contract. */
        if (count > DAQ_CHANNELS || n != (size_t)10 + count ||
            b[8 + count] != 0 || b[9 + count] > 3)
            return false;
        uint16_t mask = 0;
        for (unsigned i = 0; i < count; ++i) {
            uint16_t bit = channel(b[7 + i]);
            if (!bit || (mask & bit))
                return false;
            mask |= bit;
        }
        p->channels = mask;
        p->configured = true;
    } else {
        return false;
    }
    p->heard_server = true;
    p->last_server_ms = ms;
    return true;
}
void daq_peer_expire(daq_peer_t* p, uint32_t ms) {
    if (p->heard_server && ms - p->last_server_ms >= 10000U) {
        p->configured = false;
        p->channels = 0;
        p->heard_server = false;
    }
}
bool daq_sample_valid(const daq_sample_t* s) {
    if (!s || !s->count || s->count > DAQ_CHANNELS)
        return false;
    uint16_t mask = 0;
    for (unsigned i = 0; i < s->count; ++i) {
        uint16_t bit = channel(s->values[i].id);
        if (!bit || (mask & bit))
            return false;
        mask |= bit;
    }
    return true;
}
size_t daq_encode_sample(const daq_sample_t* s, uint16_t channels, uint8_t* out,
                         size_t cap) {
    if (!out || !daq_sample_valid(s))
        return 0;
    uint8_t count = 0;
    for (unsigned i = 0; i < s->count; ++i)
        if (channel(s->values[i].id) & channels)
            ++count;
    size_t n = 12U + 5U * count;
    if (!count || cap < n)
        return 0;
    header(out, 3, s->timestamp_ms);
    out[6] = 1; /* one chunk; never replay a stale cached sample */
    out[7] = count;
    le32(out + 8, s->timestamp_ms);
    size_t offset = 12;
    for (unsigned i = 0; i < s->count; ++i) {
        if (!(channel(s->values[i].id) & channels))
            continue;
        out[offset++] = s->values[i].id;
        le32(out + offset, s->values[i].value);
        offset += 4;
    }
    return n;
}
size_t daq_encode_heartbeat(const daq_peer_t* p, uint8_t id,
                            const uint8_t hash[32], uint32_t ms, uint8_t* out,
                            size_t cap) {
    if (!p || !id || !hash || !out || cap < 41)
        return 0;
    header(out, 1, ms);
    memcpy(out + 6, hash, 32);
    out[38] = id;
    out[39] = p->engine_state;
    out[40] = p->configured ? 2 : 1; /* ACTIVE / SETUP */
    return 41;
}
