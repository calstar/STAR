#include "dev_ism330dhcx_mlc.h"

#include <stddef.h>

/*
 * MLC page helpers live beside the existing ism330_* driver style in
 * dev_ism330dhcx.c (SPI_READ bit7, write_reg/read_reg pattern).
 *
 * Register map (DS13012 / AN5392):
 *   FUNC_CFG_ACCESS 0x01 main  bit7=1 → embedded page
 *   EMB_FUNC_EN_B   0x05 emb   MLC_EN
 *   MLC_INT2        0x11 emb   route tree IRQs to INT2
 *   EMB_FUNC_ODR_CFG_C 0x60 emb MLC_ODR (AN5392 Table 1)
 *   EMB_FUNC_INIT_B 0x67 emb   MLC_INIT
 *   MLC0_SRC        0x70 emb   decision tree 1 result
 *   MD2_CFG         0x5F main  INT2_EMB_FUNC
 */

enum {
    REG_FUNC_CFG_ACCESS = 0x01,
    REG_MLC_INT2 = 0x11,
    REG_MD2_CFG = 0x5F,
    REG_MLC0_SRC = 0x70,
};

#define SPI_READ 0x80U
#define FUNC_CFG_ACCESS_EMB 0x80U
#define MD2_CFG_INT2_EMB_FUNC \
    0x02U                    /* bit1 INT2_EMB_FUNC per board brief / DS13012 */
#define MLC_INT2_TREE1 0x01U /* decision tree 1 / MLC0 */

static int write_reg(const dev_bus_t* bus, uint8_t reg, uint8_t value) {
    const uint8_t tx[2] = {reg, value};
    return bus->xfer(bus->ctx, tx, NULL, 2);
}

static int read_reg(const dev_bus_t* bus, uint8_t reg, uint8_t* value) {
    const uint8_t tx[2] = {(uint8_t)(SPI_READ | reg), 0};
    uint8_t rx[2];
    int err = bus->xfer(bus->ctx, tx, rx, 2);
    *value = rx[1];
    return err;
}

static void bus_lock(const dev_bus_t* bus) {
    /* Optional: board may extend dev_bus_t with lock/unlock for SPI3. */
#ifdef STAR_DEV_BUS_HAS_LOCK
    if (bus->lock) {
        bus->lock(bus->ctx);
    }
#else
    (void)bus;
#endif
}

static void bus_unlock(const dev_bus_t* bus) {
#ifdef STAR_DEV_BUS_HAS_LOCK
    if (bus->unlock) {
        bus->unlock(bus->ctx);
    }
#else
    (void)bus;
#endif
}

static int exit_embedded_page(const dev_bus_t* bus) {
    return write_reg(bus, REG_FUNC_CFG_ACCESS, 0x00);
}

static int force_int2_tree1(const dev_bus_t* bus) {
    uint8_t value = 0;

    bus_lock(bus);
    if (write_reg(bus, REG_FUNC_CFG_ACCESS, FUNC_CFG_ACCESS_EMB) != DEV_OK) {
        bus_unlock(bus);
        return DEV_ERR_BUS;
    }
    if (read_reg(bus, REG_MLC_INT2, &value) != DEV_OK) {
        (void)exit_embedded_page(bus);
        bus_unlock(bus);
        return DEV_ERR_BUS;
    }
    value = (uint8_t)(value | MLC_INT2_TREE1);
    if (write_reg(bus, REG_MLC_INT2, value) != DEV_OK ||
        exit_embedded_page(bus) != DEV_OK) {
        (void)exit_embedded_page(bus);
        bus_unlock(bus);
        return DEV_ERR_BUS;
    }
    bus_unlock(bus);

    /* Main page: set INT2_EMB_FUNC without clearing other MD2_CFG bits. */
    if (read_reg(bus, REG_MD2_CFG, &value) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    value = (uint8_t)(value | MD2_CFG_INT2_EMB_FUNC);
    if (write_reg(bus, REG_MD2_CFG, value) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    return DEV_OK;
}

int ism330_mlc_load(const dev_bus_t* bus, const ism330_mlc_write_t* writes,
                    size_t n) {
    if (!bus || !bus->xfer || !bus->delay_ms || (!writes && n > 0)) {
        return DEV_ERR_PARAM;
    }

    int in_emb = 0;
    for (size_t i = 0; i < n; ++i) {
        const ism330_mlc_write_t* w = &writes[i];
        if (w->op == ISM330_MLC_OP_WAIT_MS) {
            bus->delay_ms(bus->ctx, w->val);
            continue;
        }
        if (w->op != ISM330_MLC_OP_WRITE) {
            if (in_emb) {
                (void)exit_embedded_page(bus);
                bus_unlock(bus);
            }
            return DEV_ERR_PARAM;
        }

        /* Track FUNC_CFG_ACCESS transitions for SPI3 lock bracketing. */
        if (w->reg == REG_FUNC_CFG_ACCESS) {
            if ((w->val & FUNC_CFG_ACCESS_EMB) && !in_emb) {
                bus_lock(bus);
                in_emb = 1;
            }
            if (write_reg(bus, w->reg, w->val) != DEV_OK) {
                if (in_emb) {
                    (void)exit_embedded_page(bus);
                    bus_unlock(bus);
                }
                return DEV_ERR_BUS;
            }
            if (!(w->val & FUNC_CFG_ACCESS_EMB) && in_emb) {
                in_emb = 0;
                bus_unlock(bus);
            }
            continue;
        }

        if (write_reg(bus, w->reg, w->val) != DEV_OK) {
            if (in_emb) {
                (void)exit_embedded_page(bus);
                bus_unlock(bus);
            }
            return DEV_ERR_BUS;
        }
    }

    if (in_emb) {
        if (exit_embedded_page(bus) != DEV_OK) {
            bus_unlock(bus);
            return DEV_ERR_BUS;
        }
        bus_unlock(bus);
        in_emb = 0;
    }

    return force_int2_tree1(bus);
}

int ism330_mlc_read_class0(const dev_bus_t* bus, uint8_t* class_out) {
    if (!bus || !bus->xfer || !class_out) {
        return DEV_ERR_PARAM;
    }
    uint8_t value = 0;
    bus_lock(bus);
    if (write_reg(bus, REG_FUNC_CFG_ACCESS, FUNC_CFG_ACCESS_EMB) != DEV_OK ||
        read_reg(bus, REG_MLC0_SRC, &value) != DEV_OK ||
        exit_embedded_page(bus) != DEV_OK) {
        (void)exit_embedded_page(bus);
        bus_unlock(bus);
        return DEV_ERR_BUS;
    }
    bus_unlock(bus);
    *class_out = value;
    return DEV_OK;
}
