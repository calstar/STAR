#include <stddef.h>
#include "spi_bitbang.h"

static void half(const spi_bitbang_t *bb)
{
    if (bb->half) bb->half(bb->ctx);
}

static esp_err_t xfer(void *ctx, int dev, int nbits, bool three_wire, int wr_bits, uint32_t tx, uint32_t *rx)
{
    const spi_bitbang_t *bb = ctx;
    (void)wr_bits;
    if (dev != 0 || three_wire || nbits < 1 || nbits > 32) return ESP_ERR_INVALID_ARG;
    uint32_t in = 0;
    bb->set(bb->ctx, SPI_BB_CS, false);
    half(bb);
    for (int i = nbits - 1; i >= 0; i--) {
        bb->set(bb->ctx, SPI_BB_SDI, (tx >> i) & 1);
        half(bb);
        in = (in << 1) | (bb->get_sdo(bb->ctx) ? 1u : 0u);
        bb->set(bb->ctx, SPI_BB_CLK, true);
        half(bb);
        bb->set(bb->ctx, SPI_BB_CLK, false);
    }
    half(bb);
    bb->set(bb->ctx, SPI_BB_CS, true);
    bb->set(bb->ctx, SPI_BB_SDI, false);
    half(bb);
    if (rx) *rx = in;
    return ESP_OK;
}

static esp_err_t cs_pulse(void *ctx, int dev)
{
    const spi_bitbang_t *bb = ctx;
    if (dev != 0) return ESP_ERR_INVALID_ARG;
    bb->set(bb->ctx, SPI_BB_CS, false);
    half(bb);
    half(bb);
    bb->set(bb->ctx, SPI_BB_CS, true);
    half(bb);
    half(bb);
    return ESP_OK;
}

void spi_bitbang_bus(const spi_bitbang_t *bb, spi_bus_if_t *bus)
{
    bus->xfer = xfer;
    bus->cs_pulse = cs_pulse;
    bus->ctx = (void *)bb;
}
