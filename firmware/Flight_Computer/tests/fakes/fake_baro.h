#ifndef STAR_FAKE_BARO_H
#define STAR_FAKE_BARO_H

/*
 * A pretend MS5611 behind a dev_bus_t: PROM words, D1/D2 values, and the
 * datasheet rule that an ADC read with no conversion pending returns 0.
 */

#include <stdint.h>

#include "dev_bus.h"

typedef struct {
    uint16_t prom[8];
    uint32_t d1, d2;
    uint8_t pending; /* 0x48 / 0x58 / 0 */
    int fail;        /* every transfer fails while set */
    unsigned transfers;
    uint8_t last_cmd;
} fake_baro_t;

dev_bus_t fake_baro_bus(fake_baro_t* f);

/* Datasheet coefficients C1..C6 (p.8); word 0 and the serial part of word 7
 * made up, CRC nibble 3 computed independently with AN520. */
extern const uint16_t fake_baro_datasheet_prom[8];

#endif
