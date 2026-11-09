#include "dev_h3lis100dl.h"

#include <stddef.h>

enum {
    REG_WHO_AM_I = 0x0F,
    REG_CTRL_REG1 = 0x20,
    REG_CTRL_REG3 = 0x22,
    REG_CTRL_REG4 = 0x23,
    REG_OUT_X = 0x29,
};

/* First byte (p.20): bit 7 RW (1 = read), bit 6 MS (1 = auto-increment),
 * bits 5:0 address. */
#define SPI_READ 0x80U
#define SPI_INCREMENT 0x40U

static const struct {
    uint8_t reg;
    uint8_t value;
} config[] = {
    {REG_CTRL_REG4, 0x00}, /* 4-wire SPI */
    {REG_CTRL_REG3, 0x02}, /* INT1 = data ready, active high, push-pull */
    {REG_CTRL_REG1, 0x37}, /* normal mode, 400 Hz, X/Y/Z on: last */
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

int h3lis_init(const dev_bus_t* bus) {
    return h3lis_init_with(bus, 0x37);
}

int h3lis_init_with(const dev_bus_t* bus, uint8_t ctrl_reg1) {
    if (!bus || !bus->xfer) {
        return DEV_ERR_PARAM;
    }
    uint8_t value = 0;
    if (read_reg(bus, REG_WHO_AM_I, &value) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    if (value != H3LIS_WHO_AM_I_VALUE) {
        return DEV_ERR_ID;
    }
    for (size_t i = 0; i < sizeof(config) / sizeof(config[0]); ++i) {
        uint8_t want =
            config[i].reg == REG_CTRL_REG1 ? ctrl_reg1 : config[i].value;
        if (write_reg(bus, config[i].reg, want) != DEV_OK ||
            read_reg(bus, config[i].reg, &value) != DEV_OK) {
            return DEV_ERR_BUS;
        }
        if (value != want) {
            return DEV_ERR_VERIFY;
        }
    }
    return DEV_OK;
}

int h3lis_power_down(const dev_bus_t* bus) {
    if (!bus) {
        return DEV_ERR_PARAM;
    }
    return write_reg(bus, REG_CTRL_REG1, 0x07) == DEV_OK ? DEV_OK : DEV_ERR_BUS;
}

int h3lis_read(const dev_bus_t* bus, h3lis_sample_t* out) {
    if (!bus || !out) {
        return DEV_ERR_PARAM;
    }
    const uint8_t tx[6] = {(uint8_t)(SPI_READ | SPI_INCREMENT | REG_OUT_X)};
    uint8_t rx[6];
    if (bus->xfer(bus->ctx, tx, rx, sizeof(tx)) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    /* 29h X, 2Ah reserved, 2Bh Y, 2Ch reserved, 2Dh Z */
    out->accel[0] = (int8_t)rx[1];
    out->accel[1] = (int8_t)rx[3];
    out->accel[2] = (int8_t)rx[5];
    return DEV_OK;
}
