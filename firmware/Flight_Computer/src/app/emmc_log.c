#include "emmc_log.h"

#include <stddef.h>
#include <string.h>

/* ---- little-endian helpers ------------------------------------------- */

static void put16(uint8_t* p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static void put32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static uint16_t get16(const uint8_t* p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t get32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

/* ---- CRC-32, four bits at a time (16-entry table, no 1 KB table) ------ */

uint32_t emmc_log_crc32(const void* data, uint32_t len) {
    static const uint32_t table[16] = {
        0x00000000UL, 0x1DB71064UL, 0x3B6E20C8UL, 0x26D930ACUL,
        0x76DC4190UL, 0x6B6B51F4UL, 0x4DB26158UL, 0x5005713CUL,
        0xEDB88320UL, 0xF00F9344UL, 0xD6D6A3E8UL, 0xCB61B38CUL,
        0x9B64C2B0UL, 0x86D3D2D4UL, 0xA00AE278UL, 0xBDBDF21CUL};
    const uint8_t* p = (const uint8_t*)data;
    uint32_t crc = 0xFFFFFFFFUL;
    for (uint32_t i = 0; i < len; ++i) {
        crc ^= p[i];
        crc = (crc >> 4) ^ table[crc & 0x0FU];
        crc = (crc >> 4) ^ table[crc & 0x0FU];
    }
    return crc ^ 0xFFFFFFFFUL;
}

/* ---- locking ------------------------------------------------------------ */

static void lock(emmc_log_t* log) {
    if (log->port.lock) {
        log->port.lock(log->context);
    }
}

static void unlock(emmc_log_t* log) {
    if (log->port.unlock) {
        log->port.unlock(log->context);
    }
}

/* ---- producer side (caller holds the lock) ----------------------------- */

static uint8_t* block_at(emmc_log_t* log, uint8_t chunk, uint8_t block) {
    return log->chunks[chunk].bytes + (uint32_t)block * EMMC_BLOCK_SIZE;
}

static void chunk_complete(emmc_log_t* log) {
    log->chunk_state[log->fill_chunk] = EMMC_CHUNK_READY;
    log->has_fill = false;
    log->fill_chunk = (uint8_t)((log->fill_chunk + 1U) % log->chunk_count);
}

static void close_block(emmc_log_t* log) {
    uint8_t* b = block_at(log, log->fill_chunk, log->fill_block);
    b[16] = (uint8_t)EMMC_LOG_KIND_DATA;
    put16(b + 18, log->fill_offset);
    log->fill_block++;
    log->fill_offset = 0;
    if (log->fill_block == EMMC_LOG_CHUNK_BLOCKS) {
        chunk_complete(log);
    }
}

static void seal(emmc_log_t* log) {
    if (!log->has_fill) {
        return;
    }
    if (log->fill_offset > 0U) {
        close_block(log);
        if (!log->has_fill) {
            return;
        }
    }
    /* Remaining blocks were zeroed when the chunk was acquired. */
    while (log->fill_block < EMMC_LOG_CHUNK_BLOCKS) {
        block_at(log, log->fill_chunk, log->fill_block)[16] =
            (uint8_t)EMMC_LOG_KIND_PAD;
        log->stats.pad_blocks++;
        log->fill_block++;
    }
    chunk_complete(log);
}

static bool acquire(emmc_log_t* log) {
    uint8_t c = log->fill_chunk;
    if (log->chunk_state[c] != EMMC_CHUNK_FREE) {
        return false;
    }
    memset(log->chunks[c].bytes, 0, EMMC_LOG_CHUNK_BYTES);
    log->chunk_state[c] = EMMC_CHUNK_FILLING;
    log->chunk_arm[c] = log->arm_index;
    log->has_fill = true;
    log->fill_block = 0;
    log->fill_offset = 0;
    log->fill_started_ms = 0;
    log->fill_aged = false;
    return true;
}

static bool put_record(emmc_log_t* log, uint8_t type, uint32_t t_ms,
                       const void* data, uint8_t len) {
    uint16_t need = (uint16_t)(EMMC_LOG_RECORD_HEADER_BYTES + len);
    if (log->has_fill &&
        (uint32_t)log->fill_offset + need > EMMC_LOG_PAYLOAD_BYTES) {
        close_block(log);
    }
    if (!log->has_fill && !acquire(log)) {
        return false;
    }
    uint8_t* p = block_at(log, log->fill_chunk, log->fill_block) +
                 EMMC_LOG_HEADER_BYTES + log->fill_offset;
    p[0] = type;
    p[1] = len;
    put32(p + 2, t_ms);
    if (len > 0U) {
        memcpy(p + EMMC_LOG_RECORD_HEADER_BYTES, data, len);
    }
    log->fill_offset = (uint16_t)(log->fill_offset + need);
    if (log->fill_offset == EMMC_LOG_PAYLOAD_BYTES) {
        close_block(log);
    }
    return true;
}

/* Count the outcome of a record the log was asked to keep. */
static bool keep(emmc_log_t* log, uint8_t type, uint32_t t_ms, const void* data,
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

emmc_log_config_t emmc_log_default_config(void) {
    emmc_log_config_t c;
    c.data_start_lba = EMMC_LOG_DEFAULT_DATA_START;
    c.flush_interval_ms = 1000U;
    c.read_budget_ms = 100U;
    c.write_budget_ms = 1000U;
    c.write_attempts = 3U;
    return c;
}

emmc_status_t emmc_log_init(emmc_log_t* log, const emmc_port_t* port,
                            void* context, const emmc_log_config_t* config,
                            emmc_log_chunk_t* chunks, uint8_t chunk_count,
                            uint8_t* scratch) {
    if (!log || !port || !port->start || !port->read || !port->write ||
        !config || !chunks || !scratch || chunk_count < 2U ||
        chunk_count > EMMC_LOG_MAX_CHUNKS || config->data_start_lba == 0U ||
        config->flush_interval_ms == 0U || config->read_budget_ms == 0U ||
        config->write_budget_ms == 0U || config->write_attempts == 0U ||
        (port->lock == NULL) != (port->unlock == NULL)) {
        return EMMC_ERR_PARAM;
    }
    memset(log, 0, sizeof *log);
    log->port = *port;
    log->context = context;
    log->config = *config;
    log->chunks = chunks;
    log->chunk_count = chunk_count;
    log->scratch = scratch;
    log->disk = EMMC_DISK_UNMOUNTED;
    return EMMC_OK;
}

bool emmc_log_on_state(emmc_log_t* log, flight_state_t from, flight_state_t to,
                       uint32_t now_ms) {
    bool was = flight_state_logs_to_emmc(from);
    bool is = flight_state_logs_to_emmc(to);
    bool ok = true;
    lock(log);
    if (!was && is) {
        if (log->disk == EMMC_DISK_FULL || log->disk == EMMC_DISK_FAULT) {
            log->recording = false;
            ok = false;
        } else {
            seal(log); /* a session never shares a chunk with another */
            log->arm_index++;
            log->recording = true;
            log->unreported_drops = 0;
            uint8_t s = (uint8_t)to;
            (void)keep(log, EMMC_REC_SESSION_START, now_ms, &s, 1U);
        }
    } else if (was && is && from != to) {
        if (log->recording) {
            uint8_t s[2] = {(uint8_t)from, (uint8_t)to};
            (void)keep(log, EMMC_REC_STATE, now_ms, s, 2U);
        }
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

bool emmc_log_append(emmc_log_t* log, uint8_t type, uint32_t t_ms,
                     const void* data, uint8_t len) {
    if (len > 0U && !data) {
        return false;
    }
    lock(log);
    bool ok = log->recording && keep(log, type, t_ms, data, len);
    unlock(log);
    return ok;
}

void emmc_log_flush(emmc_log_t* log) {
    lock(log);
    seal(log);
    unlock(log);
}

uint8_t emmc_log_backlog(const emmc_log_t* log) {
    uint8_t n = 0;
    for (uint8_t i = 0; i < log->chunk_count; ++i) {
        n = (uint8_t)(n + (log->chunk_state[i] == EMMC_CHUNK_READY));
    }
    return n;
}

/* ---- writer side --------------------------------------------------------- */

static void stop(emmc_log_t* log, emmc_disk_state_t why) {
    lock(log);
    log->disk = why;
    log->recording = false;
    seal(log); /* so the writer discards it instead of it filling forever */
    unlock(log);
}

static void release_write_chunk(emmc_log_t* log, bool written) {
    lock(log);
    log->chunk_state[log->write_chunk] = EMMC_CHUNK_FREE;
    log->write_chunk = (uint8_t)((log->write_chunk + 1U) % log->chunk_count);
    if (written) {
        log->stats.chunks_written++;
    } else {
        log->stats.chunks_lost++;
    }
    unlock(log);
    log->write_tries = 0;
}

/* Read log block k and say whether it is a valid block of this volume. */
static emmc_status_t probe(emmc_log_t* log, uint32_t k, bool* valid,
                           uint32_t* session) {
    const uint8_t* b = log->scratch;
    emmc_status_t st =
        log->port.read(log->context, log->config.data_start_lba + k,
                       log->scratch, 1U, log->config.read_budget_ms);
    if (st != EMMC_OK) {
        return st;
    }
    *valid = get32(b) == EMMC_LOG_BLOCK_MAGIC && get32(b + 4) == log->epoch &&
             get32(b + 8) == k &&
             (b[16] == EMMC_LOG_KIND_DATA || b[16] == EMMC_LOG_KIND_PAD) &&
             get16(b + 18) <= EMMC_LOG_PAYLOAD_BYTES &&
             get32(b + 508) == emmc_log_crc32(b, 508U);
    if (session) {
        *session = get32(b + 12);
    }
    return EMMC_OK;
}

/* First invalid block in [lo, hi), given every block below lo is valid. */
static emmc_status_t search(emmc_log_t* log, uint32_t lo, uint32_t hi,
                            uint32_t* end) {
    while (lo < hi) {
        uint32_t mid = lo + (hi - lo) / 2U;
        bool valid = false;
        emmc_status_t st = probe(log, mid, &valid, NULL);
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

static emmc_status_t format(emmc_log_t* log) {
    uint8_t* s = log->scratch;
    uint32_t last = 0;
    /* An old superblock (other config) or old log blocks name an epoch the
     * new one must differ from, or stale blocks would read as valid. */
    if (get32(s) == EMMC_LOG_SUPER_MAGIC &&
        get32(s + 508) == emmc_log_crc32(s, 508U)) {
        last = get32(s + 8);
    }
    emmc_status_t st = log->port.read(log->context, log->config.data_start_lba,
                                      s, 1U, log->config.read_budget_ms);
    if (st != EMMC_OK) {
        return st;
    }
    if (get32(s) == EMMC_LOG_BLOCK_MAGIC &&
        get32(s + 508) == emmc_log_crc32(s, 508U) && get32(s + 4) > last) {
        last = get32(s + 4);
    }
    log->epoch = last + 1U == 0U ? 1U : last + 1U;
    memset(s, 0, EMMC_BLOCK_SIZE);
    put32(s, EMMC_LOG_SUPER_MAGIC);
    put32(s + 4, EMMC_LOG_LAYOUT_VERSION);
    put32(s + 8, log->epoch);
    put32(s + 12, log->config.data_start_lba);
    put32(s + 16, log->capacity);
    put32(s + 508, emmc_log_crc32(s, 508U));
    return log->port.write(log->context, 0U, s, 1U,
                           log->config.write_budget_ms);
}

/* may_format false (reading back): a card with no valid superblock is left
 * untouched, *found = false, the log stays UNMOUNTED. */
static emmc_status_t mount(emmc_log_t* log, bool may_format, bool* found) {
    uint32_t capacity = 0;
    emmc_status_t st = log->port.start(log->context, &capacity);
    if (st != EMMC_OK) {
        return st;
    }
    if (capacity <= log->config.data_start_lba + EMMC_LOG_CHUNK_BLOCKS) {
        return EMMC_ERR_PARAM;
    }
    log->capacity = capacity;

    const uint8_t* s = log->scratch;
    st = log->port.read(log->context, 0U, log->scratch, 1U,
                        log->config.read_budget_ms);
    if (st != EMMC_OK) {
        return st;
    }
    if (get32(s) == EMMC_LOG_SUPER_MAGIC &&
        get32(s + 4) == EMMC_LOG_LAYOUT_VERSION && get32(s + 8) != 0U &&
        get32(s + 12) == log->config.data_start_lba &&
        get32(s + 16) == capacity &&
        get32(s + 508) == emmc_log_crc32(s, 508U)) {
        log->epoch = get32(s + 8);
    } else if (!may_format) {
        *found = false;
        return EMMC_OK;
    } else if ((st = format(log)) != EMMC_OK) {
        return st;
    }
    *found = true;

    /* Binary search for the end, then look one chunk past it: a torn
     * multi-block write may leave a hole with valid blocks after it, and
     * resuming at the hole would overwrite them. */
    uint32_t n = capacity - log->config.data_start_lba;
    uint32_t end = 0;
    if ((st = search(log, 0U, n, &end)) != EMMC_OK) {
        return st;
    }
    for (;;) {
        uint32_t found = end;
        for (uint32_t j = end + 1U; j < n && j <= end + EMMC_LOG_CHUNK_BLOCKS;
             ++j) {
            bool valid = false;
            if ((st = probe(log, j, &valid, NULL)) != EMMC_OK) {
                return st;
            }
            if (valid) {
                found = j;
            }
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
        bool valid = false;
        if ((st = probe(log, end - 1U, &valid, &log->base_session)) !=
            EMMC_OK) {
            return st;
        }
    }
    log->head = log->config.data_start_lba + end;
    lock(log);
    log->disk = EMMC_DISK_MOUNTED;
    unlock(log);
    return EMMC_OK;
}

emmc_status_t emmc_log_service(emmc_log_t* log, uint32_t now_ms) {
    lock(log);
    if (log->has_fill) {
        if (!log->fill_aged) {
            log->fill_aged = true;
            log->fill_started_ms = now_ms;
        } else if ((uint32_t)(now_ms - log->fill_started_ms) >=
                   log->config.flush_interval_ms) {
            seal(log);
        }
    }
    uint8_t c = log->write_chunk;
    bool ready = log->chunk_state[c] == EMMC_CHUNK_READY;
    uint32_t arm = log->chunk_arm[c];
    emmc_disk_state_t disk = log->disk;
    unlock(log);

    if (!ready) {
        return EMMC_OK;
    }
    if (disk == EMMC_DISK_UNMOUNTED) {
        bool found = false;
        emmc_status_t st = mount(log, true, &found);
        if (st != EMMC_OK) {
            stop(log, EMMC_DISK_FAULT);
            release_write_chunk(log, false);
            return st;
        }
    } else if (disk != EMMC_DISK_MOUNTED) {
        release_write_chunk(log, false);
        return EMMC_ERR_NOT_READY;
    }
    if (log->head > log->capacity - EMMC_LOG_CHUNK_BLOCKS) {
        stop(log, EMMC_DISK_FULL);
        release_write_chunk(log, false);
        return EMMC_ERR_NOT_READY;
    }

    uint32_t first = log->head - log->config.data_start_lba;
    for (uint8_t i = 0; i < EMMC_LOG_CHUNK_BLOCKS; ++i) {
        uint8_t* b = block_at(log, c, i);
        put32(b, EMMC_LOG_BLOCK_MAGIC);
        put32(b + 4, log->epoch);
        put32(b + 8, first + i);
        put32(b + 12, log->base_session + arm);
        b[17] = 0;
        put32(b + 508, emmc_log_crc32(b, 508U));
    }
    emmc_status_t st =
        log->port.write(log->context, log->head, log->chunks[c].bytes,
                        EMMC_LOG_CHUNK_BLOCKS, log->config.write_budget_ms);
    if (st == EMMC_OK) {
        log->head += EMMC_LOG_CHUNK_BLOCKS;
        release_write_chunk(log, true);
        return EMMC_OK;
    }
    log->stats.write_errors++;
    if (++log->write_tries >= log->config.write_attempts) {
        stop(log, EMMC_DISK_FAULT);
        release_write_chunk(log, false);
    }
    return st;
}

/* ---- reading back --------------------------------------------------- */

emmc_status_t emmc_log_open(emmc_log_t* log) {
    lock(log);
    emmc_disk_state_t disk = log->disk;
    bool recording = log->recording;
    unlock(log);
    if (recording) {
        return EMMC_ERR_NOT_READY;
    }
    if (disk == EMMC_DISK_MOUNTED || disk == EMMC_DISK_FULL) {
        return EMMC_OK;
    }
    if (disk != EMMC_DISK_UNMOUNTED) {
        return EMMC_ERR_NOT_READY; /* FAULT */
    }
    bool found = false;
    return mount(log, false, &found);
}

uint32_t emmc_log_used(const emmc_log_t* log) {
    bool mounted =
        log->disk == EMMC_DISK_MOUNTED || log->disk == EMMC_DISK_FULL;
    return mounted ? log->head - log->config.data_start_lba : 0U;
}

/* Session of log block k; 0 for a block that is not valid. */
static emmc_status_t session_of(emmc_log_t* log, uint32_t k, uint32_t* s) {
    bool valid = false;
    emmc_status_t st = probe(log, k, &valid, s);
    if (st == EMMC_OK && !valid) {
        *s = 0;
    }
    return st;
}

/* First block in [0, n) of session s or later (sessions never decrease). */
static emmc_status_t first_of(emmc_log_t* log, uint32_t n, uint32_t s,
                              uint32_t* k) {
    uint32_t lo = 0, hi = n;
    while (lo < hi) {
        uint32_t mid = lo + (hi - lo) / 2U, at = 0;
        emmc_status_t st = session_of(log, mid, &at);
        if (st != EMMC_OK) {
            return st;
        }
        if (at < s) {
            lo = mid + 1U;
        } else {
            hi = mid;
        }
    }
    *k = lo;
    return EMMC_OK;
}

/* t_ms of the first or last record in block k (*any false: no records). */
static emmc_status_t record_time(emmc_log_t* log, uint32_t k, bool last,
                                 uint32_t* t, bool* any) {
    const uint8_t* b = log->scratch;
    emmc_status_t st =
        log->port.read(log->context, log->config.data_start_lba + k,
                       log->scratch, 1U, log->config.read_budget_ms);
    if (st != EMMC_OK) {
        return st;
    }
    uint16_t used = get16(b + 18);
    *any = false;
    for (uint32_t i = 0; used <= EMMC_LOG_PAYLOAD_BYTES &&
                         i + EMMC_LOG_RECORD_HEADER_BYTES <= used;) {
        const uint8_t* r = b + EMMC_LOG_HEADER_BYTES + i;
        *t = get32(r + 2);
        *any = true;
        if (!last) {
            break;
        }
        i += EMMC_LOG_RECORD_HEADER_BYTES + r[1];
    }
    return EMMC_OK;
}

emmc_status_t emmc_log_sessions(emmc_log_t* log, uint32_t start,
                                emmc_log_session_t* out, uint32_t max,
                                uint32_t* n, uint32_t* total) {
    uint32_t used = emmc_log_used(log), s0 = 0, s1 = 0;
    emmc_status_t st;
    *n = 0;
    *total = 0;
    if (used == 0U) {
        return EMMC_OK;
    }
    if ((st = session_of(log, 0, &s0)) != EMMC_OK ||
        (st = session_of(log, used - 1U, &s1)) != EMMC_OK) {
        return st;
    }
    uint32_t first = 0;
    for (uint32_t s = s0; s != 0U && s <= s1; ++s) {
        uint32_t next = 0, at = 0;
        if ((st = first_of(log, used, s + 1U, &next)) != EMMC_OK ||
            (st = session_of(log, first, &at)) != EMMC_OK) {
            return st;
        }
        if (first < next && at == s) { /* s has blocks: [first, next) */
            if (*total >= start && *n < max) {
                emmc_log_session_t* e = &out[(*n)++];
                uint32_t t0 = 0, t1 = 0;
                bool any = false;
                e->session = s;
                e->first_block = first;
                e->blocks = next - first;
                if ((st = record_time(log, first, false, &t0, &any)) !=
                    EMMC_OK) {
                    return st;
                }
                any = false; /* last data: skip pad blocks at the end */
                for (uint32_t k = next; k > first && !any; --k) {
                    if ((st = record_time(log, k - 1U, true, &t1, &any)) !=
                        EMMC_OK) {
                        return st;
                    }
                }
                e->duration_ms = any ? t1 - t0 : 0U;
            }
            ++*total;
        }
        first = next;
    }
    return EMMC_OK;
}

emmc_status_t emmc_log_read(emmc_log_t* log, uint32_t k, uint8_t* buf) {
    if (k >= emmc_log_used(log)) {
        return EMMC_ERR_PARAM;
    }
    return log->port.read(log->context, log->config.data_start_lba + k, buf, 1U,
                          log->config.read_budget_ms);
}
