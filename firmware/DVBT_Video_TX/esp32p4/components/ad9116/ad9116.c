#include <stddef.h>
#include "ad9116.h"
#include "esp_rom_sys.h"

#define INS_READ 0x80u

esp_err_t ad9116_write(const ad9116_t *d, uint8_t reg, uint8_t val)
{
    uint32_t w = ((uint32_t)(reg & 0x1F) << 8) | val;      // 1-byte write, MSB first
    return spi_bus_xfer(d->bus, d->dev, 16, true, 16, w, NULL);
}

esp_err_t ad9116_read(const ad9116_t *d, uint8_t reg, uint8_t *val)
{
    uint32_t rx = 0;
    uint32_t w = ((INS_READ | (reg & 0x1F)) << 8);
    esp_err_t e = spi_bus_xfer(d->bus, d->dev, 16, true, 8, w, &rx);
    if (e == ESP_OK) *val = rx & 0xFF;
    return e;
}

esp_err_t ad9116_init(const ad9116_t *d, bool twos_complement, uint8_t *version)
{
    esp_err_t e;
    d->set_reset(d->reset_ctx, true);
    esp_rom_delay_us(1);
    d->set_reset(d->reset_ctx, false);
    esp_rom_delay_us(1);
    uint8_t dc = AD9116_IFIRST | AD9116_IRISING | AD9116_DCI_EN | (twos_complement ? AD9116_TWOS : 0);
    if ((e = ad9116_write(d, AD9116_DATA_CTRL, dc)) != ESP_OK) return e;
    uint8_t rb = 0;
    if ((e = ad9116_read(d, AD9116_DATA_CTRL, &rb)) != ESP_OK) return e;
    if (rb != dc) return ESP_ERR_INVALID_RESPONSE;          // wiring or SPI mode problem
    if (version && (e = ad9116_read(d, AD9116_VERSION, version)) != ESP_OK) return e;
    for (int i = 0; i < 1000; i++) {
        uint8_t cm = 0;
        if ((e = ad9116_read(d, AD9116_CLKMODE, &cm)) != ESP_OK) return e;
        if (!(cm & AD9116_CLKMODE_SEARCHING)) return ESP_OK;
        esp_rom_delay_us(10);
    }
    return ESP_ERR_TIMEOUT;                                 // no DCLKIO or CLKIN
}
