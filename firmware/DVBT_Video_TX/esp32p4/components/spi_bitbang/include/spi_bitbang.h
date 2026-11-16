// spi_bus_if over three GPIO outputs and one input, bit-banged: one 4-wire
// device (dev 0), mode 0, MSB first. The board's ADRF6755 has its own CLK
// and SDI lines (only its SDO is shared, with the AD9116's bus, where nothing
// else drives it), so it cannot sit on the AD9116's SPI host; its traffic is
// a few hundred 24-bit writes per relock, which bit-banging at a few MHz
// does in well under a millisecond.
//
// Pure C over pin callbacks: the ESP32-P4 binds them to its GPIOs, the
// end-to-end test to the ADRF6755 model's pins. The callbacks only set
// levels; configuring the pins (and leaving them undriven while the chip is
// unpowered) is the board's job.
#pragma once
#include <stdbool.h>
#include "spi_bus_if.h"

typedef enum { SPI_BB_CLK, SPI_BB_SDI, SPI_BB_CS } spi_bb_pin_t;

typedef struct {
    void (*set)(void *ctx, spi_bb_pin_t pin, bool level);
    bool (*get_sdo)(void *ctx);
    void (*half)(void *ctx);            // wait half a clock period; may be NULL
    void *ctx;
} spi_bitbang_t;

// Fill bus with the transport; bb must outlive it. Each transaction: CS low,
// per bit SDI then (SDO sampled) CLK high, CLK low; CS high. The ADRF6755
// changes SDO on the falling edge, so it is stable when sampled. cs_pulse:
// CS low then high with the clock idle (the ADRF6755's SPI-mode lock).
void spi_bitbang_bus(const spi_bitbang_t *bb, spi_bus_if_t *bus);
