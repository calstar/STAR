// A generic I2C master interface (7-bit addresses), so chip drivers (the
// Si5351A) run on the ESP32-P4's I2C driver or against a host-test model.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct i2c_bus_if {
    // One transfer: START, addr+W, the bytes, STOP.
    esp_err_t (*write)(void *ctx, uint8_t addr, const uint8_t *buf, size_t n);
    // START, addr+W, w, repeated START, addr+R, nr bytes in, STOP.
    esp_err_t (*write_read)(void *ctx, uint8_t addr, const uint8_t *w, size_t nw,
                            uint8_t *r, size_t nr);
    void (*delay_us)(void *ctx, uint32_t us);
    void *ctx;
} i2c_bus_if_t;
