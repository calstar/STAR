/*
 * flight_e2e: the flight computer's data pipeline end to end, on a laptop.
 *
 *   flight profile -> fake chips -> REAL chip drivers (chips/) -> REAL
 *   sensors_core (app/) -> REAL emmc_log (Core/) -> fake eMMC card ->
 *   independent log reader -> compared against the profile
 *   simulated MAX-M10S -> REAL ubx + gnss_frame + gnss_core -> same log
 *
 * Time is virtual. The harness plays the RTOS: it wakes the sensors core on
 * data-ready edges (+37 us latency) or on the core's own deadlines, and runs
 * the eMMC writer every 10 ms, exactly as sensors_task and the emmc writer
 * task do on the board. Only the chips, the card and the clock are fake.
 *
 * Output, one line per check (parsed by ./flight_test):
 *   CHECK <id> PASS|FAIL <description> | <detail>
 * Usage: flight_e2e [--list] [--only=id,id]
 * Exit 0 only if every selected check passed.
 */
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "emmc_log.h"
#include "fake_baro.h"
#include "fake_gnss.h"
#include "fake_regs.h"
#include "gnss_core.h"
#include "sensors_core.h"

/* ------------------------------------------------------------------ */
/* Flight profile: the truth every check compares against.            */

#define FLIGHT_US 20000000U
#define T_LAUNCH_US 2000000U  /* ARMED -> LAUNCHED */
#define T_BURNOUT_US 4000000U /* boost ends */
#define T_RECOVERY_US 10000000U

enum { PAD, BOOST, COAST, DESCENT };

static int phase_at(uint32_t t) {
    if (t < T_LAUNCH_US)
        return PAD;
    if (t < T_BURNOUT_US)
        return BOOST;
    if (t < T_RECOVERY_US)
        return COAST;
    return DESCENT;
}

/* IMU raw: accel z by phase (1 g = 2049 LSB at 0.488 mg), the rest varies
 * with time so a reordered or stale sample cannot pass. */
static void imu_truth(uint32_t t, int16_t out[7]) {
    static const int16_t accel_z[] = {2049, 16393, 0, 2049}; /* 1, 8, 0, 1 g */
    uint32_t ms = t / 1000U;
    out[0] = (int16_t)(ms % 256U);  /* temp */
    out[1] = (int16_t)(ms % 1000U); /* gyro x */
    out[2] = (int16_t)-(int16_t)(ms % 700U);
    out[3] = (int16_t)(t % 30011U);
    out[4] = (int16_t)(ms % 97U); /* accel x */
    out[5] = (int16_t)-(int16_t)(ms % 89U);
    out[6] = accel_z[phase_at(t)];
}

static void highg_truth(uint32_t t, int8_t out[3]) {
    static const int8_t z[] = {1, 10, 0, 1}; /* 780 mg/digit */
    out[0] = (int8_t)((t / 2500U) % 50U);
    out[1] = (int8_t)-(int8_t)((t / 2500U) % 40U);
    out[2] = z[phase_at(t)];
}

/* Barometer: datasheet-verified (D1, D2) -> (TEMP, P) vectors per phase, so
 * the expected values do not come from the code under test. */
static const struct {
    uint32_t d1, d2;
    int32_t temp, p;
} kBaro[] = {
    {9085466, 8569150, 2007, 100009}, /* pad: datasheet p.8 example */
    {8900000, 8330000, 1175, 94911},  /* boost: 2nd-order branch */
    {8500000, 7300000, -3022, 79839}, /* coast: very-low branch */
    {9085466, 8569150, 2007, 100009}, /* descent */
};

/* GPS truth: climbs during boost/coast, comes down after. */
static void gps_truth(uint32_t t, ubx_pvt_t* v) {
    v->itow_ms = 300000000U + t / 1000U;
    v->fix_type = 3;
    v->flags = 1;
    v->num_sv = 10;
    v->lat_e7 = 378719000 + (int32_t)(t / 100000U);
    v->lon_e7 = -1222585000;
    v->hmsl_mm = 100000 + (int32_t)(t / 50U);
    v->vel_d_mms = phase_at(t) == DESCENT ? 8000 : -20000;
    v->hacc_mm = 2000;
    v->vacc_mm = 3000;
    v->pdop_e2 = 140;
}

/* ------------------------------------------------------------------ */
/* Fake eMMC card (emmc_port_t) with fault injection.                 */

#define BS EMMC_BLOCK_SIZE
#define DATA_START EMMC_LOG_DEFAULT_DATA_START
#define CAPACITY (DATA_START + 8192U)

typedef struct {
    uint8_t* blocks;
    uint32_t fail_from_ms, fail_until_ms; /* writes time out in this window */
    uint32_t now_ms;
    unsigned writes, failed_writes;
} card_t;

static emmc_status_t c_start(void* ctx, uint32_t* count) {
    (void)ctx;
    *count = CAPACITY;
    return EMMC_OK;
}
static emmc_status_t c_read(void* ctx, uint32_t lba, void* buf, uint32_t n,
                            uint32_t budget) {
    card_t* c = ctx;
    (void)budget;
    if (lba + n > CAPACITY)
        return EMMC_ERR_PARAM;
    memcpy(buf, c->blocks + (size_t)lba * BS, (size_t)n * BS);
    return EMMC_OK;
}
static emmc_status_t c_write(void* ctx, uint32_t lba, const void* buf,
                             uint32_t n, uint32_t budget) {
    card_t* c = ctx;
    (void)budget;
    if (lba + n > CAPACITY)
        return EMMC_ERR_PARAM;
    if (c->now_ms >= c->fail_from_ms && c->now_ms < c->fail_until_ms) {
        c->failed_writes++;
        return EMMC_ERR_TIMEOUT;
    }
    c->writes++;
    memcpy(c->blocks + (size_t)lba * BS, buf, (size_t)n * BS);
    return EMMC_OK;
}

/* ------------------------------------------------------------------ */
/* Independent log reader (CRC-32 implemented here, not emmc_log_crc32) */

typedef struct {
    uint8_t type, len;
    uint32_t t_ms;
    uint8_t data[64];
} rec_t;

typedef struct {
    bool super_ok;
    uint32_t blocks, bad_blocks, sessions;
    unsigned n;
    rec_t* recs;
} image_t;

static uint32_t crc32_ref(const uint8_t* p, size_t n) {
    uint32_t c = 0xFFFFFFFFU;
    for (size_t i = 0; i < n; ++i) {
        c ^= p[i];
        for (int k = 0; k < 8; ++k)
            c = (c >> 1) ^ (0xEDB88320U & -(c & 1U));
    }
    return ~c;
}
static uint32_t rd32(const uint8_t* p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
           (uint32_t)p[3] << 24;
}

static void read_image(const card_t* card, image_t* img, unsigned max) {
    memset(img, 0, sizeof(*img));
    img->recs = calloc(max, sizeof(rec_t));
    const uint8_t* s = card->blocks;
    img->super_ok =
        rd32(s) == 0x31425353U && rd32(s + 508) == crc32_ref(s, 508);
    if (!img->super_ok)
        return;
    uint32_t epoch = rd32(s + 8), last_session = 0;
    for (uint32_t k = 0; DATA_START + k < CAPACITY; ++k) {
        const uint8_t* b = card->blocks + (size_t)(DATA_START + k) * BS;
        if (rd32(b) != 0x31474C53U || rd32(b + 4) != epoch || rd32(b + 8) != k)
            break; /* end of the run */
        if (rd32(b + 508) != crc32_ref(b, 508)) {
            img->bad_blocks++;
            break;
        }
        img->blocks++;
        if (rd32(b + 12) != last_session) {
            last_session = rd32(b + 12);
            img->sessions++;
        }
        unsigned used = (unsigned)(b[18] | b[19] << 8);
        if (b[16] != 1)
            continue; /* pad block */
        for (unsigned o = 0; o + 6 <= used && img->n < max;) {
            const uint8_t* r = b + 20 + o;
            rec_t* x = &img->recs[img->n++];
            x->type = r[0];
            x->len = r[1];
            x->t_ms = rd32(r + 2);
            memcpy(x->data, r + 6, x->len < 64 ? x->len : 64);
            o += 6U + r[1];
        }
    }
}

/* ------------------------------------------------------------------ */
/* The simulated board.                                               */

#define MAX_RECS 40000U
#define WAKE_LATENCY_US 37U

typedef struct {
    uint32_t imu_fail_from, imu_fail_until; /* IMU bus dead in this window */
    uint32_t card_fail_from_ms, card_fail_until_ms;
} faults_t;

typedef struct {
    fake_regs_t imu, highg;
    fake_baro_t baro;
    sensors_core_t core;
    fake_gnss_t gps;
    gnss_core_t gnss;
    uint32_t next_gps_us, next_pps_us;
    unsigned n_gnss;
    uint32_t chunk_start_ms;         /* first record of the chunk now filling */
    uint32_t sealed_before_stall_ms; /* chunk_start_ms when the card stalled */
    bool stall_seen;
    card_t card;
    emmc_log_t log;
    emmc_log_chunk_t chunks[4];
    uint8_t scratch[BS];
    flight_state_t state;
    uint32_t now, next_imu, next_highg, edge_imu, edge_highg, next_service;
    rec_t* produced; /* everything the core emitted while recording */
    unsigned n_produced, n_type[3];
    uint32_t first_t[3], last_t[3], backwards[3];
    unsigned appended, refused;
    faults_t faults;
} world_t;

static void sink(void* ctx, uint8_t type, const void* data, uint8_t len) {
    world_t* w = ctx;
    int i = type - REC_IMU;
    if (type == REC_GNSS)
        w->n_gnss++;
    if (i >= 0 && i < 3) {
        uint32_t t;
        memcpy(&t, data, 4);
        if (w->n_type[i] == 0)
            w->first_t[i] = t;
        else if ((int32_t)(t - w->last_t[i]) <= 0)
            w->backwards[i]++;
        w->last_t[i] = t;
        w->n_type[i]++;
    }
    uint32_t now_ms = w->now / 1000U;
    if (!w->stall_seen && w->faults.card_fail_until_ms &&
        now_ms >= w->faults.card_fail_from_ms) {
        w->stall_seen = true;
        w->sealed_before_stall_ms = w->chunk_start_ms;
    }
    bool had = w->log.has_fill;
    uint8_t c = w->log.fill_chunk, blk = w->log.fill_block;
    uint16_t off = w->log.fill_offset;
    bool ok = emmc_log_append(&w->log, type, now_ms, data, len);
    if (w->log.has_fill &&
        (!had || w->log.fill_chunk != c || w->log.fill_block < blk ||
         (w->log.fill_block == blk && w->log.fill_offset < off)))
        w->chunk_start_ms = now_ms; /* this record opened a new chunk */
    if (ok) {
        w->appended++;
    } else {
        w->refused++;
    }
    if (w->n_produced < MAX_RECS) {
        rec_t* r = &w->produced[w->n_produced++];
        r->type = type;
        r->len = len;
        r->t_ms = w->now / 1000U;
        memcpy(r->data, data, len);
    }
}

static void set_chips(world_t* w, uint32_t t) {
    int16_t v[7];
    imu_truth(t, v);
    for (int i = 0; i < 7; ++i) {
        w->imu.regs[0x20 + 2 * i] = (uint8_t)v[i];
        w->imu.regs[0x21 + 2 * i] = (uint8_t)((uint16_t)v[i] >> 8);
    }
    int8_t g[3];
    highg_truth(t, g);
    w->highg.regs[0x29] = (uint8_t)g[0];
    w->highg.regs[0x2B] = (uint8_t)g[1];
    w->highg.regs[0x2D] = (uint8_t)g[2];
    w->baro.d1 = kBaro[phase_at(t)].d1;
    w->baro.d2 = kBaro[phase_at(t)].d2;
    bool imu_dead =
        t >= w->faults.imu_fail_from && t < w->faults.imu_fail_until;
    w->imu.fail_after = imu_dead ? (int)w->imu.transfers : -1;
    /* SW_RESET (CTRL3_C bit 0) clears itself on the next read, every time. */
    w->imu.self_clear_reg = 0x12;
    w->imu.self_clear_bits = 0x01;
    w->imu.clear_after_reads = 1;
}

static void change_state(world_t* w, flight_state_t to) {
    emmc_log_on_state(&w->log, w->state, to, w->now / 1000U);
    w->state = to;
}

static void world_init(world_t* w, const faults_t* faults) {
    memset(w, 0, sizeof(*w));
    if (faults)
        w->faults = *faults;
    w->produced = calloc(MAX_RECS, sizeof(rec_t));
    w->card.blocks = calloc(CAPACITY, BS);
    w->card.fail_from_ms = w->faults.card_fail_from_ms;
    w->card.fail_until_ms = w->faults.card_fail_until_ms;
    fake_regs_init(&w->imu, false);
    w->imu.regs[0x0F] = 0x6B;
    fake_regs_init(&w->highg, true);
    w->highg.regs[0x0F] = 0x32;
    memcpy(w->baro.prom, fake_baro_datasheet_prom, sizeof(w->baro.prom));

    static const emmc_port_t port = {c_start, c_read, c_write, NULL, NULL};
    emmc_log_config_t cfg = emmc_log_default_config();
    emmc_log_init(&w->log, &port, &w->card, &cfg, w->chunks, 4, w->scratch);

    w->core.imu_bus = fake_regs_bus(&w->imu);
    w->core.highg_bus = fake_regs_bus(&w->highg);
    w->core.baro_bus = fake_baro_bus(&w->baro);
    w->core.sink.record = sink;
    w->core.sink.ctx = w;
    set_chips(w, 0);
    sensors_core_init(&w->core, 0);
    fake_gnss_init(&w->gps, 9600, gps_truth); /* cold module (p.13) */
    w->gnss.io = fake_gnss_io(&w->gps);
    w->gnss.sink.record = sink;
    w->gnss.sink.ctx = w;
    gnss_core_init(&w->gnss, 0);
    w->next_gps_us = 1000U;
    w->next_pps_us = 1000000U;
    w->state = FLIGHT_IDLE;
    change_state(w, FLIGHT_ARMED); /* recording starts at ARMED */
    w->next_imu = SENSORS_IMU_PERIOD_US;
    w->next_highg = SENSORS_HIGHG_PERIOD_US;
    w->next_service = 10000U;
}

static void service_card(world_t* w) {
    w->card.now_ms = w->now / 1000U;
    for (int i = 0; i < 4; ++i) { /* the writer loops while there is work */
        emmc_log_service(&w->log, w->now / 1000U);
        if (emmc_log_backlog(&w->log) == 0)
            break;
    }
}

static int32_t diff(uint32_t a, uint32_t b) {
    return (int32_t)(a - b);
}

static void fly(world_t* w) {
    while (diff(FLIGHT_US, w->now) > 0) {
        uint32_t wake = w->now + sensors_core_wait_us(&w->core, w->now);
        if (wake == w->now)
            wake++;
        if (diff(w->next_imu, wake) < 0)
            wake = w->next_imu;
        if (diff(w->next_highg, wake) < 0)
            wake = w->next_highg;
        if (diff(w->next_service, wake) < 0)
            wake = w->next_service;
        if (diff(w->next_gps_us, wake) < 0)
            wake = w->next_gps_us;
        uint32_t ev = 0;
        if (diff(w->next_imu, wake) <= 0) {
            ev |= SENSORS_EV_IMU;
            w->edge_imu = w->next_imu;
            w->next_imu += SENSORS_IMU_PERIOD_US;
        }
        if (diff(w->next_highg, wake) <= 0) {
            ev |= SENSORS_EV_HIGHG;
            w->edge_highg = w->next_highg;
            w->next_highg += SENSORS_HIGHG_PERIOD_US;
        }
        uint32_t now = ev ? wake + WAKE_LATENCY_US : wake;
        if (diff(now, w->now) > 0)
            w->now = now;
        /* Chips latch a sample at its data-ready edge. */
        set_chips(w, ev & SENSORS_EV_IMU ? w->edge_imu : w->now);
        if (phase_at(w->now) == BOOST && w->state == FLIGHT_ARMED)
            change_state(w, FLIGHT_LAUNCHED);
        if (phase_at(w->now) == DESCENT && w->state == FLIGHT_LAUNCHED)
            change_state(w, FLIGHT_RECOVERY);
        sensors_core_step(&w->core, ev, w->edge_imu, w->edge_highg, w->now);
        if (diff(w->now, w->next_gps_us) >= 0) { /* gnss_task, 1 ms */
            uint8_t buf[512];
            if (diff(w->now, w->next_pps_us) >= 0) {
                gnss_core_set_pps(&w->gnss, w->next_pps_us);
                w->next_pps_us += 1000000U;
            }
            size_t n = fake_gnss_emit(&w->gps, w->now, buf, sizeof(buf));
            gnss_core_feed(&w->gnss, buf, n, w->now);
            gnss_core_poll(&w->gnss, w->now);
            w->next_gps_us += 1000U;
        }
        if (diff(w->now, w->next_service) >= 0) {
            service_card(w);
            w->next_service += 10000U;
        }
    }
    change_state(w, FLIGHT_IDLE); /* session end + flush */
    for (int i = 0; i < 64 && emmc_log_backlog(&w->log); ++i) {
        w->now += 10000U;
        service_card(w);
    }
}

static void world_free(world_t* w) {
    free(w->produced);
    free(w->card.blocks);
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */

static char detail[512];
static bool ok;
#define EXPECT(cond, ...)                                  \
    do {                                                   \
        if (!(cond)) {                                     \
            snprintf(detail, sizeof(detail), __VA_ARGS__); \
            ok = false;                                    \
            return;                                        \
        }                                                  \
    } while (0)
static void note(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(detail, sizeof(detail), fmt, ap);
    va_end(ap);
}

static world_t W; /* the nominal flight, shared by the read-only checks */
static image_t IMG;
static bool flown;

static void nominal(void) {
    if (flown)
        return;
    world_init(&W, NULL);
    fly(&W);
#ifdef FLIGHT_TEST_CANARY
    /* Test of the tests: corrupt one byte of one logged block. The
     * conservation and round-trip checks must now fail. */
    W.card.blocks[(size_t)(DATA_START + 3) * BS + 100] ^= 0x01;
#endif
    read_image(&W.card, &IMG, MAX_RECS);
    flown = true;
}

static void check_sensor_rates(void) {
    nominal();
    double s = FLIGHT_US / 1e6;
    double imu = W.n_type[0] / s, hg = W.n_type[1] / s, baro = W.n_type[2] / s;
    EXPECT(imu > 833.3 * 0.99 && imu < 833.3 * 1.01, "IMU %.1f Hz", imu);
    EXPECT(hg > 400 * 0.99 && hg < 400 * 1.01, "high-g %.1f Hz", hg);
    EXPECT(baro > 49 && baro < 51, "baro %.1f Hz", baro);
    note("IMU %.1f Hz, high-g %.1f Hz, baro %.1f Hz over %.0f s", imu, hg, baro,
         s);
}

static void check_sample_values(void) {
    nominal();
    unsigned n = 0;
    for (unsigned i = 0; i < W.n_produced; ++i) {
        const rec_t* r = &W.produced[i];
        uint32_t t;
        memcpy(&t, r->data, 4);
        if (r->type == REC_IMU) {
            rec_imu_t s;
            memcpy(&s, r->data, sizeof(s));
            int16_t v[7];
            imu_truth(t, v);
            int16_t got[7] = {s.temp,     s.gyro[0],  s.gyro[1], s.gyro[2],
                              s.accel[0], s.accel[1], s.accel[2]};
            EXPECT(memcmp(v, got, sizeof(v)) == 0,
                   "IMU sample at t=%u us differs from the profile", t);
        } else if (r->type == REC_HIGHG) {
            rec_highg_t s;
            memcpy(&s, r->data, sizeof(s));
            int8_t g[3];
            highg_truth(t, g);
            EXPECT(memcmp(g, s.accel, 3) == 0,
                   "high-g sample at t=%u us differs from the profile", t);
        } else if (r->type == REC_BARO) {
            rec_baro_t s;
            memcpy(&s, r->data, sizeof(s));
            int p = phase_at(t);
            /* A D1/D2 pair that straddles a phase change (D1 before it, D2
             * after) mixes two vectors; it must still be a sane pressure. */
            bool exact =
                s.temp_c100 == kBaro[p].temp && s.pressure_pa == kBaro[p].p;
            bool boundary = phase_at(t + 2U * SENSORS_BARO_STEP_US) != p &&
                            s.pressure_pa >= 70000 && s.pressure_pa <= 110000;
            EXPECT(exact || boundary,
                   "baro at t=%u us: %d.%02d C %d Pa, expected %d Pa", t,
                   s.temp_c100 / 100, abs(s.temp_c100 % 100), s.pressure_pa,
                   kBaro[p].p);
        } else {
            continue;
        }
        n++;
    }
    note("%u samples match the flight profile exactly", n);
}

static void check_timestamps(void) {
    nominal();
    for (int i = 0; i < 3; ++i)
        EXPECT(W.backwards[i] == 0, "type 0x%02X went backwards %u times",
               REC_IMU + i, W.backwards[i]);
    /* IMU and high-g carry the data-ready edge time: on the period grid. */
    for (unsigned i = 0; i < W.n_produced; ++i) {
        const rec_t* r = &W.produced[i];
        uint32_t t;
        memcpy(&t, r->data, 4);
        if (r->type == REC_IMU)
            EXPECT(t % SENSORS_IMU_PERIOD_US == 0,
                   "IMU stamped %u us, not its edge", t);
        if (r->type == REC_HIGHG)
            EXPECT(t % SENSORS_HIGHG_PERIOD_US == 0,
                   "high-g stamped %u us, not its edge", t);
    }
    note("monotonic per sensor; IMU/high-g stamped at their data-ready edges");
}

static void check_conservation(void) {
    nominal();
    EXPECT(W.refused == 0, "%u records refused by the log", W.refused);
    EXPECT(W.log.stats.dropped == 0, "log dropped %u", W.log.stats.dropped);
    unsigned j = 0, matched = 0;
    for (unsigned i = 0; i < IMG.n; ++i) {
        const rec_t* got = &IMG.recs[i];
        if (got->type < EMMC_REC_USER_FIRST)
            continue; /* log's own */
        EXPECT(j < W.n_produced, "card has more records than were produced");
        const rec_t* want = &W.produced[j++];
        EXPECT(got->type == want->type && got->len == want->len &&
                   got->t_ms == want->t_ms &&
                   memcmp(got->data, want->data, want->len) == 0,
               "record %u on the card differs from what was produced", j);
        matched++;
    }
    EXPECT(matched == W.n_produced, "%u produced, %u on the card", W.n_produced,
           matched);
    note("all %u records on the card, byte for byte, in order", matched);
}

static void check_emmc_roundtrip(void) {
    nominal();
    EXPECT(IMG.super_ok, "superblock missing or CRC bad");
    EXPECT(IMG.bad_blocks == 0, "a log block failed its CRC");
    EXPECT(IMG.sessions == 1, "%u sessions, expected 1", IMG.sessions);
    unsigned starts = 0, ends = 0, states = 0;
    for (unsigned i = 0; i < IMG.n; ++i) {
        starts += IMG.recs[i].type == EMMC_REC_SESSION_START;
        ends += IMG.recs[i].type == EMMC_REC_SESSION_END;
        states += IMG.recs[i].type == EMMC_REC_STATE;
    }
    EXPECT(starts == 1 && ends == 1, "session start %u / end %u", starts, ends);
    EXPECT(states == 2, "%u STATE records, expected 2 (launch, recovery)",
           states);
    EXPECT(W.log.disk == EMMC_DISK_MOUNTED, "disk state %d", W.log.disk);
    note("%u blocks, superblock + every block CRC-valid, 1 session",
         IMG.blocks);
}

static void check_emmc_stall(void) {
    static world_t w;
    faults_t f = {0, 0, 3000, 3500}; /* card times out for 0.5 s in boost */
    world_init(&w, &f);
    fly(&w);
    EXPECT(w.card.failed_writes > 0, "the stall never hit a write");
    EXPECT(w.log.stats.write_errors > 0, "log did not report the failures");
    /* The sensors never waited on the card. */
    EXPECT(w.n_type[0] > 833 * 20 * 99 / 100, "IMU fell to %u samples",
           w.n_type[0]);
    static image_t img;
    read_image(&w.card, &img, MAX_RECS);
    EXPECT(img.super_ok && img.bad_blocks == 0, "card image damaged");
    /* Every record in a chunk sealed before the stall is on the card. The
     * chunk still open when the card stalled is not covered: the log latches
     * FAULT and drops it (the eMMC log's owner is changing that to retry);
     * its loss is reported in the detail. */
    uint32_t cut = w.sealed_before_stall_ms;
    EXPECT(w.stall_seen && cut >= 2000U,
           "no sealed history before the stall (cut %u ms)", cut);
    unsigned before = 0, on_card = 0, open_lost = 0;
    for (unsigned i = 0; i < w.n_produced; ++i)
        before += w.produced[i].t_ms < cut;
    for (unsigned i = 0; i < img.n; ++i)
        on_card +=
            img.recs[i].type >= EMMC_REC_USER_FIRST && img.recs[i].t_ms < cut;
    EXPECT(on_card == before, "%u of %u sealed pre-stall records on the card",
           on_card, before);
    for (unsigned i = 0; i < w.n_produced; ++i) {
        uint32_t t = w.produced[i].t_ms;
        if (t < cut || t >= f.card_fail_from_ms)
            continue;
        bool found = false;
        for (unsigned j = 0; j < img.n && !found; ++j)
            found =
                img.recs[j].t_ms == t && img.recs[j].type == w.produced[i].type;
        open_lost += !found;
    }
    note(
        "%u writes timed out; sensors kept full rate; sealed data (< %u ms) "
        "intact; open chunk lost %u records; disk %s, %u dropped, %u chunks "
        "lost",
        w.card.failed_writes, cut, open_lost,
        w.log.disk == EMMC_DISK_FAULT ? "FAULT" : "mounted",
        w.log.stats.dropped, w.log.stats.chunks_lost);
    free(img.recs);
    world_free(&w);
}

static void check_fault_imu_silent(void) {
    static world_t w;
    faults_t f = {5000000, 5500000, 0, 0}; /* IMU bus dead for 0.5 s */
    world_init(&w, &f);
    fly(&w);
    EXPECT(w.core.imu.ok, "IMU never recovered");
    EXPECT(w.core.imu.inits == 2, "IMU init attempts %u, expected 2",
           w.core.imu.inits);
    /* Longest IMU gap: the outage plus at most one retry interval. */
    uint32_t prev = 0, gap = 0;
    for (unsigned i = 0; i < w.n_produced; ++i) {
        if (w.produced[i].type != REC_IMU)
            continue;
        uint32_t t;
        memcpy(&t, w.produced[i].data, 4);
        if (prev && t - prev > gap)
            gap = t - prev;
        prev = t;
    }
    EXPECT(gap <= 500000U + SENSORS_RETRY_US + 2 * SENSORS_IMU_PERIOD_US,
           "IMU gap %u us", gap);
    EXPECT(w.n_type[1] == 400 * 20, "high-g disturbed: %u samples",
           w.n_type[1]);
    EXPECT(w.n_type[2] >= 49 * 20, "baro disturbed: %u", w.n_type[2]);
    note("IMU gap %.2f s, recovered after %u inits; high-g and baro unaffected",
         gap / 1e6, w.core.imu.inits);
    world_free(&w);
}

static void check_gps(void) {
    static world_t w;
    world_init(&w, NULL);
    fly(&w);
    EXPECT(w.gnss.state == GNSS_RUN, "GNSS never configured (state %d)",
           w.gnss.state);
    EXPECT(w.gnss.detected_baud == 9600 && w.gps.module_baud == 115200,
           "baud: found %u, module at %u", w.gnss.detected_baud,
           w.gps.module_baud);
    EXPECT(w.gps.dynmodel == UBX_DYNMODEL_AIR4 && w.gps.rate_ms == 100 &&
               !w.gps.nmea_on,
           "module config: model %u rate %u ms NMEA %d", w.gps.dynmodel,
           w.gps.rate_ms, w.gps.nmea_on);
    EXPECT(w.n_gnss >= 180 && w.n_gnss <= 200, "%u fixes in 20 s", w.n_gnss);
    unsigned checked = 0;
    for (unsigned i = 0; i < w.n_produced; ++i) {
        if (w.produced[i].type != REC_GNSS)
            continue;
        rec_gnss_t g;
        memcpy(&g, w.produced[i].data, sizeof(g));
        ubx_pvt_t v; /* the module built this fix at the ms it was sent */
        memset(&v, 0, sizeof(v));
        gps_truth(g.t_us, &v);
        EXPECT(g.lat_e7 == v.lat_e7 && g.lon_e7 == v.lon_e7 &&
                   g.hmsl_mm == v.hmsl_mm && g.vel_d_mms == v.vel_d_mms &&
                   g.itow_ms == v.itow_ms && g.pdop_e2 == v.pdop_e2,
               "fix at t=%u us differs from the GPS truth", g.t_us);
        EXPECT(g.fix_type == 3 && g.num_sv == 10, "fix type/SVs wrong");
        EXPECT(g.t_us < 1000000U ||
                   (g.pps_us > 0 && g.t_us - g.pps_us < 1000000U),
               "fix at %u us has a stale PPS %u", g.t_us, g.pps_us);
        checked++;
    }
    note(
        "cold 9600 -> 115200 -> 10 Hz NAV-PVT; %u fixes = truth, "
        "PPS-stamped",
        checked);
    world_free(&w);
}

typedef struct {
    const char* id;
    const char* what;
    void (*run)(void);
} check_t;

static const check_t checks[] = {
    {"sensor_rates",
     "IMU 833 Hz, high-g 400 Hz, baro ~50 Hz over a 20 s flight",
     check_sensor_rates},
    {"sample_values", "every sample equals the flight profile (raw, exact)",
     check_sample_values},
    {"timestamps", "monotonic; IMU/high-g stamped at the data-ready edge",
     check_timestamps},
    {"conservation", "every produced record is on the eMMC card, byte for byte",
     check_conservation},
    {"emmc_roundtrip",
     "card image: superblock, block CRCs, one session, states",
     check_emmc_roundtrip},
    {"emmc_stall",
     "card times out 0.5 s: sensors unaffected, sealed data intact",
     check_emmc_stall},
    {"gps", "GNSS cold start 9600 -> 115200, 10 Hz fixes = truth, PPS-stamped",
     check_gps},
    {"fault_imu_silent",
     "IMU dead 0.5 s: dropped, retried, recovered; others ok",
     check_fault_imu_silent},
};

int main(int argc, char** argv) {
    const char* only = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--list") == 0) {
            for (size_t c = 0; c < sizeof(checks) / sizeof(checks[0]); ++c)
                printf("%s\t%s\n", checks[c].id, checks[c].what);
            return 0;
        }
        if (strncmp(argv[i], "--only=", 7) == 0)
            only = argv[i] + 7;
    }
    int failed = 0;
    for (size_t c = 0; c < sizeof(checks) / sizeof(checks[0]); ++c) {
        if (only) {
            const char* hit = strstr(only, checks[c].id);
            size_t len = strlen(checks[c].id);
            if (!hit || (hit[len] != '\0' && hit[len] != ','))
                continue;
        }
        ok = true;
        detail[0] = '\0';
        checks[c].run();
        printf("CHECK %s %s %s | %s\n", checks[c].id, ok ? "PASS" : "FAIL",
               checks[c].what, detail);
        fflush(stdout);
        failed += !ok;
    }
    return failed ? 1 : 0;
}
