#ifndef STAR_SDLOG_CORE_H
#define STAR_SDLOG_CORE_H

/*
 * The backup flight log on the SD NAND (U10, 1 Gbit)
 * Same on-disk layout as the eMMC log (emmc_log.h). The port is an
 * emmc_port_t (on the board: sdlog_stm32.c over dev_sdnand).
 */

#include <stdbool.h>
#include <stdint.h>

#include "emmc_port.h"
#include "flight_state.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SDLOG_BLOCK_SIZE 512U
#define SDLOG_HEADER_BYTES 20U
#define SDLOG_PAYLOAD_BYTES (SDLOG_BLOCK_SIZE - SDLOG_HEADER_BYTES - 4U)
#define SDLOG_RAM_BLOCKS 16U
#define SDLOG_MAX_BURST 8U
#define SDLOG_DATA_START 64U /* first log block; block 0 is the superblock */
#define SDLOG_FLUSH_MS 1000U /* max age of a partly filled block */
#define SDLOG_WRITE_ATTEMPTS 3U

#define SDLOG_SUPER_MAGIC 0x31445353UL /* "SSD1" */
#define SDLOG_BLOCK_MAGIC 0x314C4453UL /* "SDL1" */
#define SDLOG_LAYOUT_VERSION 1U

typedef enum {
    SDLOG_UNMOUNTED = 0,
    SDLOG_MOUNTED,
    SDLOG_FULL,
    SDLOG_FAULT
} sdlog_disk_t;

typedef struct {
    uint32_t records, dropped;     /* accepted into RAM / refused (no room) */
    uint32_t blocks_written, blocks_lost, write_errors;
} sdlog_stats_t;

typedef struct {
    emmc_port_t port;
    void* context;
    uint8_t ring[SDLOG_RAM_BLOCKS][SDLOG_BLOCK_SIZE];
    uint32_t ring_arm[SDLOG_RAM_BLOCKS];
    uint8_t scratch[SDLOG_BLOCK_SIZE];

    /* Producer side (under lock): sealed blocks start at tail; when has_fill,
     * block (tail + ready) % SDLOG_RAM_BLOCKS is filling. */
    bool recording;
    uint32_t arm_index;
    uint8_t tail, ready;
    bool has_fill, fill_aged;
    uint16_t fill_offset;
    uint32_t fill_started_ms;
    uint32_t unreported_drops;

    /* Writer side. */
    uint8_t write_tries;
    sdlog_disk_t disk;
    uint32_t capacity, epoch, head, base_session;

    sdlog_stats_t stats;
} sdlog_t;

/* No I/O. False on a bad port (lock and unlock must be both set or both
 * NULL). */
bool sdlog_init(sdlog_t* log, const emmc_port_t* port, void* context);

/* As emmc_log_on_state(). No I/O. */
bool sdlog_on_state(sdlog_t* log, flight_state_t from, flight_state_t to,
                    uint32_t now_ms);

/* Copy a record into RAM. False for types the backup does not keep, when not
 * recording, or when the ring is full (counted). Never blocks on the card. */
bool sdlog_append(sdlog_t* log, uint8_t type, uint32_t t_ms, const void* data,
                  uint8_t len);

/* The writer: ages the filling block, mounts on first need, writes at most
 * one burst. Returns the result of the I/O it did (EMMC_OK if none). */
emmc_status_t sdlog_service(sdlog_t* log, uint32_t now_ms);

/* Sealed blocks waiting for the card. */
uint8_t sdlog_backlog(const sdlog_t* log);

#ifdef __cplusplus
}
#endif
#endif
