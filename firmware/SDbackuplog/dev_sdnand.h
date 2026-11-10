#ifndef STAR_DEV_SDNAND_H
#define STAR_DEV_SDNAND_H

/*
 * Block I/O on the ZDSD01GLGEAG SD NAND (U10) in SD SPI mode. The card must
 * already be initialized (CMD0/8/ACMD41/58: board_sd_nand_probe) and the bus
 * at <= SD_DEFAULT_SPEED_MAX_HZ. Portable: no HAL, host-tested on a fake card.
 */

#include <stdbool.h>
#include <stdint.h>

#include "dev_bus.h"
#include "sd_spi.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SD_CMD9_SEND_CSD 9U
#define SD_CMD13_SEND_STATUS 13U
#define SD_CMD16_SET_BLOCKLEN 16U
#define SD_CMD17_READ_SINGLE_BLOCK 17U
#define SD_CMD24_WRITE_BLOCK 24U
#define SD_CMD25_WRITE_MULTIPLE_BLOCK 25U

#define SD_TOKEN_START_MULTI 0xFCU
#define SD_TOKEN_STOP_TRAN 0xFDU
#define SD_DATA_RESP_MASK 0x1FU
#define SD_DATA_ACCEPTED 0x05U

#define SD_NCR_MAX_BYTES 8U
#define SD_READ_TIMEOUT_MS 100U  /* SD spec 4.6.2.1 */
#define SD_WRITE_TIMEOUT_MS 250U /* SD spec 4.6.2.2 */
#define SD_INIT_MAX_HZ 400000U
#define SD_DEFAULT_SPEED_MAX_HZ 25000000U
#define SD_BLOCK_SIZE 512U

/*
 * A dev_bus_t whose xfer() moves bytes without touching chip-select, plus
 * hold() (lock the bus, CS low) and release() (CS high, 8 clocks, unlock):
 * an SD command spans several xfer() calls with CS held low.
 */
typedef struct {
    dev_bus_t bus;
    int (*hold)(void* ctx);
    void (*release)(void* ctx);
} sdnand_bus_t;

typedef struct {
    bool ready;
    bool high_capacity; /* CSD v2: block addressing */
    uint32_t block_count;
    uint8_t last_r1;      /* diagnostics: last R1, token/data response, */
    uint8_t last_token;   /* and CMD13 status (R1 << 8 | R2) */
    uint16_t last_status;
} sdnand_card_t;

/* CSD (capacity, addressing), CMD16 512 on standard capacity. DEV_*. */
int sdnand_prepare(const sdnand_bus_t* bus, sdnand_card_t* card);
int sdnand_read_block(const sdnand_bus_t* bus, sdnand_card_t* card,
                      uint32_t block, uint8_t out[SD_BLOCK_SIZE]);
/* CMD24 for one block, CMD25 for more; then CMD13 must report no error. */
int sdnand_write_blocks(const sdnand_bus_t* bus, sdnand_card_t* card,
                        uint32_t first_block, const uint8_t* data,
                        uint32_t count);

#ifdef __cplusplus
}
#endif
#endif
