// spi_bus_if on an ESP32-P4 SPI host, for the board's setup bus: the
// AD9116 (3-wire, SDIO) and the ADRF6755 (4-wire, SDI on the same data
// line, its own SDO back) share SCLK and the data line; each has a chip
// select, driven as a plain GPIO so a chip-select-only pulse (the
// ADRF6755's SPI-mode lock) is possible. Mode 0, MSB first.
#pragma once
#include "esp_err.h"
#include "spi_bus_if.h"

#define SPI_BUS_ESP_MAX_DEV 4

typedef struct {
    int spi_host;               // e.g. SPI3_HOST
    int pin_sclk, pin_sdio, pin_miso;   // miso: 4-wire devices' data out (-1 if none)
    int pin_cs[SPI_BUS_ESP_MAX_DEV];    // chip select per device index
    int n_dev;
    int clock_hz;               // <= 20 MHz (ADRF6755); AD9116 allows 25
} spi_bus_esp_config_t;

esp_err_t spi_bus_esp_init(const spi_bus_esp_config_t *cfg, spi_bus_if_t *bus);
