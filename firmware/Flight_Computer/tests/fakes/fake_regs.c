#include "fake_regs.h"

#include <string.h>

void fake_regs_init(fake_regs_t* f, bool ms_bit) {
    memset(f, 0, sizeof(*f));
    f->ms_bit = ms_bit;
    f->fail_after = -1;
}

static int xfer(void* ctx, const uint8_t* tx, uint8_t* rx, uint16_t len) {
    fake_regs_t* f = ctx;
    if (f->fail_after >= 0 && (int)f->transfers >= f->fail_after) {
        return DEV_ERR_BUS;
    }
    f->transfers++;
    if (!tx || len < 1) {
        return DEV_OK;
    }
    bool read = (tx[0] & 0x80U) != 0;
    uint8_t addr = (uint8_t)(tx[0] & (f->ms_bit ? 0x3FU : 0x7FU));
    bool inc = f->ms_bit ? (tx[0] & 0x40U) != 0 : true;
    if (rx) {
        rx[0] = 0xEE;
    }
    for (uint16_t i = 1; i < len; ++i) {
        uint8_t a = (uint8_t)((addr + (inc ? i - 1U : 0U)) & 0x7FU);
        if (read) {
            if (rx) {
                rx[i] = f->regs[a];
            }
            if (a == f->self_clear_reg && f->self_clear_bits &&
                f->clear_after_reads && --f->clear_after_reads == 0) {
                f->regs[a] &= (uint8_t)~f->self_clear_bits;
            }
        } else {
            uint8_t keep = f->stuck[a];
            f->regs[a] = (uint8_t)((f->regs[a] & keep) | (tx[i] & ~keep));
            /* A real self-clearing bit clears after every write that sets
             * it (ISM330DHCX SW_RESET, p.51), not only the first. */
            if (a == f->self_clear_reg && (tx[i] & f->self_clear_bits) &&
                f->self_clear_rearm) {
                f->clear_after_reads = f->self_clear_rearm;
            }
            if (f->writes < sizeof(f->write_reg)) {
                f->write_reg[f->writes] = a;
                f->write_val[f->writes] = tx[i];
            }
            f->writes++;
        }
    }
    return DEV_OK;
}

static void delay_ms(void* ctx, uint32_t ms) {
    ((fake_regs_t*)ctx)->delays_ms += ms;
}

dev_bus_t fake_regs_bus(fake_regs_t* f) {
    dev_bus_t bus = {xfer, delay_ms, f};
    return bus;
}
