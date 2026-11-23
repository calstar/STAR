#include <stddef.h>
#include "adrf6755.h"

#define CMD_WRITE 0xD4u
#define CMD_READ  0xD5u

esp_err_t adrf6755_lock_spi(const adrf6755_t *d)
{
    if (!d->bus->cs_pulse) return ESP_ERR_INVALID_ARG;
    for (int i = 0; i < 3; i++) {
        esp_err_t e = d->bus->cs_pulse(d->bus->ctx, d->dev);
        if (e != ESP_OK) return e;
    }
    return ESP_OK;
}

esp_err_t adrf6755_write(const adrf6755_t *d, uint8_t reg, uint8_t val)
{
    uint32_t w = (CMD_WRITE << 16) | ((uint32_t)reg << 8) | val;
    return spi_bus_xfer(d->bus, d->dev, 24, false, 0, w, NULL);
}

esp_err_t adrf6755_read(const adrf6755_t *d, uint8_t reg, uint8_t *val)
{
    esp_err_t e = spi_bus_xfer(d->bus, d->dev, 16, false, 0, (CMD_WRITE << 8) | reg, NULL);
    if (e != ESP_OK) return e;
    uint32_t rx = 0;
    e = spi_bus_xfer(d->bus, d->dev, 16, false, 0, CMD_READ << 8, &rx);
    if (e == ESP_OK) *val = rx & 0xFF;
    return e;
}

esp_err_t adrf6755_init(const adrf6755_t *d, const adrf6755_plan_t *p, uint8_t atten_db)
{
    uint8_t seq[40][2];
    int n = adrf6755_init_sequence(p, atten_db, seq, 40);
    if (n < 0) return ESP_ERR_INVALID_SIZE;
    for (int i = 0; i < n; i++) {
        esp_err_t e = adrf6755_write(d, seq[i][0], seq[i][1]);
        if (e != ESP_OK) return e;
    }
    // Read back the INT word: catches a dead bus or a part still in I2C mode.
    uint8_t v = 0;
    esp_err_t e = adrf6755_read(d, 6, &v);
    if (e != ESP_OK) return e;
    return v == (p->intg & 0xFF) ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

esp_err_t adrf6755_modulator_on(const adrf6755_t *d, bool on)
{
    return adrf6755_write(d, 29, on ? 0x81 : 0x80);
}
