#ifndef STAR_FAKE_REGS_H
#define STAR_FAKE_REGS_H

/*
 * A pretend ST register-file sensor behind a dev_bus_t, for host tests.
 * First byte of a frame: bit 7 = read, the rest the address. Multi-byte
 * frames auto-increment the address: always (ISM330DHCX, IF_INC), or only
 * when bit 6 of the command is set (H3LIS100DL "MS" bit).
 */

#include <stdbool.h>
#include <stdint.h>

#include "dev_bus.h"

typedef struct {
    uint8_t regs[128];
    bool ms_bit;    /* address in bits 5:0, bit 6 enables increment */
    int fail_after; /* transfers allowed before every one fails (-1 never) */
    uint8_t self_clear_reg; /* these bits clear after clear_after_reads */
    uint8_t self_clear_bits;
    unsigned clear_after_reads;
    uint8_t stuck[128]; /* bits that ignore writes (read-back mismatch) */
    unsigned transfers;
    unsigned writes;
    uint8_t write_reg[64];
    uint8_t write_val[64];
    unsigned delays_ms;
} fake_regs_t;

void fake_regs_init(fake_regs_t* f, bool ms_bit);
dev_bus_t fake_regs_bus(fake_regs_t* f);

#endif
