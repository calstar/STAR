#include "fake_baro.h"

#include <string.h>

const uint16_t fake_baro_datasheet_prom[8] = {0x3132, 40127, 36924, 23317,
                                              23282,  33464, 28312, 0x1233};

static int xfer(void* ctx, const uint8_t* tx, uint8_t* rx, uint16_t len) {
    fake_baro_t* f = ctx;
    if (f->fail) {
        return DEV_ERR_BUS;
    }
    f->transfers++;
    f->last_cmd = tx[0];
    if (rx) {
        memset(rx, 0, len);
    }
    if (tx[0] >= 0xA0 && tx[0] <= 0xAE && len == 3 && rx) {
        uint16_t w = f->prom[(tx[0] - 0xA0) / 2];
        rx[1] = (uint8_t)(w >> 8);
        rx[2] = (uint8_t)w;
    } else if (tx[0] == 0x48 || tx[0] == 0x58) {
        f->pending = tx[0];
    } else if (tx[0] == 0x00 && len == 4 && rx) {
        uint32_t v = f->pending == 0x48   ? f->d1
                     : f->pending == 0x58 ? f->d2
                                          : 0;
        f->pending = 0;
        rx[1] = (uint8_t)(v >> 16);
        rx[2] = (uint8_t)(v >> 8);
        rx[3] = (uint8_t)v;
    }
    return DEV_OK;
}

static void no_delay(void* ctx, uint32_t ms) {
    (void)ctx;
    (void)ms;
}

dev_bus_t fake_baro_bus(fake_baro_t* f) {
    dev_bus_t bus = {xfer, no_delay, f};
    return bus;
}
