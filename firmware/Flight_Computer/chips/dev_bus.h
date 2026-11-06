#ifndef STAR_DEV_BUS_H
#define STAR_DEV_BUS_H

/*
 * The only way a portable chip driver (chips/) touches hardware. The board
 * binds it to board_spi (one chip, one deadline); host tests bind it to a
 * scripted fake. Drivers never include HAL or RTOS headers.
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    DEV_OK = 0,
    DEV_ERR_BUS = -1,     /* transfer failed or timed out */
    DEV_ERR_ID = -2,      /* identity register did not match */
    DEV_ERR_VERIFY = -3,  /* a configuration register did not read back */
    DEV_ERR_TIMEOUT = -4, /* the chip did not finish within its bound */
    DEV_ERR_PARAM = -5,   /* caller bug */
    DEV_ERR_DATA = -6,    /* chip answered with invalid contents */
};

typedef struct {
    /* One chip-select frame: len bytes out of tx, len bytes into rx (either
     * may be NULL: NULL tx clocks 0xFF, NULL rx discards). DEV_OK or
     * DEV_ERR_BUS. */
    int (*xfer)(void* ctx, const uint8_t* tx, uint8_t* rx, uint16_t len);
    /* Sleep at least ms milliseconds. */
    void (*delay_ms)(void* ctx, uint32_t ms);
    void* ctx;
} dev_bus_t;

#ifdef __cplusplus
}
#endif
#endif
