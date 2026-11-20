#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef enum { BOARD_SPI_ETH } board_spi_device_t;
typedef enum { BOARD_SPI_OK, BOARD_SPI_TIMEOUT } board_spi_status_t;
bool board_spi_routed(board_spi_device_t d);
uint8_t board_spi_mode(board_spi_device_t d);
uint32_t board_spi_clock_hz(board_spi_device_t d);
board_spi_status_t board_spi_lock(board_spi_device_t d, uint32_t deadline);
void board_spi_unlock(board_spi_device_t d);
void board_spi_select(board_spi_device_t d);
void board_spi_deselect(board_spi_device_t d);
board_spi_status_t board_spi_shift(board_spi_device_t d, const uint8_t* tx,
                                   uint8_t* rx, uint16_t n, uint32_t deadline);
