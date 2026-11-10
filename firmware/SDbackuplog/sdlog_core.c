#include "sdlog_core.h"

#include <stddef.h>
#include <string.h>

#include "emmc_log.h" /* emmc_log_crc32, EMMC_REC_* */
#include "records.h"

#define N SDLOG_RAM_BLOCKS
#define READ_BUDGET_MS 100U
#define WRITE_BUDGET_MS 1000U

static void put16(uint8_t* p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static void put32(uint8_t* p, uint32_t v) {
    put16(p, (uint16_t)v);
    put16(p + 2, (uint16_t)(v >> 16));
}

static uint16_t get16(const uint8_t* p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t get32(const uint8_t* p) {
    return get16(p) | ((uint32_t)get16(p + 2) << 16);
}

static bool crc_ok(const uint8_t* b) {
    return get32(b + 508) == emmc_log_crc32(b, 508U);
}

static void lock(sdlog_t* log) {
    if (log->port.lock) {
        log->port.lock(log->context);
    }
}

static void unlock(sdlog_t* log) {
    if (log->port.unlock) {
        log->port.unlock(log->context);
    }
}

/* ---- producer side (caller holds the lock) ----------------------------- */

static uint8_t fill_index(const sdlog_t* log) {
    return (uint8_t)((log->tail + log->ready) % N);
}

static void seal(sdlog_t* log) {
    if (log->has_fill) {
        put16(log->ring[fill_index(log)] + 18, log->fill_offset);
        log->ready++;
        log->has_fill = false;
    }
}

static bool put_record(sdlog_t* log, uint8_t type, uint32_t t_ms,
                       const void* data, uint8_t len) {
    uint16_t need = (uint16_t)(6U + len);
    if (log->has_fill && log->fill_offset + need > SDLOG_PAYLOAD_BYTES) {
        seal(log);
    }
    if (!log->has_fill) {
        if (log->ready == N) {
            return false;
        }
        memset(log->ring[fill_index(log)], 0, SDLOG_BLOCK_SIZE);
        log->ring_arm[fill_index(log)] = log->arm_index;
        log->has_fill = true;
        log->fill_offset = 0;
        log->fill_aged = false;
    }
    uint8_t* p = log->ring[fill_index(log)] + SDLOG_HEADER_BYTES +
                 log->fill_offset;
    p[0] = type;
    p[1] = len;
    put32(p + 2, t_ms);
    if (len > 0U) {
        memcpy(p + 6, data, len);
    }
    log->fill_offset = (uint16_t)(log->fill_offset + need);
    return true;
}

static bool keep(sdlog_t* log, uint8_t type, uint32_t t_ms, const void* data,
                 uint8_t len) {
    if (log->unreported_drops > 0U) {
        uint8_t n[4];
        put32(n, log->unreported_drops);
        if (put_record(log, EMMC_REC_DROPPED, t_ms, n, sizeof n)) {
            log->stats.records++;
            log->unreported_drops = 0;
        }
    }
    if (put_record(log, type, t_ms, data, len)) {
        log->stats.records++;
        return true;
    }
    log->stats.dropped++;
    log->unreported_drops++;
    return false;
}

/* ---- public producer API ---------------------------------------------- */

bool sdlog_init(sdlog_t* log, const emmc_port_t* port, void* context) {
    if (!log || !port || !port->start || !port->read || !port->write ||
        (port->lock == NULL) != (port->unlock == NULL)) {
        return false;
    }
    memset(log, 0, sizeof *log);
    log->port = *port;
    log->context = context;
    return true;
}

bool sdlog_on_state(sdlog_t* log, flight_state_t from, flight_state_t to,
                    uint32_t now_ms) {
    bool was = flight_state_logs_to_emmc(from);
    bool is = flight_state_logs_to_emmc(to);
    bool ok = true;
    lock(log);
    if (!was && is) {
        if (log->disk == SDLOG_FULL || log->disk == SDLOG_FAULT) {
            ok = false;
        } else {
            log->arm_index++;
            log->recording = true;
            log->unreported_drops = 0;
            uint8_t s = (uint8_t)to;
            (void)keep(log, EMMC_REC_SESSION_START, now_ms, &s, 1U);
        }
    } else if (was && is && from != to && log->recording) {
        uint8_t s[2] = {(uint8_t)from, (uint8_t)to};
        (void)keep(log, EMMC_REC_STATE, now_ms, s, 2U);
    } else if (was && !is) {
        if (log->recording) {
            uint8_t s = (uint8_t)to;
            (void)keep(log, EMMC_REC_SESSION_END, now_ms, &s, 1U);
        }
        seal(log);
        log->recording = false;
    }
    unlock(log);
    return ok;
}

bool sdlog_append(sdlog_t* log, uint8_t type, uint32_t t_ms, const void* data,
                  uint8_t len) {
    if ((type != REC_GNSS && type != REC_BARO && type != REC_HEALTH &&
         type != REC_EVENT) ||
        (len > 0U && !data)) {
        return false;
    }
    lock(log);
    bool ok = log->recording && keep(log, type, t_ms, data, len);
    unlock(log);
    return ok;
}

uint8_t sdlog_backlog(const sdlog_t* log) {
    return log->ready;
}

/* ---- writer side --------------------------------------------------------- */

/* Stop recording and discard everything queued. */
static void stop(sdlog_t* log, sdlog_disk_t why) {
    lock(log);
    log->disk = why;
    log->recording = false;
    seal(log);
    log->stats.blocks_lost += log->ready;
    log->tail = (uint8_t)((log->tail + log->ready) % N);
    log->ready = 0;
    unlock(log);
}

static emmc_status_t read_block(sdlog_t* log, uint32_t lba) {
    return log->port.read(log->context, lba, log->scratch, 1U, READ_BUDGET_MS);
}

/* Read log block k: is it a block of this volume, at its own position? */
static emmc_status_t probe(sdlog_t* log, uint32_t k, bool* valid) {
    const uint8_t* b = log->scratch;
    emmc_status_t st = read_block(log, SDLOG_DATA_START + k);
    *valid = st == EMMC_OK && get32(b) == SDLOG_BLOCK_MAGIC &&
             get32(b + 4) == log->epoch && get32(b + 8) == k &&
             get16(b + 18) <= SDLOG_PAYLOAD_BYTES && crc_ok(b);
    return st;
}

/* First invalid block in [lo, hi), given every block below lo is valid. */
static emmc_status_t search(sdlog_t* log, uint32_t lo, uint32_t hi,
                            uint32_t* end) {
    while (lo < hi) {
        uint32_t mid = lo + (hi - lo) / 2U;
        bool valid = false;
        emmc_status_t st = probe(log, mid, &valid);
        if (st != EMMC_OK) {
            return st;
        }
        if (valid) {
            lo = mid + 1U;
        } else {
            hi = mid;
        }
    }
    *end = lo;
    return EMMC_OK;
}

/* scratch holds block 0. The new epoch must beat the old superblock's and
 * the first log block's, or stale blocks would read as valid. */
static emmc_status_t format(sdlog_t* log) {
    uint8_t* s = log->scratch;
    uint32_t last = get32(s) == SDLOG_SUPER_MAGIC && crc_ok(s) ? get32(s + 8)
                                                               : 0U;
    emmc_status_t st = read_block(log, SDLOG_DATA_START);
    if (st != EMMC_OK) {
        return st;
    }
    if (get32(s) == SDLOG_BLOCK_MAGIC && crc_ok(s) && get32(s + 4) > last) {
        last = get32(s + 4);
    }
    log->epoch = last + 1U == 0U ? 1U : last + 1U;
    memset(s, 0, SDLOG_BLOCK_SIZE);
    put32(s, SDLOG_SUPER_MAGIC);
    put32(s + 4, SDLOG_LAYOUT_VERSION);
    put32(s + 8, log->epoch);
    put32(s + 12, SDLOG_DATA_START);
    put32(s + 16, log->capacity);
    put32(s + 508, emmc_log_crc32(s, 508U));
    return log->port.write(log->context, 0U, s, 1U, WRITE_BUDGET_MS);
}

static emmc_status_t mount(sdlog_t* log) {
    uint32_t capacity = 0;
    emmc_status_t st = log->port.start(log->context, &capacity);
    if (st != EMMC_OK) {
        return st;
    }
    if (capacity <= SDLOG_DATA_START + SDLOG_MAX_BURST) {
        return EMMC_ERR_PARAM;
    }
    log->capacity = capacity;
    const uint8_t* s = log->scratch;
    if ((st = read_block(log, 0U)) != EMMC_OK) {
        return st;
    }
    if (get32(s) == SDLOG_SUPER_MAGIC &&
        get32(s + 4) == SDLOG_LAYOUT_VERSION && get32(s + 8) != 0U &&
        get32(s + 12) == SDLOG_DATA_START && get32(s + 16) == capacity &&
        crc_ok(s)) {
        log->epoch = get32(s + 8);
    } else if ((st = format(log)) != EMMC_OK) {
        return st;
    }

    /* Binary search for the end, then look one burst past it: a torn burst
     * can leave a hole with valid blocks after it. */
    uint32_t n = capacity - SDLOG_DATA_START, end = 0;
    if ((st = search(log, 0U, n, &end)) != EMMC_OK) {
        return st;
    }
    for (;;) {
        uint32_t found = end;
        for (uint32_t j = end + 1U; j < n && j < end + SDLOG_MAX_BURST; ++j) {
            bool valid = false;
            if ((st = probe(log, j, &valid)) != EMMC_OK) {
                return st;
            }
            found = valid ? j : found;
        }
        if (found == end) {
            break;
        }
        if ((st = search(log, found + 1U, n, &end)) != EMMC_OK) {
            return st;
        }
    }
    log->base_session = 0;
    if (end > 0U) {
        if ((st = read_block(log, SDLOG_DATA_START + end - 1U)) != EMMC_OK) {
            return st;
        }
        log->base_session = get32(s + 12);
    }
    log->head = SDLOG_DATA_START + end;
    lock(log);
    log->disk = SDLOG_MOUNTED;
    unlock(log);
    return EMMC_OK;
}

emmc_status_t sdlog_service(sdlog_t* log, uint32_t now_ms) {
    lock(log);
    if (log->has_fill) {
        if (!log->fill_aged) {
            log->fill_aged = true;
            log->fill_started_ms = now_ms;
        } else if ((uint32_t)(now_ms - log->fill_started_ms) >=
                   SDLOG_FLUSH_MS) {
            seal(log);
        }
    }
    uint8_t tail = log->tail, n = log->ready;
    sdlog_disk_t disk = log->disk;
    unlock(log);

    if (n == 0U) {
        return EMMC_OK;
    }
    emmc_status_t st;
    if (disk == SDLOG_UNMOUNTED && (st = mount(log)) != EMMC_OK) {
        stop(log, SDLOG_FAULT);
        return st;
    }
    if (disk != SDLOG_UNMOUNTED && disk != SDLOG_MOUNTED) {
        stop(log, disk);
        return EMMC_ERR_NOT_READY;
    }
    if (log->head >= log->capacity) {
        stop(log, SDLOG_FULL);
        return EMMC_ERR_NOT_READY;
    }
    /* One burst: contiguous in the ring and on the card. */
    n = n < SDLOG_MAX_BURST ? n : SDLOG_MAX_BURST;
    n = n < N - tail ? n : (uint8_t)(N - tail);
    if (n > log->capacity - log->head) {
        n = (uint8_t)(log->capacity - log->head);
    }
    for (uint8_t i = 0; i < n; ++i) {
        uint8_t* b = log->ring[tail + i];
        put32(b, SDLOG_BLOCK_MAGIC);
        put32(b + 4, log->epoch);
        put32(b + 8, log->head - SDLOG_DATA_START + i);
        put32(b + 12, log->base_session + log->ring_arm[tail + i]);
        b[16] = 1U; /* EMMC_LOG_KIND_DATA: same layout as the eMMC log */
        put32(b + 508, emmc_log_crc32(b, 508U));
    }
    st = log->port.write(log->context, log->head, log->ring[tail], n,
                         WRITE_BUDGET_MS);
    if (st == EMMC_OK) {
        log->head += n;
        log->write_tries = 0;
        lock(log);
        log->tail = (uint8_t)((log->tail + n) % N);
        log->ready = (uint8_t)(log->ready - n);
        log->stats.blocks_written += n;
        unlock(log);
        return EMMC_OK;
    }
    log->stats.write_errors++;
    if (++log->write_tries >= SDLOG_WRITE_ATTEMPTS) {
        stop(log, SDLOG_FAULT);
    }
    return st;
}
