#ifndef STAR_DEV_ISM330DHCX_MLC_H
#define STAR_DEV_ISM330DHCX_MLC_H

/*
 * ISM330DHCX Machine Learning Core loader (pad/idle hint path).
 *
 * Complements dev_ism330dhcx.h — call AFTER ism330_init() so CTRL1_XL /
 * CTRL2_G stay 0x74 / 0x71 (±16 g / ±4000 dps @ 833 Hz) unless the .ucf
 * intentionally rewrites the same values.
 *
 * Board brief:
 *   INT1 / PD0 = data-ready (unchanged; INT1_CTRL from ism330_init)
 *   INT2 / PD1 = MLC class-change IRQ (MLC_INT2 tree1 + MD2_CFG INT2_EMB_FUNC)
 *   SPI3 shared with baro / high-g — hold bus lock across FUNC_CFG_ACCESS
 *     embedded-page windows so peers never see the wrong map.
 *
 * Safety: MLC is a hint only. Do not arm/fire pyro or drive launch/apogee
 * from MLC0_SRC / INT2.
 *
 * Refs: DS13012 Rev 7; AN5392 Rev 5 (MLC ODR Table 1, MLC0_SRC, MLC_INT2,
 * MD2_CFG INT2_EMB_FUNC, .ucf load path).
 */

#include <stddef.h>
#include <stdint.h>

#include "dev_bus.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
    ISM330_MLC_OP_WRITE = 0,
    ISM330_MLC_OP_WAIT_MS = 1,
};

typedef struct {
    uint8_t op;  /* ISM330_MLC_OP_WRITE or ISM330_MLC_OP_WAIT_MS */
    uint8_t reg; /* register for WRITE; ignored for WAIT */
    uint8_t val; /* value for WRITE; milliseconds for WAIT (use multiple WAITs
                    if >255) */
} ism330_mlc_write_t;

/*
 * Replay a .ucf-derived write list, then force tree-1 → INT2 routing:
 *   emb: MLC_INT2 |= tree1
 *   main: MD2_CFG |= INT2_EMB_FUNC
 * Always returns the device to the main register page on success.
 * On bus error, best-effort exit embedded page before returning DEV_ERR_*.
 *
 * If bus->lock / bus->unlock are non-NULL (board SPI3 mutex), they are held
 * across each contiguous embedded-page section. If NULL, caller must ensure
 * exclusive SPI3 access (host tests use fake_regs without a lock).
 */
int ism330_mlc_load(const dev_bus_t* bus, const ism330_mlc_write_t* writes,
                    size_t n);

/* Read MLC0_SRC (embedded 0x70) with page brackets + optional bus lock. */
int ism330_mlc_read_class0(const dev_bus_t* bus, uint8_t* class_out);

#ifdef __cplusplus
}
#endif
#endif
