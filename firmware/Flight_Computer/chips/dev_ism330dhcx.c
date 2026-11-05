#include "dev_ism330dhcx.h"

#include <stddef.h>

enum {
    REG_COUNTER_BDR_REG1 = 0x0B,
    REG_INT1_CTRL = 0x0D,
    REG_WHO_AM_I = 0x0F,
    REG_CTRL1_XL = 0x10,
    REG_CTRL2_G = 0x11,
    REG_CTRL3_C = 0x12,
    REG_CTRL4_C = 0x13,
    REG_OUT_TEMP_L = 0x20,
};

#define SPI_READ 0x80U       /* bit 7 = 1: read (p.21) */
#define CTRL3_SW_RESET 0x01U /* self-clearing (p.51) */
#define RESET_POLLS 10U      /* 1 ms apart; reset takes far less */

static const struct {
    uint8_t reg;
    uint8_t value;
} config[] = {
    {REG_CTRL3_C, 0x44},          /* BDU + IF_INC */
    {REG_CTRL4_C, 0x04},          /* I2C_disable */
    {REG_CTRL1_XL, 0x74},         /* 833 Hz, +-16 g */
    {REG_CTRL2_G, 0x71},          /* 833 Hz, +-4000 dps */
    {REG_COUNTER_BDR_REG1, 0x80}, /* pulsed data-ready */
    {REG_INT1_CTRL, 0x01},        /* INT1 = accelerometer data-ready */
};

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

int ism330_init(const dev_bus_t* bus) {
    if (!bus || !bus->xfer || !bus->delay_ms) {
        return DEV_ERR_PARAM;
    }
    uint8_t value = 0;
    if (read_reg(bus, REG_WHO_AM_I, &value) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    if (value != ISM330_WHO_AM_I_VALUE) {
        return DEV_ERR_ID;
    }
    if (write_reg(bus, REG_CTRL3_C, CTRL3_SW_RESET) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    unsigned polls = 0;
    do {
        bus->delay_ms(bus->ctx, 1);
        if (read_reg(bus, REG_CTRL3_C, &value) != DEV_OK) {
            return DEV_ERR_BUS;
        }
    } while ((value & CTRL3_SW_RESET) && ++polls < RESET_POLLS);
    if (value & CTRL3_SW_RESET) {
        return DEV_ERR_TIMEOUT;
    }
    for (size_t i = 0; i < sizeof(config) / sizeof(config[0]); ++i) {
        if (write_reg(bus, config[i].reg, config[i].value) != DEV_OK ||
            read_reg(bus, config[i].reg, &value) != DEV_OK) {
            return DEV_ERR_BUS;
        }
        if (value != config[i].value) {
            return DEV_ERR_VERIFY;
        }
    }
    return DEV_OK;
}

int ism330_power_down(const dev_bus_t* bus) {
    if (!bus) {
        return DEV_ERR_PARAM;
    }
    if (write_reg(bus, REG_CTRL1_XL, 0x00) != DEV_OK ||
        write_reg(bus, REG_CTRL2_G, 0x00) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    return DEV_OK;
}

static int16_t le16(const uint8_t* p) {
    return (int16_t)(uint16_t)(p[0] | (uint16_t)p[1] << 8);
}

int ism330_read(const dev_bus_t* bus, ism330_sample_t* out) {
    if (!bus || !out) {
        return DEV_ERR_PARAM;
    }
    uint8_t tx[15] = {(uint8_t)(SPI_READ | REG_OUT_TEMP_L)};
    uint8_t rx[15];
    if (bus->xfer(bus->ctx, tx, rx, sizeof(tx)) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    /* 20h-21h temperature, 22h-27h gyro x/y/z, 28h-2Dh accel x/y/z (p.64-66) */
    out->temp = le16(&rx[1]);
    for (int i = 0; i < 3; ++i) {
        out->gyro[i] = le16(&rx[3 + 2 * i]);
        out->accel[i] = le16(&rx[9 + 2 * i]);
    }
    return DEV_OK;
}
