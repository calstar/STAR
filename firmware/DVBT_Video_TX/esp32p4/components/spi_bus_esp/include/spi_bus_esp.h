// spi_bus_if on an ESP32-P4 SPI host, for the AD9116's bus (3-wire, SDIO;
// 4-wire devices are supported too) with GPIO chip selects, so a
// chip-select-only pulse is possible. Mode 0, MSB first. (The ADRF6755 has
// its own lines and is bit-banged: spi_bitbang.h.)
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
