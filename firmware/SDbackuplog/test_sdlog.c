/*
 * Host tests for the SD NAND backup log: dev_sdnand against a byte-level fake
 * card (its own CRC16 and CSD encoding), sdlog_core against a RAM disk with
 * its own decoder, then both together. argv[1], if given, receives the
 * end-to-end card image for test_sdlog_read.py. Run: ./run_tests.sh
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dev_sdnand.h"
#include "emmc_log.h"
#include "records.h"
#include "sdlog_core.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

#define BS 512U
#define CARD_BLOCKS 1024U
#define STUCK UINT32_MAX

static uint32_t le32(const uint8_t* p) {
    return p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
           (uint32_t)p[3] << 24;
}

/* fake SD card, SPI mode */

typedef struct {
    uint8_t mem[CARD_BLOCKS * BS];
    uint8_t csd[16];
    bool sdhc, held, blocklen_set, multi, bad_read_crc, reject_write;
    uint8_t q[600], in[520], status_r2;
    int qn, qi, inn;
    enum { CMD, TOKEN, DATA } mode;
    uint32_t blk, busy, ms, stops;
} card_t;

/* Byte-wise CRC-CCITT, a different algorithm from the driver's. */
static uint16_t ref_crc16(const uint8_t* p, int n) {
    uint16_t c = 0;
    while (n--) {
        c = (uint16_t)((c >> 8) | (c << 8));
        c ^= *p++;
        c ^= (uint8_t)(c & 0xFFU) >> 4;
        c ^= (uint16_t)(c << 12);
        c ^= (uint16_t)((c & 0xFFU) << 5);
    }
    return c;
}

static void push(card_t* c, uint8_t b) {
    CHECK(c->qn < (int)sizeof c->q);
    c->q[c->qn++] = b;
}

static void push_data(card_t* c, const uint8_t* p, int n, bool corrupt) {
    push(c, 0xFF); /* access time */
    push(c, SD_DATA_TOKEN);
    for (int i = 0; i < n; i++) {
        push(c, p[i]);
    }
    uint16_t crc = (uint16_t)(ref_crc16(p, n) ^ corrupt);
    push(c, (uint8_t)(crc >> 8));
    push(c, (uint8_t)crc);
}

static uint8_t pop(card_t* c) {
    if (c->qi < c->qn) {
        return c->q[c->qi++];
    }
    c->qi = c->qn = 0;
    if (c->busy) {
        c->busy -= c->busy != STUCK;
        return 0x00;
    }
    return 0xFF;
}

static void exec(card_t* c) {
    uint8_t idx = c->in[0] & 0x3FU;
    uint32_t arg = (uint32_t)c->in[1] << 24 | (uint32_t)c->in[2] << 16 |
                   (uint32_t)c->in[3] << 8 | c->in[4];
    CHECK(c->in[5] == (uint8_t)((sd_crc7(c->in, 5) << 1) | 1U));
    uint32_t blk = c->sdhc ? arg : arg / BS;
    push(c, 0xFF); /* NCR */
    if (idx == 17 || idx == 24 || idx == 25) {
        CHECK(c->sdhc || c->blocklen_set);
        if ((!c->sdhc && arg % BS) || blk >= CARD_BLOCKS) {
            push(c, 0x40); /* parameter error */
            return;
        }
    }
    switch (idx) {
        case SD_CMD9_SEND_CSD:
            push(c, 0);
            push_data(c, c->csd, 16, false);
            break;
        case SD_CMD13_SEND_STATUS:
            push(c, 0);
            push(c, c->status_r2);
            break;
        case SD_CMD16_SET_BLOCKLEN:
            c->blocklen_set = arg == BS;
            push(c, c->blocklen_set ? 0 : 0x40);
            break;
        case SD_CMD17_READ_SINGLE_BLOCK:
            push(c, 0);
            push_data(c, c->mem + blk * BS, BS, c->bad_read_crc);
            break;
        case SD_CMD24_WRITE_BLOCK:
        case SD_CMD25_WRITE_MULTIPLE_BLOCK:
            push(c, 0);
            c->mode = TOKEN;
            c->multi = idx == SD_CMD25_WRITE_MULTIPLE_BLOCK;
            c->blk = blk;
            break;
        default:
            push(c, SD_R1_ILLEGAL_COMMAND);
    }
}

static void feed(card_t* c, uint8_t b) {
    if (c->mode == CMD) {
        if (c->inn > 0 || (b & 0xC0U) == 0x40U) {
            c->in[c->inn++] = b;
            if (c->inn == 6) {
                c->inn = 0;
                exec(c);
            }
        }
    } else if (c->mode == TOKEN) {
        if (c->multi && b == SD_TOKEN_STOP_TRAN) {
            c->stops++;
            c->busy = c->busy == STUCK ? STUCK : 40;
            c->mode = CMD;
        } else if (b != 0xFF) {
            CHECK(b == (c->multi ? SD_TOKEN_START_MULTI : SD_DATA_TOKEN));
            c->mode = DATA;
        }
    } else {
        c->in[c->inn++] = b;
        if (c->inn == (int)BS + 2) {
            c->inn = 0;
            bool ok = !c->reject_write &&
                      ((c->in[BS] << 8) | c->in[BS + 1]) == ref_crc16(c->in, BS);
            push(c, ok ? 0xE5 : 0xEB); /* accepted / CRC error */
            if (ok) {
                CHECK(c->blk < CARD_BLOCKS);
                memcpy(c->mem + c->blk++ * BS, c->in, BS);
                c->busy = c->busy == STUCK ? STUCK : 40; /* > one poll */
            }
            c->mode = c->multi ? TOKEN : CMD;
        }
    }
}

static int f_xfer(void* ctx, const uint8_t* tx, uint8_t* rx, uint16_t len) {
    card_t* c = ctx;
    CHECK(c->held); /* every byte inside hold()/release() */
    for (uint16_t i = 0; i < len; i++) {
        uint8_t out = pop(c);
        feed(c, tx ? tx[i] : 0xFF);
        if (rx) {
            rx[i] = out;
        }
    }
    return DEV_OK;
}

static void f_delay(void* ctx, uint32_t ms) {
    ((card_t*)ctx)->ms += ms;
}

static int f_hold(void* ctx) {
    card_t* c = ctx;
    CHECK(!c->held);
    c->held = true;
    return DEV_OK;
}

static void f_release(void* ctx) {
    card_t* c = ctx;
    CHECK(c->held);
    c->held = false;
    c->qn = c->qi = c->inn = 0;
    c->mode = CMD;
}

/* 1024 blocks: SDHC C_SIZE 0, or SDSC READ_BL_LEN 9, C_SIZE 255, MULT 0. */
static card_t* card_new(bool sdhc) {
    card_t* c = calloc(1, sizeof *c);
    CHECK(c != NULL);
    c->sdhc = sdhc;
    c->csd[0] = sdhc ? 0x40 : 0x00;
    if (!sdhc) {
        c->csd[5] = 9;
        c->csd[7] = 63;
        c->csd[8] = 0xC0;
    }
    return c;
}

static sdnand_bus_t bus_of(card_t* c) {
    sdnand_bus_t b = {{f_xfer, f_delay, c}, f_hold, f_release};
    return b;
}

/* driver */

static void test_driver(bool sdhc) {
    card_t* c = card_new(sdhc);
    sdnand_bus_t bus = bus_of(c);
    sdnand_card_t card = {0};
    static uint8_t buf[6 * BS], back[BS];
    for (unsigned i = 0; i < sizeof buf; i++) {
        buf[i] = (uint8_t)(i * 7U + 3U);
    }
    CHECK(sdnand_read_block(&bus, &card, 0, back) == DEV_ERR_PARAM);
    CHECK(sdnand_prepare(&bus, &card) == DEV_OK);
    CHECK(card.ready && card.high_capacity == sdhc);
    CHECK(card.block_count == CARD_BLOCKS && c->blocklen_set == !sdhc);

    CHECK(sdnand_write_blocks(&bus, &card, 10, buf, 1) == DEV_OK);
    CHECK(sdnand_write_blocks(&bus, &card, 20, buf + BS, 5) == DEV_OK);
    CHECK(c->stops == 1 && c->ms > 0); /* CMD25 stopped; busy waited out */
    CHECK(memcmp(c->mem + 10 * BS, buf, BS) == 0);
    CHECK(memcmp(c->mem + 20 * BS, buf + BS, 5 * BS) == 0);
    CHECK(sdnand_read_block(&bus, &card, 22, back) == DEV_OK);
    CHECK(memcmp(back, buf + 3 * BS, BS) == 0);

    CHECK(sdnand_read_block(&bus, &card, CARD_BLOCKS, back) == DEV_ERR_PARAM);
    CHECK(sdnand_write_blocks(&bus, &card, CARD_BLOCKS - 2, buf, 3) ==
          DEV_ERR_PARAM);
    CHECK(sdnand_write_blocks(&bus, &card, 0, buf, 0) == DEV_ERR_PARAM);

    c->bad_read_crc = true;
    CHECK(sdnand_read_block(&bus, &card, 22, back) == DEV_ERR_DATA);
    c->bad_read_crc = false;

    c->reject_write = true;
    CHECK(sdnand_write_blocks(&bus, &card, 30, buf, 3) == DEV_ERR_DATA);
    CHECK(c->stops == 2); /* stop token sent after the rejected block */
    c->reject_write = false;

    c->status_r2 = 0x04; /* CMD13: card ECC failed */
    CHECK(sdnand_write_blocks(&bus, &card, 30, buf, 1) == DEV_ERR_DATA);
    CHECK(card.last_status == 0x0004);
    c->status_r2 = 0;

    c->busy = STUCK;
    uint32_t t0 = c->ms;
    CHECK(sdnand_write_blocks(&bus, &card, 30, buf, 1) == DEV_ERR_TIMEOUT);
    CHECK(c->ms - t0 >= SD_WRITE_TIMEOUT_MS && !c->held);
    free(c);
}

static void test_csd(void) {
    uint8_t v[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
    CHECK(ref_crc16(v, 9) == 0x31C3); /* the fake's CRC is the XMODEM one */

    card_t* c = card_new(false);
    sdnand_bus_t bus = bus_of(c);
    sdnand_card_t card = {0};
    /* 1 Gbit SDSC: C_SIZE 511, MULT 7, READ_BL_LEN 9 -> 262144 blocks */
    c->csd[7] = 0x7F;
    c->csd[8] = 0xC0;
    c->csd[9] = 0x03;
    c->csd[10] = 0x80;
    CHECK(sdnand_prepare(&bus, &card) == DEV_OK && card.block_count == 262144U);
    c->csd[5] = 10; /* READ_BL_LEN 1024 B: twice the 512 B blocks */
    CHECK(sdnand_prepare(&bus, &card) == DEV_OK && card.block_count == 524288U);
    c->csd[0] = 0xC0; /* reserved CSD structure */
    CHECK(sdnand_prepare(&bus, &card) == DEV_ERR_DATA && !card.ready);
    free(c);
}

/*  RAM disk  */

typedef struct {
    uint8_t* mem;
    uint32_t cap, torn_mask;
    int lock_depth, fail_writes;
    bool fail_start, torn, powered_off;
} disk_t;

static void disk_new(disk_t* d, uint32_t cap) {
    memset(d, 0, sizeof *d);
    d->cap = cap;
    d->mem = calloc(cap, BS);
    CHECK(d->mem != NULL);
}

static emmc_status_t d_start(void* ctx, uint32_t* n) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 0);
    *n = d->cap;
    return d->fail_start ? EMMC_ERR_TIMEOUT : EMMC_OK;
}

static emmc_status_t d_read(void* ctx, uint32_t lba, void* buf, uint32_t n,
                            uint32_t budget) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 0 && budget > 0 && lba + n <= d->cap);
    if (d->powered_off) {
        return EMMC_ERR_IO;
    }
    memcpy(buf, d->mem + lba * BS, n * BS);
    return EMMC_OK;
}

static emmc_status_t d_write(void* ctx, uint32_t lba, const void* buf,
                             uint32_t n, uint32_t budget) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 0 && budget > 0 && lba + n <= d->cap);
    CHECK(n >= 1 && n <= SDLOG_MAX_BURST);
    if (d->powered_off) {
        return EMMC_ERR_IO;
    }
    if (d->fail_writes > 0) {
        d->fail_writes--;
        return EMMC_ERR_IO;
    }
    for (uint32_t i = 0; i < n; i++) {
        if (!d->torn || n == 1 || (d->torn_mask >> i & 1U)) {
            memcpy(d->mem + (lba + i) * BS, (const uint8_t*)buf + i * BS, BS);
        }
    }
    d->powered_off = d->torn && n > 1; /* a torn burst is the power cut */
    return d->powered_off ? EMMC_ERR_IO : EMMC_OK;
}

static void d_lock(void* ctx) {
    ((disk_t*)ctx)->lock_depth++;
}

static void d_unlock(void* ctx) {
    CHECK(--((disk_t*)ctx)->lock_depth == 0);
}

static const emmc_port_t ram_port = {d_start, d_read, d_write, d_lock,
                                     d_unlock};

typedef struct {
    uint32_t session, block, t;
    uint8_t type, len;
    const uint8_t* data;
} rec_t;

/* Walks the layout in sdlog_core.h with no help from sdlog_core. */
static int decode(const uint8_t* mem, uint32_t cap, rec_t* out, int max) {
    uint32_t epoch = le32(mem + 8);
    int n = 0;
    for (uint32_t k = 0; SDLOG_DATA_START + k < cap; k++) {
        const uint8_t* b = mem + (SDLOG_DATA_START + k) * BS;
        if (le32(b) != SDLOG_BLOCK_MAGIC || le32(b + 4) != epoch ||
            le32(b + 8) != k || le32(b + 508) != emmc_log_crc32(b, 508)) {
            break;
        }
        unsigned used = b[18] | b[19] << 8;
        for (unsigned o = 0; o + 6 <= used; o += 6U + b[21 + o]) {
            CHECK(n < max);
            rec_t r = {le32(b + 12), k, le32(b + 22 + o), b[20 + o], b[21 + o],
                       b + 26 + o};
            out[n++] = r;
        }
    }
    return n;
}

static void arm(sdlog_t* log, uint32_t t) {
    CHECK(sdlog_on_state(log, FLIGHT_IDLE, FLIGHT_ARMED, t));
}

static void disarm(sdlog_t* log, uint32_t t) {
    CHECK(sdlog_on_state(log, FLIGHT_ARMED, FLIGHT_IDLE, t));
}

static void drain(sdlog_t* log) {
    for (int i = 0; i < 100 && sdlog_backlog(log); i++) {
        (void)sdlog_service(log, 0);
    }
    CHECK(sdlog_backlog(log) == 0);
}

static sdlog_t* log_new(disk_t* d) {
    static sdlog_t log;
    CHECK(sdlog_init(&log, &ram_port, d));
    return &log;
}

static rec_t recs[400];
static rec_gnss_t gnss;
static rec_baro_t baro;

/* log core */

static void test_sessions(void) {
    disk_t d;
    disk_new(&d, 4096);
    sdlog_t* log = log_new(&d);
    rec_imu_t imu = {0};
    CHECK(!sdlog_append(log, REC_BARO, 0, &baro, sizeof baro)); /* Idle */
    arm(log, 5);
    CHECK(!sdlog_append(log, REC_IMU, 6, &imu, sizeof imu)); /* not backed up */
    for (uint32_t i = 0; i < 100; i++) {
        CHECK(sdlog_append(log, REC_BARO, 10 + i, &baro, sizeof baro));
        (void)sdlog_service(log, i);
    }
    CHECK(sdlog_on_state(log, FLIGHT_ARMED, FLIGHT_LAUNCHED, 200));
    CHECK(sdlog_on_state(log, FLIGHT_LAUNCHED, FLIGHT_IDLE, 300));
    drain(log);

    int n = decode(d.mem, d.cap, recs, 400);
    CHECK(n == 103 && log->stats.records == 103 && log->stats.dropped == 0);
    CHECK(recs[0].type == EMMC_REC_SESSION_START && recs[0].t == 5 &&
          recs[0].data[0] == FLIGHT_ARMED);
    for (int i = 1; i <= 100; i++) {
        CHECK(recs[i].type == REC_BARO && recs[i].t == 9U + i &&
              recs[i].len == sizeof baro);
    }
    CHECK(recs[101].type == EMMC_REC_STATE && recs[101].data[1] == FLIGHT_LAUNCHED);
    CHECK(recs[102].type == EMMC_REC_SESSION_END && recs[102].t == 300);
    for (int i = 0; i < n; i++) {
        CHECK(recs[i].session == 1);
    }

    /* Power cycle: the next session continues the numbering and the log. */
    uint32_t epoch = le32(d.mem + 8), end = log->head - SDLOG_DATA_START;
    log = log_new(&d);
    arm(log, 0);
    CHECK(sdlog_append(log, REC_GNSS, 1, &gnss, sizeof gnss));
    disarm(log, 2);
    drain(log);
    n = decode(d.mem, d.cap, recs, 400);
    CHECK(n == 106 && le32(d.mem + 8) == epoch);
    CHECK(recs[103].session == 2 && recs[103].block == end &&
          recs[104].type == REC_GNSS);

    /* A bad superblock: new epoch, the old blocks no longer count. */
    d.mem[100] ^= 1U;
    log = log_new(&d);
    arm(log, 0);
    disarm(log, 1);
    drain(log);
    CHECK(le32(d.mem + 8) == epoch + 1U);
    CHECK(decode(d.mem, d.cap, recs, 400) == 2 && recs[0].session == 1);
    free(d.mem);
}

static void test_flush_and_drops(void) {
    disk_t d;
    disk_new(&d, 4096);
    sdlog_t* log = log_new(&d);
    arm(log, 0);
    (void)sdlog_service(log, 100); /* sees the filling block */
    (void)sdlog_service(log, 1099);
    CHECK(log->stats.blocks_written == 0);
    (void)sdlog_service(log, 1100); /* SDLOG_FLUSH_MS old: written */
    CHECK(log->stats.blocks_written == 1 && log->disk == SDLOG_MOUNTED);

    uint32_t accepted = 0;
    while (sdlog_append(log, REC_GNSS, accepted, &gnss, sizeof gnss)) {
        accepted++;
    }
    CHECK(accepted == SDLOG_RAM_BLOCKS * 8U); /* 8 GNSS records per block */
    for (int i = 0; i < 4; i++) {
        CHECK(!sdlog_append(log, REC_GNSS, 2, &gnss, sizeof gnss));
    }
    CHECK(log->stats.dropped == 5);
    drain(log);
    CHECK(sdlog_append(log, REC_GNSS, 3, &gnss, sizeof gnss));
    disarm(log, 4);
    drain(log);
    int n = decode(d.mem, d.cap, recs, 400);
    CHECK(n == 1 + (int)accepted + 3); /* every block, in order */
    for (uint32_t i = 0; i < accepted; i++) {
        CHECK(recs[1 + i].type == REC_GNSS && recs[1 + i].t == i);
    }
    CHECK(recs[n - 3].type == EMMC_REC_DROPPED && le32(recs[n - 3].data) == 5);
    CHECK(recs[n - 2].type == REC_GNSS && recs[n - 2].t == 3);
    free(d.mem);
}

static void test_faults(void) {
    disk_t d;
    disk_new(&d, 4096);
    sdlog_t* log = log_new(&d);
    d.fail_start = true;
    arm(log, 0);
    disarm(log, 1);
    CHECK(sdlog_service(log, 0) == EMMC_ERR_TIMEOUT);
    CHECK(log->disk == SDLOG_FAULT && log->stats.blocks_lost == 1);
    CHECK(!sdlog_on_state(log, FLIGHT_IDLE, FLIGHT_ARMED, 2));
    CHECK(!sdlog_append(log, REC_GNSS, 3, &gnss, sizeof gnss));

    d.fail_start = false;
    log = log_new(&d);
    arm(log, 0);
    disarm(log, 1);
    drain(log); /* mounted */
    d.fail_writes = SDLOG_WRITE_ATTEMPTS - 1; /* retried, then lands */
    arm(log, 2);
    disarm(log, 3);
    drain(log);
    CHECK(log->stats.write_errors == SDLOG_WRITE_ATTEMPTS - 1);
    CHECK(log->disk == SDLOG_MOUNTED && decode(d.mem, d.cap, recs, 400) == 4);
    d.fail_writes = SDLOG_WRITE_ATTEMPTS;
    arm(log, 4);
    disarm(log, 5);
    for (unsigned i = 0; i < SDLOG_WRITE_ATTEMPTS; i++) {
        CHECK(sdlog_service(log, 0) == EMMC_ERR_IO);
    }
    CHECK(log->disk == SDLOG_FAULT && sdlog_backlog(log) == 0);
    free(d.mem);

    /* Full: twelve log blocks, then recording stops. */
    disk_new(&d, SDLOG_DATA_START + 12U);
    log = log_new(&d);
    arm(log, 0);
    for (int i = 0; i < 200 && log->recording; i++) {
        (void)sdlog_append(log, REC_GNSS, (uint32_t)i, &gnss, sizeof gnss);
        (void)sdlog_service(log, 0);
    }
    CHECK(log->disk == SDLOG_FULL && log->stats.blocks_written == 12);
    CHECK(log->stats.blocks_lost > 0 && sdlog_backlog(log) == 0);
    free(d.mem);
}

static void test_torn_burst(void) {
    disk_t d;
    disk_new(&d, 4096);
    sdlog_t* log = log_new(&d);
    arm(log, 0);
    for (int i = 0; i < 65; i++) { /* 8 full blocks, a ninth filling */
        CHECK(sdlog_append(log, REC_GNSS, (uint32_t)i, &gnss, sizeof gnss));
    }
    CHECK(sdlog_backlog(log) == 8);
    d.torn = true;
    d.torn_mask = 0x67U; /* 3, 4 and 7 never land; the search stops at 3 */
    CHECK(sdlog_service(log, 0) == EMMC_ERR_IO);

    d.torn = d.powered_off = false;
    log = log_new(&d);
    arm(log, 0);
    disarm(log, 1);
    drain(log);
    for (uint32_t k = 5; k < 7; k++) { /* kept, not overwritten */
        const uint8_t* b = d.mem + (SDLOG_DATA_START + k) * BS;
        CHECK(le32(b + 8) == k && le32(b + 12) == 1);
    }
    const uint8_t* b = d.mem + (SDLOG_DATA_START + 7U) * BS;
    CHECK(le32(b + 8) == 7 && le32(b + 12) == 2);
    free(d.mem);
}

/* end to end: log -> driver -> fake card */

typedef struct {
    sdnand_bus_t bus;
    sdnand_card_t card;
} e2e_t;

static emmc_status_t st_of(int st) {
    return st == DEV_OK ? EMMC_OK : EMMC_ERR_IO;
}

static emmc_status_t e_start(void* ctx, uint32_t* n) {
    e2e_t* e = ctx;
    int st = sdnand_prepare(&e->bus, &e->card);
    *n = e->card.block_count;
    return st_of(st);
}

static emmc_status_t e_read(void* ctx, uint32_t lba, void* buf, uint32_t n,
                            uint32_t budget) {
    e2e_t* e = ctx;
    (void)budget;
    int st = DEV_OK;
    for (uint32_t i = 0; st == DEV_OK && i < n; i++) {
        st = sdnand_read_block(&e->bus, &e->card, lba + i,
                               (uint8_t*)buf + i * BS);
    }
    return st_of(st);
}

static emmc_status_t e_write(void* ctx, uint32_t lba, const void* buf,
                             uint32_t n, uint32_t budget) {
    e2e_t* e = ctx;
    (void)budget;
    return st_of(sdnand_write_blocks(&e->bus, &e->card, lba, buf, n));
}

static void test_end_to_end(const char* image) {
    static const emmc_port_t port = {e_start, e_read, e_write, NULL, NULL};
    card_t* c = card_new(false);
    static sdlog_t log;
    for (int session = 1; session <= 2; session++) {
        e2e_t e = {bus_of(c), {0}};
        c->blocklen_set = false; /* power cycle */
        CHECK(sdlog_init(&log, &port, &e));
        arm(&log, 0);
        for (uint32_t i = 0; i < (session == 1 ? 60U : 10U); i++) {
            memset(&gnss, (int)i, sizeof gnss);
            CHECK(session == 1
                      ? sdlog_append(&log, REC_GNSS, i, &gnss, sizeof gnss)
                      : sdlog_append(&log, REC_BARO, 1000 + i, &baro,
                                     sizeof baro));
            (void)sdlog_service(&log, i);
        }
        disarm(&log, 2000);
        drain(&log);
        CHECK(log.disk == SDLOG_MOUNTED && log.stats.write_errors == 0);
    }
    int n = decode(c->mem, CARD_BLOCKS, recs, 400);
    CHECK(n == 62 + 12 && recs[62].session == 2);
    if (image) {
        FILE* f = fopen(image, "wb");
        CHECK(f && fwrite(c->mem, 1, sizeof c->mem, f) == sizeof c->mem);
        fclose(f);
    }
    free(c);
}

int main(int argc, char** argv) {
    test_csd();
    test_driver(false);
    test_driver(true);
    test_sessions();
    test_flush_and_drops();
    test_faults();
    test_torn_burst();
    test_end_to_end(argc > 1 ? argv[1] : NULL);
    puts("test_sdlog: all passed");
    return 0;
}
