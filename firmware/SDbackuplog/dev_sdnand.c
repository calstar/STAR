#include "dev_sdnand.h"

#include <stddef.h>

#define SD_POLL_BYTES 16U /* bytes polled between 1 ms sleeps */

/* CRC16-CCITT (XMODEM), the SD data-block CRC. */
static uint16_t crc16(const uint8_t* data, uint16_t len) {
    uint16_t crc = 0;
    for (uint16_t i = 0; i < len; i++) {
        crc ^= (uint16_t)(data[i] << 8);
        for (int j = 0; j < 8; j++) {
            crc = (crc & 0x8000U) ? (uint16_t)((crc << 1) ^ 0x1021U)
                                  : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

static int xfer(const sdnand_bus_t* bus, const uint8_t* tx, uint8_t* rx,
                uint16_t n) {
    return bus->bus.xfer(bus->bus.ctx, tx, rx, n) == DEV_OK ? DEV_OK
                                                            : DEV_ERR_BUS;
}

/* Clock bytes until one differs from `idle` (0xFF before a token, 0x00 while
 * busy), sleeping 1 ms every SD_POLL_BYTES, for at least timeout_ms. */
static int wait_not(const sdnand_bus_t* bus, uint8_t idle, uint32_t timeout_ms,
                    uint8_t* got) {
    for (uint32_t ms = 0; ms <= timeout_ms; ms++) {
        for (uint8_t i = 0; i < SD_POLL_BYTES; i++) {
            if (xfer(bus, NULL, got, 1) != DEV_OK) {
                return DEV_ERR_BUS;
            }
            if (*got != idle) {
                return DEV_OK;
            }
        }
        bus->bus.delay_ms(bus->bus.ctx, 1);
    }
    return DEV_ERR_TIMEOUT;
}

/* Send a command; DEV_OK only for R1 == 0 (ready, no error bits). */
static int command(const sdnand_bus_t* bus, sdnand_card_t* card, uint8_t index,
                   uint32_t argument) {
    uint8_t frame[6];
    sd_command_frame(frame, index, argument);
    card->last_r1 = 0xFF;
    if (xfer(bus, frame, NULL, 6) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    for (uint8_t i = 0; i < SD_NCR_MAX_BYTES; i++) {
        if (xfer(bus, NULL, &card->last_r1, 1) != DEV_OK) {
            return DEV_ERR_BUS;
        }
        if (sd_is_r1(card->last_r1)) {
            return card->last_r1 == 0U ? DEV_OK : DEV_ERR_DATA;
        }
    }
    return DEV_ERR_TIMEOUT;
}

/* Command, start token, len bytes, CRC16 check. Caller holds the bus. */
static int read_data(const sdnand_bus_t* bus, sdnand_card_t* card, uint8_t cmd,
                     uint32_t arg, uint8_t* out, uint16_t len) {
    uint8_t crc[2];
    int st = command(bus, card, cmd, arg);
    if (st == DEV_OK) {
        st = wait_not(bus, 0xFF, SD_READ_TIMEOUT_MS, &card->last_token);
    }
    if (st == DEV_OK && card->last_token != SD_DATA_TOKEN) {
        st = DEV_ERR_DATA; /* an error token (0000xxxx) */
    }
    if (st == DEV_OK) {
        st = xfer(bus, NULL, out, len);
    }
    if (st == DEV_OK) {
        st = xfer(bus, NULL, crc, 2);
    }
    if (st == DEV_OK && ((crc[0] << 8) | crc[1]) != crc16(out, len)) {
        st = DEV_ERR_DATA;
    }
    return st;
}

/* Token, one block, CRC16, data response, then wait out programming. */
static int send_block(const sdnand_bus_t* bus, sdnand_card_t* card,
                      uint8_t token, const uint8_t* data) {
    uint16_t c = crc16(data, SD_BLOCK_SIZE);
    uint8_t crc[2] = {(uint8_t)(c >> 8), (uint8_t)c};
    uint8_t b;
    int st = xfer(bus, &token, NULL, 1);
    if (st == DEV_OK) {
        st = xfer(bus, data, NULL, SD_BLOCK_SIZE);
    }
    if (st == DEV_OK) {
        st = xfer(bus, crc, NULL, 2);
    }
    if (st == DEV_OK) {
        st = wait_not(bus, 0xFF, SD_WRITE_TIMEOUT_MS, &card->last_token);
    }
    if (st == DEV_OK &&
        (card->last_token & SD_DATA_RESP_MASK) != SD_DATA_ACCEPTED) {
        st = DEV_ERR_DATA;
    }
    if (st == DEV_OK) {
        st = wait_not(bus, 0x00, SD_WRITE_TIMEOUT_MS, &b);
    }
    return st;
}

static bool usable(const sdnand_bus_t* bus, const sdnand_card_t* card) {
    return bus && bus->hold && bus->release && bus->bus.xfer &&
           bus->bus.delay_ms && card;
}

static uint32_t address(const sdnand_card_t* card, uint32_t block) {
    return card->high_capacity ? block : block * SD_BLOCK_SIZE;
}

/* Capacity in 512 B blocks from the CSD (v1: SDSC, v2: SDHC); 0 if bad. */
static uint32_t csd_block_count(const uint8_t csd[16]) {
    if (csd[0] >> 6 == 1U) {
        uint32_t c_size = ((uint32_t)(csd[7] & 0x3FU) << 16) |
                          ((uint32_t)csd[8] << 8) | csd[9];
        return (c_size + 1U) * 1024U;
    }
    if (csd[0] >> 6 != 0U) {
        return 0;
    }
    uint32_t bl_len = csd[5] & 0x0FU;
    uint32_t c_size = ((uint32_t)(csd[6] & 0x03U) << 10) |
                      ((uint32_t)csd[7] << 2) | (csd[8] >> 6);
    uint32_t mult = ((uint32_t)(csd[9] & 0x03U) << 1) | (csd[10] >> 7);
    if (bl_len < 9U || bl_len > 11U) {
        return 0;
    }
    return (c_size + 1U) << (mult + 2U + bl_len - 9U);
}

int sdnand_prepare(const sdnand_bus_t* bus, sdnand_card_t* card) {
    if (!usable(bus, card)) {
        return DEV_ERR_PARAM;
    }
    card->ready = false;
    uint8_t csd[16] = {0};
    int st = bus->hold(bus->bus.ctx);
    if (st != DEV_OK) {
        return st;
    }
    st = read_data(bus, card, SD_CMD9_SEND_CSD, 0, csd, sizeof csd);
    card->high_capacity = csd[0] >> 6 == 1U;
    if (st == DEV_OK && !card->high_capacity) {
        st = command(bus, card, SD_CMD16_SET_BLOCKLEN, SD_BLOCK_SIZE);
    }
    bus->release(bus->bus.ctx);
    if (st != DEV_OK) {
        return st;
    }
    card->block_count = csd_block_count(csd);
    card->ready = card->block_count > 0U;
    return card->ready ? DEV_OK : DEV_ERR_DATA;
}

int sdnand_read_block(const sdnand_bus_t* bus, sdnand_card_t* card,
                      uint32_t block, uint8_t out[SD_BLOCK_SIZE]) {
    if (!usable(bus, card) || !out || !card->ready ||
        block >= card->block_count) {
        return DEV_ERR_PARAM;
    }
    int st = bus->hold(bus->bus.ctx);
    if (st != DEV_OK) {
        return st;
    }
    st = read_data(bus, card, SD_CMD17_READ_SINGLE_BLOCK, address(card, block),
                   out, SD_BLOCK_SIZE);
    bus->release(bus->bus.ctx);
    return st;
}

/* CMD13: R1 and R2 must both be zero (no write error, no WP violation). */
static int send_status(const sdnand_bus_t* bus, sdnand_card_t* card) {
    uint8_t r2 = 0xFF;
    int st = bus->hold(bus->bus.ctx);
    if (st != DEV_OK) {
        return st;
    }
    st = command(bus, card, SD_CMD13_SEND_STATUS, 0);
    if (st == DEV_OK) {
        st = xfer(bus, NULL, &r2, 1);
    }
    bus->release(bus->bus.ctx);
    card->last_status = (uint16_t)((card->last_r1 << 8) | r2);
    return st == DEV_OK && r2 != 0U ? DEV_ERR_DATA : st;
}

int sdnand_write_blocks(const sdnand_bus_t* bus, sdnand_card_t* card,
                        uint32_t first_block, const uint8_t* data,
                        uint32_t count) {
    if (!usable(bus, card) || !data || !card->ready || count == 0U ||
        first_block >= card->block_count ||
        count > card->block_count - first_block) {
        return DEV_ERR_PARAM;
    }
    bool multi = count > 1U;
    int st = bus->hold(bus->bus.ctx);
    if (st != DEV_OK) {
        return st;
    }
    st = command(bus, card,
                 multi ? SD_CMD25_WRITE_MULTIPLE_BLOCK : SD_CMD24_WRITE_BLOCK,
                 address(card, first_block));
    if (st == DEV_OK) {
        for (uint32_t i = 0; st == DEV_OK && i < count; i++) {
            st = send_block(bus, card,
                            multi ? SD_TOKEN_START_MULTI : SD_DATA_TOKEN,
                            data + i * SD_BLOCK_SIZE);
        }
        if (multi) { /* stop even after a rejected block */
            uint8_t stop[2] = {SD_TOKEN_STOP_TRAN, 0xFF}, b;
            int end = xfer(bus, stop, NULL, 2);
            if (end == DEV_OK) {
                end = wait_not(bus, 0x00, SD_WRITE_TIMEOUT_MS, &b);
            }
            st = st == DEV_OK ? end : st;
        }
    }
    bus->release(bus->bus.ctx);
    return st == DEV_OK ? send_status(bus, card) : st;
}
