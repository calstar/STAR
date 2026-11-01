// Bit packing for spi_bus_esp (pure, host-tested): an spi_bus_if
// transaction as an ESP SPI transaction. Bytes go out MSB first.
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint8_t tx[4];
    int tx_bits;        // write phase (spi_transaction_t.length)
    int rx_bits;        // 3-wire: read phase after it (rxlength); 4-wire: = tx_bits
} spi_bus_frame_t;

void spi_bus_pack(int nbits, bool three_wire, int wr_bits, uint32_t tx, spi_bus_frame_t *f);
uint32_t spi_bus_unpack(const spi_bus_frame_t *f, const uint8_t rx[4]);
