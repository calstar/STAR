#ifndef STAR_BOARD_SPI_H
#define STAR_BOARD_SPI_H

/*
 * SPI bus layer: turns "talk to chip X" into chip-select + HAL_SPI calls on
 * the right bus, under a per-bus lock and a deadline.
 *
 *   SPI1  SX1262 radio        (mode 0, ~8 MHz)
 *   SPI2  W5500 Ethernet      (mode 0, ~16 MHz)
 *   SPI3  IMU, high-g, baro   (mode 3, ~8 MHz)  shared: the lock matters here
 *   SPI4  SD NAND             (mode 0, 250 kHz for SD init)
 *
 * Every call takes an absolute deadline (board_now_ms() based) and releases
 * chip-select and the bus lock before it returns, on every path.
 */

#include <stdbool.h>
#include <stdint.h>

#include "self_test_devices.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    BOARD_SPI_IMU = 0, /* ISM330DHCX, U4 */
    BOARD_SPI_HIGH_G,  /* H3LIS100DL, U3 */
    BOARD_SPI_BARO,    /* MS5611, U5 */
    BOARD_SPI_ETH,     /* W5500, U6 */
    BOARD_SPI_RADIO,   /* Wio-SX1262, U8 */
    BOARD_SPI_NAND,    /* ZDSD01GLGEAG SD NAND, U10 */
    BOARD_SPI_COUNT
} board_spi_device_t;

typedef enum {
    BOARD_SPI_OK = 0,
    BOARD_SPI_TIMEOUT,        /* lock, BUSY or transfer missed the deadline */
    BOARD_SPI_ERROR,          /* HAL reported a bus error */
    BOARD_SPI_NOT_CONFIGURED, /* device not routed, or bus mode/clock unfit */
} board_spi_status_t;

/* Create the bus locks. Call once, after osKernelInitialize(). */
bool board_spi_init(void);

/* True if the device has a bus and chip-select in the board table. */
bool board_spi_routed(board_spi_device_t device);

/* SPI mode (0..3) and actual SCK frequency of the device's bus. */
uint8_t board_spi_mode(board_spi_device_t device);
uint32_t board_spi_clock_hz(board_spi_device_t device);

/* Lock the device's bus until deadline_ms. Pair with board_spi_unlock(). */
board_spi_status_t board_spi_lock(board_spi_device_t device,
                                  uint32_t deadline_ms);
void board_spi_unlock(board_spi_device_t device);

/*
 * One chip-select frame on a bus the caller has locked: (radio: wait BUSY
 * low) CS low, len bytes full duplex, CS high. tx == NULL clocks out 0xFF;
 * rx == NULL discards the reply.
 */
board_spi_status_t board_spi_frame(board_spi_device_t device, const uint8_t* tx,
                                   uint8_t* rx, uint16_t len,
                                   uint32_t deadline_ms);

/* Lock, one frame, unlock. */
board_spi_status_t board_spi_transfer(board_spi_device_t device,
                                      const uint8_t* tx, uint8_t* rx,
                                      uint16_t len, uint32_t deadline_ms);

/* Clock out len bytes of 0xFF with chip-select HIGH (SD card wake-up).
 * Caller holds the lock. */
board_spi_status_t board_spi_idle_clocks(board_spi_device_t device,
                                         uint16_t len, uint32_t deadline_ms);

/* self_test_devices_t.exchange: maps self-test device IDs to this layer. */
self_test_reply_t board_spi_self_test_exchange(
    void* context, uint16_t device_id, uint8_t mode, uint32_t max_hz,
    self_test_spi_frame_t* frames, uint8_t count, uint32_t budget_ms);

#ifdef __cplusplus
}
#endif
#endif
