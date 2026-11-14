#include "spi_bus_pack.h"

static void be32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }

void spi_bus_pack(int nbits, bool three_wire, int wr_bits, uint32_t tx, spi_bus_frame_t *f)
{
    f->rx_bits = 0;
    if (three_wire && wr_bits < nbits) {
        // the top wr_bits bits are written, the rest of the frame is read
        f->tx_bits = wr_bits;
        f->rx_bits = nbits - wr_bits;
        be32(f->tx, wr_bits ? (tx >> (nbits - wr_bits)) << (32 - wr_bits) : 0);
    } else {
        f->tx_bits = nbits;
        f->rx_bits = three_wire ? 0 : nbits;          // 4-wire: full duplex
        be32(f->tx, tx << (32 - nbits));
    }
}

uint32_t spi_bus_unpack(const spi_bus_frame_t *f, const uint8_t rx[4])
{
    if (!f->rx_bits) return 0;
    uint32_t v = ((uint32_t)rx[0] << 24) | ((uint32_t)rx[1] << 16) | ((uint32_t)rx[2] << 8) | rx[3];
    return v >> (32 - f->rx_bits);
}
