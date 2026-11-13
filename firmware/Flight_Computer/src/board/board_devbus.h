#ifndef STAR_BOARD_DEVBUS_H
#define STAR_BOARD_DEVBUS_H

/*
 * Binds a portable driver's dev_bus_t to one chip on board_spi: each xfer is
 * one locked chip-select frame with a BOARD_DEVBUS_FRAME_MS deadline, and
 * delay_ms is osDelay (>= ms, see board_devbus.c).
 */

#include "board_spi.h"
#include "dev_bus.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BOARD_DEVBUS_FRAME_MS 5U

dev_bus_t board_devbus(board_spi_device_t device);

#ifdef __cplusplus
}
#endif
#endif
