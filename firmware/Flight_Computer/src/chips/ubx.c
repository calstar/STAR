#include "ubx.h"

#include <string.h>

size_t ubx_frame(uint8_t* out, size_t cap, uint8_t cls, uint8_t id,
                 const uint8_t* payload, uint16_t len) {
    size_t total = (size_t)len + 8U;
    if (!out || total > cap || (len && !payload)) {
        return 0;
    }
    out[0] = 0xB5;
    out[1] = 0x62;
    out[2] = cls;
    out[3] = id;
    out[4] = (uint8_t)len;
    out[5] = (uint8_t)(len >> 8);
    if (len) {
        memcpy(&out[6], payload, len);
    }
    uint8_t a = 0, b = 0;
    for (size_t i = 2; i < 6U + len; ++i) {
        a = (uint8_t)(a + out[i]);
        b = (uint8_t)(b + a);
    }
    out[6 + len] = a;
    out[7 + len] = b;
    return total;
}

size_t ubx_valset(uint8_t* out, size_t cap, const ubx_item_t* items,
                  size_t count) {
    uint8_t payload[4 + 8 * 16];
    if (!items || count == 0 || count > 16) {
        return 0;
    }
    size_t n = 0;
    payload[n++] = 0x00; /* version */
    payload[n++] = 0x01; /* layers: RAM */
    payload[n++] = 0x00; /* reserved */
    payload[n++] = 0x00;
    for (size_t i = 0; i < count; ++i) {
        uint8_t size = items[i].size;
        if (size != 1 && size != 2 && size != 4) {
            return 0;
        }
        for (int k = 0; k < 4; ++k) {
            payload[n++] = (uint8_t)(items[i].key >> (8 * k));
        }
        for (int k = 0; k < size; ++k) {
            payload[n++] = (uint8_t)(items[i].value >> (8 * k));
        }
    }
    return ubx_frame(out, cap, UBX_CLASS_CFG, UBX_ID_CFG_VALSET, payload,
                     (uint16_t)n);
}

static uint32_t u32(const uint8_t* p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
           (uint32_t)p[3] << 24;
}

static int32_t i32(const uint8_t* p) {
    return (int32_t)u32(p);
}

bool ubx_parse_nav_pvt(const uint8_t* p, uint16_t len, ubx_pvt_t* out) {
    if (!p || !out || len != UBX_NAV_PVT_LEN) {
        return false;
    }
    /* Offsets: Interface Description 3.15.11, p.95-96 */
    out->itow_ms = u32(p + 0);
    out->year = (uint16_t)(p[4] | p[5] << 8);
    out->month = p[6];
    out->day = p[7];
    out->hour = p[8];
    out->min = p[9];
    out->sec = p[10];
    out->valid = p[11];
    out->fix_type = p[20];
    out->flags = p[21];
    out->num_sv = p[23];
    out->lon_e7 = i32(p + 24);
    out->lat_e7 = i32(p + 28);
    out->height_mm = i32(p + 32);
    out->hmsl_mm = i32(p + 36);
    out->hacc_mm = u32(p + 40);
    out->vacc_mm = u32(p + 44);
    out->vel_n_mms = i32(p + 48);
    out->vel_e_mms = i32(p + 52);
    out->vel_d_mms = i32(p + 56);
    out->sacc_mms = u32(p + 68);
    out->pdop_e2 = (uint16_t)(p[76] | p[77] << 8);
    return true;
}

size_t ubx_poll(uint8_t* out, size_t cap, uint8_t cls, uint8_t id) {
    return ubx_frame(out, cap, cls, id, NULL, 0);
}

static uint16_t u16(const uint8_t* p) {
    return (uint16_t)(p[0] | p[1] << 8);
}

bool ubx_parse_mon_rf(const uint8_t* p, uint16_t len, ubx_rf_t* out) {
    /* 4-byte header, then nBlocks blocks of 24 (3.14.6, p.86) */
    if (!p || !out || len < 4U + 24U || p[1] < 1U) {
        return false;
    }
    const uint8_t* b = p + 4;
    out->jamming = (uint8_t)(b[1] & 3U); /* flags bits 1..0 */
    out->ant_status = b[2];
    out->ant_power = b[3];
    out->noise = u16(b + 12);
    out->agc = u16(b + 14);
    out->cw = b[16];
    return true;
}

bool ubx_sat_summary(const uint8_t* p, uint16_t len, ubx_sats_t* out) {
    /* 8-byte header, then numSvs blocks of 12 (3.15.13, p.98) */
    if (!p || !out || len < 8U) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    out->listed = p[5];
    uint16_t fit = (uint16_t)((len - 8U) / 12U);
    uint8_t n = out->listed < fit ? out->listed : (uint8_t)fit;
    for (uint8_t i = 0; i < n; ++i) {
        const uint8_t* sv = p + 8 + 12U * i;
        uint8_t cno = sv[2];
        uint32_t flags = u32(sv + 8);
        out->seen++;
        if (cno > 0U) {
            out->with_signal++;
        }
        if ((flags & 7U) >= 4U) { /* qualityInd */
            out->locked++;
        }
        if (flags & (1UL << 3)) { /* svUsed */
            out->used++;
        }
        if (cno > out->best_cno) {
            out->best_cno = cno;
        }
    }
    return true;
}
