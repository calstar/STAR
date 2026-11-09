/*
 * Host tests for the eMMC flight log, against a RAM disk.
 *
 * The decoder below re-reads the disk image with its own CRC and its own
 * reading of the layout in emmc_log.h, so a bug in the writer cannot hide by
 * being decoded by the same code.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "emmc_log.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

#define DATA_START 64U
#define CHUNKS 4U
#define BS EMMC_BLOCK_SIZE

/* ---- RAM disk -------------------------------------------------------- */

typedef struct {
    uint8_t* blocks;
    uint32_t capacity;
    unsigned starts, reads, writes;
    emmc_status_t start_result;
    int write_failures; /* the next N writes fail, nothing lands */
    bool torn_armed;    /* the next write lands only torn_mask blocks */
    uint32_t torn_mask; /* bit i = block i of that write lands */
    bool powered_off;   /* after a torn write, everything fails */
    int lock_depth;
    unsigned locks;
} disk_t;

static void disk_new(disk_t* d, uint32_t capacity) {
    memset(d, 0, sizeof *d);
    d->capacity = capacity;
    d->blocks = calloc(capacity, BS);
    CHECK(d->blocks != NULL);
}

/* Same contents, fresh power-up: counters and faults cleared. */
static void disk_power_cycle(disk_t* d) {
    uint8_t* b = d->blocks;
    uint32_t c = d->capacity;
    memset(d, 0, sizeof *d);
    d->blocks = b;
    d->capacity = c;
}

static emmc_status_t f_start(void* ctx, uint32_t* count) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 0);
    d->starts++;
    if (d->start_result != EMMC_OK) {
        return d->start_result;
    }
    *count = d->capacity;
    return EMMC_OK;
}

static emmc_status_t f_read(void* ctx, uint32_t lba, void* buf, uint32_t count,
                            uint32_t budget) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 0); /* never hold the queue lock across I/O */
    CHECK(budget > 0);
    CHECK(d->starts > 0);
    CHECK(lba < d->capacity && count <= d->capacity - lba);
    d->reads++;
    if (d->powered_off) {
        return EMMC_ERR_IO;
    }
    memcpy(buf, d->blocks + (size_t)lba * BS, (size_t)count * BS);
    return EMMC_OK;
}

static emmc_status_t f_write(void* ctx, uint32_t lba, const void* buf,
                             uint32_t count, uint32_t budget) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 0);
    CHECK(budget > 0);
    CHECK(d->starts > 0);
    CHECK(lba < d->capacity && count <= d->capacity - lba);
    d->writes++;
    if (d->powered_off) {
        return EMMC_ERR_IO;
    }
    if (d->write_failures > 0) {
        d->write_failures--;
        return EMMC_ERR_IO;
    }
    if (d->torn_armed) {
        for (uint32_t i = 0; i < count && i < 32; ++i) {
            if (d->torn_mask & (UINT32_C(1) << i)) {
                memcpy(d->blocks + (size_t)(lba + i) * BS,
                       (const uint8_t*)buf + (size_t)i * BS, BS);
            }
        }
        d->powered_off = true;
        return EMMC_ERR_IO;
    }
    memcpy(d->blocks + (size_t)lba * BS, buf, (size_t)count * BS);
    return EMMC_OK;
}

static void f_lock(void* ctx) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 0); /* not re-entrant on the board either */
    d->lock_depth++;
    d->locks++;
}

static void f_unlock(void* ctx) {
    disk_t* d = ctx;
    CHECK(d->lock_depth == 1);
    d->lock_depth--;
}

static const emmc_port_t port = {f_start, f_read, f_write, f_lock, f_unlock};

static emmc_log_chunk_t chunks[CHUNKS];
static uint8_t scratch[BS];

static emmc_log_config_t config(void) {
    emmc_log_config_t c = emmc_log_default_config();
    c.data_start_lba = DATA_START;
    return c;
}

static void log_new(emmc_log_t* log, disk_t* d) {
    emmc_log_config_t c = config();
    CHECK(emmc_log_init(log, &port, d, &c, chunks, CHUNKS, scratch) == EMMC_OK);
}

static void drain(emmc_log_t* log, uint32_t now) {
    for (int i = 0; i < 64 && emmc_log_backlog(log) > 0; ++i) {
        CHECK(emmc_log_service(log, now) == EMMC_OK);
    }
    CHECK(emmc_log_backlog(log) == 0);
}

/* ---- independent decoder ---------------------------------------------- */

static uint32_t ref_crc(const uint8_t* p, size_t n) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; ++i) {
        crc ^= p[i];
        for (int k = 0; k < 8; ++k) {
            crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
        }
    }
    return ~crc;
}

static uint32_t rd32(const uint8_t* p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
           (uint32_t)p[3] << 24;
}

typedef struct {
    uint8_t type, len;
    uint32_t t;
    uint32_t session;
    uint8_t data[255];
} rec_t;

typedef struct {
    uint32_t epoch;
    uint32_t blocks; /* valid blocks from DATA_START, contiguous */
    uint32_t pads;
    unsigned count;
    rec_t rec[2048];
} image_t;

static image_t img;

static void decode(const disk_t* d) {
    memset(&img, 0, sizeof img);
    const uint8_t* s = d->blocks;
    CHECK(rd32(s) == 0x31425353u && rd32(s + 508) == ref_crc(s, 508));
    CHECK(rd32(s + 4) == 1u && rd32(s + 12) == DATA_START &&
          rd32(s + 16) == d->capacity);
    img.epoch = rd32(s + 8);
    for (uint32_t k = 0; DATA_START + k < d->capacity; ++k) {
        const uint8_t* b = d->blocks + (size_t)(DATA_START + k) * BS;
        if (rd32(b) != 0x31474C53u || rd32(b + 4) != img.epoch ||
            rd32(b + 8) != k || rd32(b + 508) != ref_crc(b, 508)) {
            break;
        }
        img.blocks++;
        uint16_t used = (uint16_t)(b[18] | b[19] << 8);
        CHECK(used <= 488);
        if (b[16] == 2) {
            CHECK(used == 0);
            img.pads++;
            continue;
        }
        CHECK(b[16] == 1);
        for (uint16_t o = 0; o < used;) {
            const uint8_t* r = b + 20 + o;
            CHECK(img.count < 2048);
            rec_t* x = &img.rec[img.count++];
            x->type = r[0];
            x->len = r[1];
            x->t = rd32(r + 2);
            x->session = rd32(b + 12);
            memcpy(x->data, r + 6, x->len);
            o = (uint16_t)(o + 6 + x->len);
            CHECK(o <= used);
        }
    }
}

/* ---- tests ------------------------------------------------------------- */

static void test_crc(void) {
    CHECK(emmc_log_crc32("123456789", 9) == 0xCBF43926u);
    uint8_t b[512];
    for (int i = 0; i < 512; ++i) {
        b[i] = (uint8_t)(i * 7 + 3);
    }
    CHECK(emmc_log_crc32(b, 512) == ref_crc(b, 512));
}

/* The eMMC is untouched until ARMED: no start, no read, no write. */
static void test_no_io_before_arm(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 8);
    log_new(&log, &d);
    uint8_t x = 1;
    CHECK(!emmc_log_append(&log, 0x10, 0, &x, 1));
    CHECK(emmc_log_on_state(&log, FLIGHT_SELF_TEST, FLIGHT_IDLE, 0));
    CHECK(!emmc_log_append(&log, 0x10, 0, &x, 1));
    for (uint32_t t = 0; t < 10000; t += 100) {
        CHECK(emmc_log_service(&log, t) == EMMC_OK);
    }
    CHECK(d.starts == 0 && d.reads == 0 && d.writes == 0);
    CHECK(log.disk == EMMC_DISK_UNMOUNTED);
    free(d.blocks);
}

static void fill_payload(uint8_t* p, unsigned i) {
    for (unsigned j = 0; j < 32; ++j) {
        p[j] = (uint8_t)(i + j);
    }
}

static void test_session_roundtrip(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 5));
    for (unsigned i = 0; i < 100; ++i) {
        uint8_t p[32];
        fill_payload(p, i);
        CHECK(emmc_log_append(&log, 0x10, 10 + i, p, 32));
    }
    CHECK(emmc_log_on_state(&log, FLIGHT_ARMED, FLIGHT_IDLE, 200));
    drain(&log, 300);
    CHECK(d.starts == 1);
    CHECK(d.lock_depth == 0 && d.locks > 0);

    decode(&d);
    CHECK(img.epoch == 1);
    CHECK(img.blocks == 32 * log.stats.chunks_written);
    CHECK(img.count == 102);
    CHECK(img.rec[0].type == EMMC_REC_SESSION_START &&
          img.rec[0].data[0] == FLIGHT_ARMED && img.rec[0].t == 5);
    for (unsigned i = 0; i < 100; ++i) {
        uint8_t p[32];
        fill_payload(p, i);
        const rec_t* r = &img.rec[1 + i];
        CHECK(r->type == 0x10 && r->len == 32 && r->t == 10 + i);
        CHECK(memcmp(r->data, p, 32) == 0 && r->session == 1);
    }
    CHECK(img.rec[101].type == EMMC_REC_SESSION_END &&
          img.rec[101].data[0] == FLIGHT_IDLE);
    CHECK(log.stats.dropped == 0 && log.stats.records == 102);
    /* Nothing written past the log's own end. */
    for (size_t i = (size_t)(DATA_START + img.blocks) * BS;
         i < (size_t)d.capacity * BS; ++i) {
        CHECK(d.blocks[i] == 0);
    }
    free(d.blocks);
}

/* Re-arming in one power-up opens session 2 without re-initialising the
 * card; a power cycle mounts, finds the end and opens session 3 after it. */
static void test_sessions_and_remount(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    uint8_t x = 7;
    for (int s = 0; s < 2; ++s) {
        CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
        CHECK(emmc_log_append(&log, 0x11, 1, &x, 1));
        CHECK(emmc_log_on_state(&log, FLIGHT_ARMED, FLIGHT_IDLE, 2));
        drain(&log, 3);
    }
    CHECK(d.starts == 1);
    uint32_t end = log.head;

    disk_power_cycle(&d);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    CHECK(emmc_log_append(&log, 0x11, 1, &x, 1));
    emmc_log_flush(&log);
    drain(&log, 0);
    CHECK(d.starts == 1);
    CHECK(log.head == end + 32);

    decode(&d);
    CHECK(img.blocks == 3 * 32);
    CHECK(img.count == 3 + 3 + 2);
    CHECK(img.rec[0].session == 1 && img.rec[3].session == 2);
    CHECK(img.rec[6].session == 3 && img.rec[7].type == 0x11);
    free(d.blocks);
}

/* Launch and apogee keep recording; the log records each change. */
static void test_flight_keeps_recording(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    flight_state_t s = FLIGHT_IDLE;
    const flight_event_t evs[] = {FLIGHT_EV_ARM, FLIGHT_EV_LAUNCH_DETECTED,
                                  FLIGHT_EV_UNARM, FLIGHT_EV_APOGEE_DETECTED};
    uint8_t x = 1;
    for (unsigned i = 0; i < 4; ++i) {
        flight_state_t n = flight_state_next(s, evs[i]);
        CHECK(emmc_log_on_state(&log, s, n, i));
        s = n;
        CHECK(emmc_log_append(&log, 0x10, i, &x, 1));
    }
    CHECK(s == FLIGHT_RECOVERY);
    emmc_log_flush(&log);
    drain(&log, 0);
    decode(&d);
    /* START, data, STATE(A->L), data, data (un-arm ignored), STATE(L->R),
     * data */
    CHECK(img.count == 7);
    CHECK(img.rec[2].type == EMMC_REC_STATE &&
          img.rec[2].data[0] == FLIGHT_ARMED &&
          img.rec[2].data[1] == FLIGHT_LAUNCHED);
    CHECK(img.rec[4].type == 0x10);
    CHECK(img.rec[5].type == EMMC_REC_STATE &&
          img.rec[5].data[1] == FLIGHT_RECOVERY);
    free(d.blocks);
}

/* A partly filled chunk reaches the card flush_interval after the writer
 * first sees it, padded out. */
static void test_flush_interval(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    CHECK(emmc_log_service(&log, 1000) == EMMC_OK);
    CHECK(emmc_log_service(&log, 1999) == EMMC_OK);
    CHECK(d.writes == 0);
    CHECK(emmc_log_service(&log, 2000) == EMMC_OK);
    CHECK(d.writes == 2); /* superblock + the chunk */
    CHECK(log.stats.pad_blocks == 31);
    decode(&d);
    CHECK(img.blocks == 32 && img.pads == 31 && img.count == 1);
    free(d.blocks);
}

/* With the writer stalled, appends never block: they drop, are counted, and
 * the first record after room returns says how many. */
static void test_backpressure(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    uint8_t p[200] = {0};
    unsigned ok = 0, refused = 0;
    for (unsigned i = 0; i < 2000; ++i) {
        if (emmc_log_append(&log, 0x10, i, p, sizeof p)) {
            ok++;
        } else {
            refused++;
        }
    }
    /* 2 records of 206 B per 488 B block (the 7 B SESSION_START fits beside
     * them in the first), 32 blocks a chunk, every chunk full. */
    CHECK(ok == 2 * 32 * CHUNKS);
    CHECK(refused == 2000 - ok && log.stats.dropped == refused);
    CHECK(emmc_log_backlog(&log) == CHUNKS);

    drain(&log, 0);
    CHECK(emmc_log_append(&log, 0x10, 5000, p, sizeof p));
    emmc_log_flush(&log);
    drain(&log, 0);
    decode(&d);
    const rec_t* r = &img.rec[img.count - 2];
    CHECK(r->type == EMMC_REC_DROPPED && rd32(r->data) == refused);
    CHECK(img.rec[img.count - 1].t == 5000);
    free(d.blocks);
}

/* Power lost part-way through a chunk: the next power-up resumes right
 * after the last block that landed. */
static void test_torn_write(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    uint8_t x = 3;
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    CHECK(emmc_log_append(&log, 0x10, 0, &x, 1));
    emmc_log_flush(&log);
    drain(&log, 0);
    CHECK(emmc_log_append(&log, 0x10, 1, &x, 1));
    emmc_log_flush(&log);
    d.torn_armed = true;
    d.torn_mask = 0x3FFu; /* 10 of 32 blocks land */
    CHECK(emmc_log_service(&log, 0) == EMMC_ERR_IO);

    disk_power_cycle(&d);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    emmc_log_flush(&log);
    drain(&log, 0);
    CHECK(log.head == DATA_START + 32 + 10 + 32);
    decode(&d);
    CHECK(img.blocks == 32 + 10 + 32);
    CHECK(img.rec[img.count - 1].session == 2);
    free(d.blocks);
}

/* A torn write that lands out of order leaves a hole. Resuming at the hole
 * would overwrite the blocks after it, so the mount looks past it. */
static void test_torn_write_hole(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    emmc_log_flush(&log);
    drain(&log, 0);
    CHECK(emmc_log_on_state(&log, FLIGHT_ARMED, FLIGHT_IDLE, 0));
    d.torn_armed = true;
    /* Blocks 0-2 and 9-12 land. The binary search probes 32, 48, 40, 36,
     * 34, 35 and stops at 35, inside the hole. */
    d.torn_mask = 0x7u | (0xFu << 9);
    CHECK(emmc_log_service(&log, 0) == EMMC_ERR_IO);

    disk_power_cycle(&d);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    emmc_log_flush(&log);
    drain(&log, 0);
    CHECK(log.head == DATA_START + 32 + 13 + 32);
    /* Blocks 8-12 of the torn chunk survived the new session's write. */
    const uint8_t* b = d.blocks + (size_t)(DATA_START + 32 + 12) * BS;
    CHECK(rd32(b + 8) == 32 + 12 && rd32(b + 508) == ref_crc(b, 508));
    free(d.blocks);
}

/* A card holding an older log with an unreadable superblock is formatted
 * with a newer epoch, so the old blocks never read as this log's. */
static void test_stale_epoch(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    emmc_log_flush(&log);
    drain(&log, 0);
    CHECK(log.epoch == 1);
    d.blocks[100] ^= 0xFF; /* corrupt the superblock */

    disk_power_cycle(&d);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    emmc_log_flush(&log);
    drain(&log, 0);
    CHECK(log.epoch == 2);
    CHECK(log.head == DATA_START + 32);
    decode(&d);
    CHECK(img.epoch == 2 && img.blocks == 32);
    free(d.blocks);
}

static void test_start_failure(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    d.start_result = EMMC_ERR_TIMEOUT;
    log_new(&log, &d);
    uint8_t x = 1;
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    CHECK(emmc_log_append(&log, 0x10, 0, &x, 1));
    emmc_log_flush(&log);
    CHECK(emmc_log_service(&log, 0) == EMMC_ERR_TIMEOUT);
    CHECK(log.disk == EMMC_DISK_FAULT && !log.recording);
    CHECK(log.stats.chunks_lost == 1 && d.writes == 0);
    CHECK(!emmc_log_append(&log, 0x10, 0, &x, 1));
    CHECK(emmc_log_on_state(&log, FLIGHT_ARMED, FLIGHT_IDLE, 0));
    CHECK(!emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    CHECK(emmc_log_service(&log, 0) == EMMC_OK);
    CHECK(d.starts == 1); /* no init loop (datasheet: read disturb) */
    free(d.blocks);
}

static void test_write_retry(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    emmc_log_flush(&log);
    /* Mount writes the superblock first, then chunk writes fail twice. */
    CHECK(emmc_log_service(&log, 0) == EMMC_OK);
    CHECK(log.stats.chunks_written == 1);
    emmc_log_flush(&log);
    CHECK(emmc_log_append(&log, 0x10, 0, "a", 1));
    emmc_log_flush(&log);
    d.write_failures = 2;
    CHECK(emmc_log_service(&log, 0) == EMMC_ERR_IO);
    CHECK(emmc_log_service(&log, 0) == EMMC_ERR_IO);
    CHECK(emmc_log_service(&log, 0) == EMMC_OK);
    CHECK(log.stats.write_errors == 2 && log.disk == EMMC_DISK_MOUNTED);

    CHECK(emmc_log_append(&log, 0x10, 0, "b", 1));
    emmc_log_flush(&log);
    d.write_failures = 3;
    for (int i = 0; i < 3; ++i) {
        CHECK(emmc_log_service(&log, 0) == EMMC_ERR_IO);
    }
    CHECK(log.disk == EMMC_DISK_FAULT && log.stats.chunks_lost == 1);
    CHECK(!emmc_log_append(&log, 0x10, 0, "c", 1));
    free(d.blocks);
}

static void test_full(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 2 + 5); /* room for two chunks */
    log_new(&log, &d);
    CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 0));
    for (int i = 0; i < 3; ++i) {
        CHECK(emmc_log_append(&log, 0x10, 0, "x", 1));
        emmc_log_flush(&log);
    }
    CHECK(emmc_log_service(&log, 0) == EMMC_OK);
    CHECK(emmc_log_service(&log, 0) == EMMC_OK);
    CHECK(emmc_log_service(&log, 0) == EMMC_ERR_NOT_READY);
    CHECK(log.disk == EMMC_DISK_FULL && !log.recording);
    CHECK(log.stats.chunks_written == 2 && log.stats.chunks_lost == 1);
    CHECK(!emmc_log_append(&log, 0x10, 0, "x", 1));
    free(d.blocks);
}

static void test_invalid_init(void) {
    disk_t d;
    emmc_log_t log;
    emmc_log_config_t c = config();
    disk_new(&d, 1024);
    CHECK(emmc_log_init(&log, &port, &d, &c, chunks, 1, scratch) ==
          EMMC_ERR_PARAM);
    CHECK(emmc_log_init(&log, &port, &d, &c, chunks, EMMC_LOG_MAX_CHUNKS + 1,
                        scratch) == EMMC_ERR_PARAM);
    CHECK(emmc_log_init(&log, &port, &d, &c, chunks, 2, NULL) ==
          EMMC_ERR_PARAM);
    emmc_port_t half = port;
    half.unlock = NULL;
    CHECK(emmc_log_init(&log, &half, &d, &c, chunks, 2, scratch) ==
          EMMC_ERR_PARAM);
    c.data_start_lba = 0;
    CHECK(emmc_log_init(&log, &port, &d, &c, chunks, 2, scratch) ==
          EMMC_ERR_PARAM);
    free(d.blocks);
}

/* After a power cycle: open (no format), list both sessions, read blocks. */
static void test_read_back(void) {
    disk_t d;
    emmc_log_t log;
    disk_new(&d, DATA_START + 32 * 16);
    log_new(&log, &d);
    CHECK(emmc_log_open(&log) == EMMC_OK && emmc_log_used(&log) == 0);
    CHECK(d.writes == 0); /* an empty card is not formatted by reading */
    uint8_t x = 7;
    for (int s = 0; s < 2; ++s) {
        CHECK(emmc_log_on_state(&log, FLIGHT_IDLE, FLIGHT_ARMED, 100));
        CHECK(emmc_log_append(&log, 0x11, 150, &x, 1));
        CHECK(emmc_log_open(&log) == EMMC_ERR_NOT_READY); /* recording */
        CHECK(emmc_log_on_state(&log, FLIGHT_ARMED, FLIGHT_IDLE, 400));
        drain(&log, 500);
    }

    disk_power_cycle(&d);
    log_new(&log, &d);
    CHECK(emmc_log_used(&log) == 0);
    CHECK(emmc_log_open(&log) == EMMC_OK);
    CHECK(d.writes == 0);
    CHECK(emmc_log_used(&log) == 2 * 32);
    emmc_log_session_t s[4];
    uint32_t n = 0, total = 0;
    CHECK(emmc_log_sessions(&log, 0, s, 4, &n, &total) == EMMC_OK);
    CHECK(n == 2 && total == 2);
    CHECK(s[0].session == 1 && s[0].first_block == 0 && s[0].blocks == 32);
    CHECK(s[1].session == 2 && s[1].first_block == 32 && s[1].blocks == 32);
    CHECK(s[0].duration_ms == 300); /* SESSION_START at 100 .. END at 400 */
    CHECK(emmc_log_sessions(&log, 1, s, 4, &n, &total) == EMMC_OK);
    CHECK(n == 1 && total == 2 && s[0].session == 2); /* paging */
    static uint8_t b[512];
    CHECK(emmc_log_read(&log, 32, b) == EMMC_OK);
    CHECK(memcmp(b, d.blocks + (size_t)(DATA_START + 32) * BS, BS) == 0);
    CHECK(emmc_log_read(&log, 64, b) == EMMC_ERR_PARAM); /* past the end */
    CHECK(d.writes == 0);
    free(d.blocks);
}

int main(void) {
    test_crc();
    test_no_io_before_arm();
    test_session_roundtrip();
    test_sessions_and_remount();
    test_read_back();
    test_flight_keeps_recording();
    test_flush_interval();
    test_backpressure();
    test_torn_write();
    test_torn_write_hole();
    test_stale_epoch();
    test_start_failure();
    test_write_retry();
    test_full();
    test_invalid_init();
    puts("14 emmc log test groups passed");
    return 0;
}
