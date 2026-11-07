#ifndef STAR_EMMC_PORT_H
#define STAR_EMMC_PORT_H

/*
 * The seam between the flight log and the eMMC hardware.
 *
 * The log (emmc_log.c) never calls HAL. It sees the eMMC as an array of
 * 512-byte blocks through these callbacks. On the board they are
 * emmc_stm32.c (SDMMC1, 4-bit, IDMA); on a laptop they are a RAM disk
 * (tests/emmc). See EMMC-ARCHITECTURE.md.
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* JEDEC eMMC sector; DATA_SECTOR_SIZE = 0 (512 B) on THGBMTG5D1LBAIL. */
#define EMMC_BLOCK_SIZE 512U

typedef enum {
    EMMC_OK = 0,
    EMMC_ERR_IO,        /* the card or bus reported an error (CRC, status) */
    EMMC_ERR_TIMEOUT,   /* no completion within budget_ms */
    EMMC_ERR_NOT_READY, /* start() not run or failed */
    EMMC_ERR_PARAM      /* bad LBA/count/buffer (alignment, DMA reach) */
} emmc_status_t;

typedef struct {
    /*
     * Bring the card up once per power-up: release RST_n, identification at
     * <= 400 kHz, 4-bit bus, data clock <= 26 MHz (legacy timing). Report the
     * user-area size in blocks (EXT_CSD SEC_COUNT). The log calls it once;
     * the datasheet warns that repeated CMD0/CMD1 loops cause read disturb.
     */
    emmc_status_t (*start)(void* context, uint32_t* block_count);

    /*
     * Blocking transfers of `count` whole blocks at block address `lba`.
     * `buffer` is 32-byte aligned and DMA-reachable (on the H723: AXI SRAM,
     * never DTCM). Return only after the card is back in the transfer state
     * (writes: programming finished), or EMMC_ERR_TIMEOUT after budget_ms.
     */
    emmc_status_t (*read)(void* context, uint32_t lba, void* buffer,
                          uint32_t count, uint32_t budget_ms);
    emmc_status_t (*write)(void* context, uint32_t lba, const void* buffer,
                           uint32_t count, uint32_t budget_ms);

    /*
     * Optional (NULL = single context). Guards the log's chunk queue between
     * the tasks that append records and the task that writes. Held only for
     * memcpy-sized work, never across a transfer.
     */
    void (*lock)(void* context);
    void (*unlock)(void* context);
} emmc_port_t;

#ifdef __cplusplus
}
#endif
#endif
