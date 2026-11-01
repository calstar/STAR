// A generic SPI transaction interface, so chip drivers (AD9116, ADRF6755,
// ...) do not care whether they sit on an ESP32 SPI port or behind the
// FPGA's setup-bus bridge.
//
// One transaction: nbits (1..32) bits, MSB first, mode 0. tx is
// right-aligned (the low nbits bits are sent). In 3-wire mode the master
// drives the first wr_bits bits and then listens on the same line; the
// bits clocked in are returned right-aligned in *rx (rx may be NULL).
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct spi_bus_if {
    esp_err_t (*xfer)(void *ctx, int dev, int nbits, bool three_wire, int wr_bits,
                      uint32_t tx, uint32_t *rx);
    void *ctx;
} spi_bus_if_t;

static inline esp_err_t spi_bus_xfer(const spi_bus_if_t *bus, int dev, int nbits,
                                     bool three_wire, int wr_bits, uint32_t tx, uint32_t *rx)
{
    return bus->xfer(bus->ctx, dev, nbits, three_wire, wr_bits, tx, rx);
}
