#ifndef STAR_EMMC_LOG_H
#define STAR_EMMC_LOG_H

/*
 * The flight log on the eMMC (U9, THGBMTG5D1LBAIL, 4 GB).
 *
 * What it does
 *   Recording starts when the state machine enters ARMED and continues
 *   through LAUNCHED and RECOVERY; Un-arm closes the session. Self-test and
 *   Idle never touch the eMMC. (flight_state_logs_to_emmc.)
 *
 * How (see EMMC-ARCHITECTURE.md for why)
 *   - Raw blocks, no filesystem. An append-only run of self-checking 512 B
 *     blocks: each carries the volume epoch, its own position, its session
 *     and a CRC32. Nothing on the card is rewritten in place, so a power cut
 *     can only lose the tail that was in flight.
 *   - The end of the log is found at mount by binary search over "is this
 *     block valid and where it claims to be" (~23 reads for 4 GB), so there
 *     is no directory or pointer block to wear out or tear.
 *   - Two sides that never wait on each other. emmc_log_append() (sensor
 *     tasks) copies a record into a RAM chunk and returns. emmc_log_service()
 *     (one low-priority writer task) does every card transfer, one 16 KB
 *     chunk per call. If the card stalls and every chunk is full, records
 *     are dropped and counted, and a DROPPED record says how many.
 *   - All card I/O, including bring-up and mount, happens in
 *     emmc_log_service(), never in the caller of emmc_log_on_state().
 *
 * On-disk layout (little-endian)
 *   LBA 0             superblock: magic, layout version, epoch, data start,
 *                     capacity, CRC32
 *   LBA data_start..  log blocks, block k at data_start + k:
 *       0  u32 magic   EMMC_LOG_BLOCK_MAGIC
 *       4  u32 epoch   changes on every format; older blocks are invalid
 *       8  u32 seq     = k (its own position)
 *      12  u32 session numbered from 1 across power cycles
 *      16  u8  kind    EMMC_LOG_KIND_DATA or _PAD
 *      17  u8  0
 *      18  u16 used    payload bytes in use
 *      20  payload     records, never split across blocks
 *     508  u32 crc32   over bytes 0..507
 *   record: u8 type, u8 len, u32 t_ms, len bytes of data
 */

#include <stdbool.h>
#include <stdint.h>

#include "emmc_port.h"
#include "flight_state.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 16 KB: OPTIMAL_WRITE_SIZE (EXT_CSD[265] = 4, in 4 KB units). */
#define EMMC_LOG_CHUNK_BLOCKS 32U
#define EMMC_LOG_CHUNK_BYTES (EMMC_LOG_CHUNK_BLOCKS * EMMC_BLOCK_SIZE)
#define EMMC_LOG_MAX_CHUNKS 16U

#define EMMC_LOG_HEADER_BYTES 20U
#define EMMC_LOG_PAYLOAD_BYTES (EMMC_BLOCK_SIZE - EMMC_LOG_HEADER_BYTES - 4U)
#define EMMC_LOG_RECORD_HEADER_BYTES 6U

#define EMMC_LOG_SUPER_MAGIC 0x31425353UL /* "SSB1" */
#define EMMC_LOG_BLOCK_MAGIC 0x31474C53UL /* "SLG1" */
#define EMMC_LOG_LAYOUT_VERSION 1U

#define EMMC_LOG_KIND_DATA 1U
#define EMMC_LOG_KIND_PAD 2U

/* Record types below 0x10 belong to the log; sensors use 0x10 and up. */
#define EMMC_REC_SESSION_START 0x01U /* data: u8 state entered */
#define EMMC_REC_STATE 0x02U         /* data: u8 from, u8 to */
#define EMMC_REC_SESSION_END 0x03U   /* data: u8 state entered */
#define EMMC_REC_DROPPED 0x04U       /* data: u32 records lost before this */
#define EMMC_REC_USER_FIRST 0x10U

/* Default data start: 8192 blocks = 4 MB = one HC erase group (EXT_CSD). */
#define EMMC_LOG_DEFAULT_DATA_START 8192UL

typedef struct {
    uint8_t bytes[EMMC_LOG_CHUNK_BYTES];
} emmc_log_chunk_t;

typedef struct {
    uint32_t data_start_lba;    /* first log block; > 0 (LBA 0 is super) */
    uint32_t flush_interval_ms; /* max age of a partly filled chunk */
    uint32_t read_budget_ms;    /* per read() call */
    uint32_t write_budget_ms;   /* per write() call (one chunk) */
    uint8_t write_attempts;     /* tries per chunk before FAULT */
} emmc_log_config_t;

typedef enum {
    EMMC_DISK_UNMOUNTED = 0, /* not brought up yet (nothing armed so far) */
    EMMC_DISK_MOUNTED,
    EMMC_DISK_FULL, /* no room for another chunk; recording stops */
    EMMC_DISK_FAULT /* start, mount or writes failed; recording stops */
} emmc_disk_state_t;

typedef struct {
    uint32_t records;        /* records accepted into RAM */
    uint32_t dropped;        /* records refused while recording (no room) */
    uint32_t chunks_written; /* chunks on the card */
    uint32_t chunks_lost;    /* sealed chunks discarded (FULL/FAULT) */
    uint32_t write_errors;   /* failed write() calls, retried or not */
    uint32_t pad_blocks;     /* blocks padded out by flushes */
} emmc_log_stats_t;

typedef enum {
    EMMC_CHUNK_FREE = 0,
    EMMC_CHUNK_FILLING,
    EMMC_CHUNK_READY
} emmc_chunk_state_t;

typedef struct {
    /* Fixed at init. */
    emmc_port_t port;
    void* context;
    emmc_log_config_t config;
    emmc_log_chunk_t* chunks;
    uint8_t chunk_count;
    uint8_t* scratch; /* one block, for mount reads */

    /* Producer side (under lock). */
    bool recording;
    uint32_t arm_index; /* arms since power-up, from 1 */
    bool has_fill;
    uint8_t fill_chunk;
    uint8_t fill_block;
    uint16_t fill_offset;
    bool fill_aged;           /* the writer has seen this chunk filling */
    uint32_t fill_started_ms; /* when it first saw it (writer's clock) */
    uint32_t unreported_drops;
    emmc_chunk_state_t chunk_state[EMMC_LOG_MAX_CHUNKS];
    uint32_t chunk_arm[EMMC_LOG_MAX_CHUNKS];

    /* Writer side. */
    uint8_t write_chunk;
    uint8_t write_tries;
    emmc_disk_state_t disk;
    uint32_t capacity; /* blocks, from start() */
    uint32_t epoch;
    uint32_t head;         /* next LBA to write */
    uint32_t base_session; /* last session on the card at mount */

    emmc_log_stats_t stats;
} emmc_log_t;

/* Defaults: data start 4 MB, flush 1 s, read 100 ms, write 1 s, 3 tries. */
emmc_log_config_t emmc_log_default_config(void);

/*
 * No I/O. `chunks` (chunk_count of 2..EMMC_LOG_MAX_CHUNKS) and `scratch`
 * (EMMC_BLOCK_SIZE bytes) must stay valid and be DMA-reachable and 32-byte
 * aligned on the board. Returns EMMC_ERR_PARAM on a bad argument.
 */
emmc_status_t emmc_log_init(emmc_log_t* log, const emmc_port_t* port,
                            void* context, const emmc_log_config_t* config,
                            emmc_log_chunk_t* chunks, uint8_t chunk_count,
                            uint8_t* scratch);

/*
 * Tell the log about a state change. Entering a recording state from a
 * non-recording one opens a session; leaving closes it and flushes; a change
 * between recording states is logged as a STATE record. No I/O. Returns
 * false if recording should have started but the disk is FULL or FAULT.
 */
bool emmc_log_on_state(emmc_log_t* log, flight_state_t from, flight_state_t to,
                       uint32_t now_ms);

/*
 * Copy one record into RAM. False when not recording (Self-test, Idle, a
 * FULL/FAULT disk) or when no chunk is free (counted in stats.dropped).
 * `type` >= EMMC_REC_USER_FIRST for sensor data. Never blocks on the card.
 */
bool emmc_log_append(emmc_log_t* log, uint8_t type, uint32_t t_ms,
                     const void* data, uint8_t len);

/* Seal the partly filled chunk now (padding the rest) so it gets written. */
void emmc_log_flush(emmc_log_t* log);

/*
 * The writer. Seals a chunk older than flush_interval_ms, brings the card up
 * and mounts on first need, then writes at most one chunk. Call it in a loop
 * from one task. Returns the result of the I/O it did (EMMC_OK if none).
 */
emmc_status_t emmc_log_service(emmc_log_t* log, uint32_t now_ms);

/* Sealed chunks waiting for the card (0 = everything is on the card). */
uint8_t emmc_log_backlog(const emmc_log_t* log);

/* IEEE CRC-32 (reflected 0xEDB88320, init/xorout 0xFFFFFFFF). */
uint32_t emmc_log_crc32(const void* data, uint32_t len);

/*
 * Reading the log back (USB, PROTOCOL.md section 6). Each call does card
 * I/O: run it where emmc_log_service() runs (the writer task), never while
 * recording. None of them writes anything.
 */
typedef struct {
    uint32_t session;     /* numbered from 1 across power cycles */
    uint32_t first_block; /* log block index (LBA - data_start) */
    uint32_t blocks;
    uint32_t duration_ms; /* last record's t_ms - first's */
} emmc_log_session_t;

/* Mount for reading, as Arm would, except a card with no log volume is
 * left as it is (never formatted) and reads as empty. Recording: busy. */
emmc_status_t emmc_log_open(emmc_log_t* log);
/* Log blocks in use (0 until mounted or on an empty card). */
uint32_t emmc_log_used(const emmc_log_t* log);
/* Sessions oldest first, from the start-th: up to max of them into out
 * (*n), and how many there are in all (*total). */
emmc_status_t emmc_log_sessions(emmc_log_t* log, uint32_t start,
                                emmc_log_session_t* out, uint32_t max,
                                uint32_t* n, uint32_t* total);
/* Raw log block k (< emmc_log_used) into buf (one block, DMA-reachable
 * on the board). */
emmc_status_t emmc_log_read(emmc_log_t* log, uint32_t k, uint8_t* buf);

#ifdef __cplusplus
}
#endif
#endif
