#include "fc_config.h"

#include <string.h>

#include "emmc_log.h" /* emmc_log_crc32: the IEEE CRC-32 the GUI uses too */

#define BAND_LO_HZ 902000000UL /* 33 cm amateur band, 47 CFR 97.301 */
#define BAND_HI_HZ 928000000UL

fc_config_t fc_config_defaults(void) {
    /* The firmware's constants before this file: sx1262_setup.h kDefaultLora,
     * bringup_task.c, idle_task.c, gnss_core.h, dev_ism330dhcx.c (0x74/0x71),
     * dev_h3lis100dl.c (0x37), dev_ms5611.h. hb_flight_ms had no constant. */
    fc_config_t c = {
        .radio_freq_hz = 915000000UL,
        .radio_sf = 9,
        .radio_bw_hz = 125000UL,
        .radio_cr = 5,
        .radio_tx_dbm = 22,
        .radio_preamble = 8,
        .radio_sync_word = 0x1424,
        .hb_self_test_ms = 1000,
        .hb_idle_ms = 10000,
        .hb_flight_ms = 500,
        .gnss_rate_ms = 100,
        .gnss_dyn_model = 8,
        .gnss_constellations = 0x1F,
        .imu_odr_hz = 833,
        .imu_accel_fs_g = 16,
        .imu_gyro_fs_dps = 4000,
        .highg_odr_hz = 400,
        .baro_osr = 4096,
        .role = FC_ROLE_TRANSMITTER,
    };
    return c;
}

static bool one_of(uint32_t v, const uint32_t* set, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        if (set[i] == v) {
            return true;
        }
    }
    return false;
}
#define ONE_OF(v, ...)                           \
    one_of((v), (const uint32_t[]){__VA_ARGS__}, \
           sizeof((const uint32_t[]){__VA_ARGS__}) / sizeof(uint32_t))

/* What the firmware can run, which is narrower than the chips in places:
 * SF and BW are the ones radio time-on-air knows (sx1262_setup.cpp), Idle
 * needs >= 1 s (idle.c), the H3LIS100DL has no 1000 Hz normal mode, and
 * constellations are not sent to the GPS yet (its default, 0x1F, stays). */
uint8_t fc_config_check(const fc_config_t* c) {
    uint32_t half = c->radio_bw_hz / 2U;
    if (c->radio_freq_hz - half < BAND_LO_HZ ||
        c->radio_freq_hz + half > BAND_HI_HZ) {
        return 1;
    }
    if (c->radio_sf < 7 || c->radio_sf > 12)
        return 2;
    if (!ONE_OF(c->radio_bw_hz, 125000, 250000, 500000))
        return 3;
    if (c->radio_cr < 5 || c->radio_cr > 8)
        return 4;
    if (c->radio_tx_dbm < -9 || c->radio_tx_dbm > 22)
        return 5;
    if (c->radio_preamble < 6 || c->radio_preamble > 1024)
        return 6;
    if (!ONE_OF(c->radio_sync_word, 0x1424, 0x3444))
        return 7;
    if (c->hb_self_test_ms < 100 || c->hb_self_test_ms > 60000)
        return 8;
    if (c->hb_idle_ms < 1000 || c->hb_idle_ms > 60000)
        return 9;
    if (c->hb_flight_ms < 500 || c->hb_flight_ms > 60000)
        return 10;
    if (!ONE_OF(c->gnss_rate_ms, 100, 125, 200, 250, 500, 1000))
        return 11;
    if (c->gnss_dyn_model == 1 || c->gnss_dyn_model > 8)
        return 12;
    if (c->gnss_constellations != 0x1F)
        return 13;
    if (!ONE_OF(c->imu_odr_hz, 26, 52, 104, 208, 416, 833))
        return 14;
    if (!ONE_OF(c->imu_accel_fs_g, 2, 4, 8, 16))
        return 15;
    if (!ONE_OF(c->imu_gyro_fs_dps, 125, 250, 500, 1000, 2000, 4000))
        return 16;
    if (!ONE_OF(c->highg_odr_hz, 50, 100, 400))
        return 17;
    if (!ONE_OF(c->baro_osr, 256, 512, 1024, 2048, 4096))
        return 18;
    if (c->role > FC_ROLE_RECEIVER)
        return 19;
    return 0;
}

static uint8_t* put(uint8_t* p, uint32_t v, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        *p++ = (uint8_t)(v >> (8U * i)); /* little-endian */
    }
    return p;
}

static uint32_t get(const uint8_t** p, size_t n) {
    uint32_t v = 0;
    for (size_t i = 0; i < n; ++i) {
        v |= (uint32_t)(*p)[i] << (8U * i);
    }
    *p += n;
    return v;
}

/* Every field once, in PROTOCOL.md order: X(field, bytes). */
/* clang-format off */
#define FIELDS(X)              \
    X(radio_freq_hz, 4)        \
    X(radio_sf, 1)             \
    X(radio_bw_hz, 4)          \
    X(radio_cr, 1)             \
    X(radio_tx_dbm, 1)         \
    X(radio_preamble, 2)       \
    X(radio_sync_word, 2)      \
    X(hb_self_test_ms, 2)      \
    X(hb_idle_ms, 2)           \
    X(hb_flight_ms, 2)         \
    X(gnss_rate_ms, 2)         \
    X(gnss_dyn_model, 1)       \
    X(gnss_constellations, 1)  \
    X(imu_odr_hz, 2)           \
    X(imu_accel_fs_g, 1)       \
    X(imu_gyro_fs_dps, 2)      \
    X(highg_odr_hz, 2)         \
    X(baro_osr, 2)             \
    X(role, 1)
/* clang-format on */

void fc_config_pack(const fc_config_t* c, uint8_t out[FC_CONFIG_SIZE]) {
    uint8_t* p = out;
    *p++ = FC_CONFIG_VERSION;
    *p++ = 0;
    p = put(p, FC_CONFIG_SIZE, 2);
#define X(f, n) p = put(p, (uint32_t)c->f, n);
    FIELDS(X)
#undef X
    put(p, emmc_log_crc32(out, FC_CONFIG_SIZE - 4U), 4);
}

bool fc_config_equal(const fc_config_t* a, const fc_config_t* b) {
    uint8_t x[FC_CONFIG_SIZE], y[FC_CONFIG_SIZE];
    fc_config_pack(a, x);
    fc_config_pack(b, y);
    return memcmp(x, y, sizeof x) == 0;
}

bool fc_config_unpack(const uint8_t* blob, size_t len, fc_config_t* out) {
    if (len != FC_CONFIG_SIZE || blob[0] != FC_CONFIG_VERSION ||
        (blob[2] | blob[3] << 8) != FC_CONFIG_SIZE) {
        return false;
    }
    const uint8_t* p = blob + FC_CONFIG_SIZE - 4U;
    if (get(&p, 4) != emmc_log_crc32(blob, FC_CONFIG_SIZE - 4U)) {
        return false;
    }
    p = blob + 4;
    fc_config_t c;
#define X(f, n) c.f = (__typeof__(c.f))get(&p, n);
    FIELDS(X)
#undef X
    *out = c;
    return true;
}

void fc_config_record(const fc_config_t* c, uint32_t sequence,
                      uint8_t out[FC_CONFIG_RECORD]) {
    memset(out, 0xFF, FC_CONFIG_RECORD); /* the padding stays erased */
    put(put(out, FC_CONFIG_MAGIC, 4), sequence, 4);
    fc_config_pack(c, out + 8);
}

bool fc_config_find(const uint8_t* sector, size_t size,
                    bool (*slot_ok)(size_t slot), fc_config_t* out,
                    uint32_t* sequence, size_t* next_slot) {
    size_t slots = size / FC_CONFIG_RECORD;
    bool found = false;
    *next_slot = slots;
    for (size_t i = 0; i < slots; ++i) {
        const uint8_t* r = sector + i * FC_CONFIG_RECORD;
        if (slot_ok && !slot_ok(i)) {
            continue; /* a torn write: skip it, keep looking */
        }
        const uint8_t* p = r;
        uint32_t magic = get(&p, 4), seq = get(&p, 4);
        if (magic == 0xFFFFFFFFUL) {
            *next_slot = i;
            break; /* erased: the end of the list */
        }
        fc_config_t c;
        if (magic == FC_CONFIG_MAGIC &&
            fc_config_unpack(r + 8, FC_CONFIG_SIZE, &c) &&
            fc_config_check(&c) == 0 && (!found || seq > *sequence)) {
            *out = c;
            *sequence = seq;
            found = true;
        }
    }
    return found;
}
