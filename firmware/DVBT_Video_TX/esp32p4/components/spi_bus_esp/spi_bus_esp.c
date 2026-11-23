#include <string.h>
#include "spi_bus_esp.h"
#include "spi_bus_pack.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_rom_sys.h"

static const char *TAG = "spi_bus_esp";

typedef struct {
    spi_device_handle_t full, half;     // 4-wire full duplex; 3-wire half duplex
    int pin_cs[SPI_BUS_ESP_MAX_DEV];
    int n_dev;
} ctx_t;
static ctx_t s_ctx;

static esp_err_t xfer(void *vctx, int dev, int nbits, bool three_wire, int wr_bits,
                      uint32_t tx, uint32_t *rx)
{
    ctx_t *c = vctx;
    ESP_RETURN_ON_FALSE(dev >= 0 && dev < c->n_dev && nbits >= 1 && nbits <= 32, ESP_ERR_INVALID_ARG,
                        TAG, "args");
    spi_bus_frame_t f;
    spi_bus_pack(nbits, three_wire, wr_bits, tx, &f);
    uint8_t rxb[4] = {0};
    spi_transaction_t t = {
        .length = f.tx_bits, .tx_buffer = f.tx,
        .rxlength = three_wire ? f.rx_bits : 0,          // full duplex: rx = length
        .rx_buffer = f.rx_bits ? rxb : NULL,
    };
    gpio_set_level(c->pin_cs[dev], 0);
    esp_err_t e = spi_device_polling_transmit(three_wire ? c->half : c->full, &t);
    gpio_set_level(c->pin_cs[dev], 1);
    if (e == ESP_OK && rx) *rx = spi_bus_unpack(&f, rxb);
    return e;
}

static esp_err_t cs_pulse(void *vctx, int dev)
{
    ctx_t *c = vctx;
    ESP_RETURN_ON_FALSE(dev >= 0 && dev < c->n_dev, ESP_ERR_INVALID_ARG, TAG, "dev");
    gpio_set_level(c->pin_cs[dev], 0);
    esp_rom_delay_us(1);
    gpio_set_level(c->pin_cs[dev], 1);
    esp_rom_delay_us(1);
    return ESP_OK;
}

esp_err_t spi_bus_esp_init(const spi_bus_esp_config_t *cfg, spi_bus_if_t *bus)
{
    ESP_RETURN_ON_FALSE(cfg->n_dev > 0 && cfg->n_dev <= SPI_BUS_ESP_MAX_DEV, ESP_ERR_INVALID_ARG, TAG, "n_dev");
    spi_bus_config_t bc = {
        .sclk_io_num = cfg->pin_sclk, .mosi_io_num = cfg->pin_sdio, .miso_io_num = cfg->pin_miso,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 8,
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(cfg->spi_host, &bc, SPI_DMA_DISABLED), TAG, "bus");
    spi_device_interface_config_t full = {
        .mode = 0, .clock_speed_hz = cfg->clock_hz, .spics_io_num = -1, .queue_size = 1,
    };
    spi_device_interface_config_t half = full;
    half.flags = SPI_DEVICE_3WIRE | SPI_DEVICE_HALFDUPLEX;
    ESP_RETURN_ON_ERROR(spi_bus_add_device(cfg->spi_host, &full, &s_ctx.full), TAG, "4-wire device");
    ESP_RETURN_ON_ERROR(spi_bus_add_device(cfg->spi_host, &half, &s_ctx.half), TAG, "3-wire device");
    s_ctx.n_dev = cfg->n_dev;
    for (int i = 0; i < cfg->n_dev; i++) {
        s_ctx.pin_cs[i] = cfg->pin_cs[i];
        gpio_config_t io = { .pin_bit_mask = 1ULL << cfg->pin_cs[i], .mode = GPIO_MODE_OUTPUT };
        ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "cs");
        gpio_set_level(cfg->pin_cs[i], 1);
    }
    bus->xfer = xfer;
    bus->cs_pulse = cs_pulse;
    bus->ctx = &s_ctx;
    return ESP_OK;
}
