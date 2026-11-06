#include "ecp5_cfg.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_partition.h"
#include "esp_rom_sys.h"
#include "esp_check.h"

static const char *TAG = "ecp5";

typedef struct {
    ecp5_esp_config_t cfg;
    spi_device_handle_t dev;
    const esp_partition_t *part;
    bool bus, open;
} ctx_t;
static ctx_t s_x;

static void set_cfg_sspi(void *c, bool sspi)
{
    const ecp5_esp_config_t *k = &((ctx_t *)c)->cfg;
    if (sspi) {
        gpio_set_direction(k->pin_cfg0, GPIO_MODE_OUTPUT);
        gpio_set_direction(k->pin_cfg1, GPIO_MODE_OUTPUT);
        gpio_set_level(k->pin_cfg0, k->cfg_sspi & 1);
        gpio_set_level(k->pin_cfg1, (k->cfg_sspi >> 1) & 1);
    } else {                      // high impedance: the board straps decide (master SPI)
        gpio_set_direction(k->pin_cfg0, GPIO_MODE_INPUT);
        gpio_set_direction(k->pin_cfg1, GPIO_MODE_INPUT);
    }
}
static void set_programn(void *c, bool high) { gpio_set_level(((ctx_t *)c)->cfg.pin_programn, high); }
static bool get_initn(void *c) { return gpio_get_level(((ctx_t *)c)->cfg.pin_initn); }
static bool get_done(void *c) { return gpio_get_level(((ctx_t *)c)->cfg.pin_done); }
static void set_cs(void *c, bool low) { gpio_set_level(((ctx_t *)c)->cfg.pin_sn, !low); }
static void delay_us(void *c, uint32_t us) { (void)c; esp_rom_delay_us(us); }

static esp_err_t spi(void *c, const uint8_t *tx, uint8_t *rx, size_t n)
{
    ctx_t *x = c;
    if (!x->dev) return ESP_ERR_INVALID_STATE;
    // The driver's single transaction limit: split long writes (CS stays low).
    while (n) {
        size_t k = n > 1024 ? 1024 : n;
        spi_transaction_t t = { .length = 8 * k, .tx_buffer = tx, .rx_buffer = rx };
        ESP_RETURN_ON_ERROR(spi_device_polling_transmit(x->dev, &t), TAG, "spi");
        tx += k;
        if (rx) rx += k;
        n -= k;
    }
    return ESP_OK;
}

static esp_err_t rd(void *c, size_t off, uint8_t *buf, size_t n)
{
    ctx_t *x = c;
    return x->part ? esp_partition_read(x->part, off, buf, n) : ESP_ERR_NOT_FOUND;
}

esp_err_t ecp5_esp_open(const ecp5_esp_config_t *k, ecp5_hal_t *h, size_t *part_size)
{
    s_x = (ctx_t){ .cfg = *k };
    s_x.part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, k->partition);

    // PROGRAMN: open drain with the board pull-up; SN: idle high.
    gpio_config_t od = { .pin_bit_mask = 1ULL << k->pin_programn, .mode = GPIO_MODE_OUTPUT_OD };
    ESP_RETURN_ON_ERROR(gpio_config(&od), TAG, "programn");
    gpio_set_level(k->pin_programn, 1);
    gpio_config_t in = { .pin_bit_mask = (1ULL << k->pin_initn) | (1ULL << k->pin_done) |
                                         (1ULL << k->pin_cfg0) | (1ULL << k->pin_cfg1),
                         .mode = GPIO_MODE_INPUT };
    ESP_RETURN_ON_ERROR(gpio_config(&in), TAG, "inputs");
    gpio_config_t sn = { .pin_bit_mask = 1ULL << k->pin_sn, .mode = GPIO_MODE_OUTPUT };
    ESP_RETURN_ON_ERROR(gpio_config(&sn), TAG, "sn");
    gpio_set_level(k->pin_sn, 1);

    spi_bus_config_t bc = { .sclk_io_num = k->pin_cclk, .mosi_io_num = k->pin_mosi,
                            .miso_io_num = k->pin_miso, .quadwp_io_num = -1, .quadhd_io_num = -1,
                            .max_transfer_sz = 1024 };
    s_x.bus = spi_bus_initialize(k->spi_host, &bc, SPI_DMA_CH_AUTO) == ESP_OK;
    if (s_x.bus) {
        spi_device_interface_config_t dc = { .mode = 0, .clock_speed_hz = k->clock_hz,
                                             .spics_io_num = -1, .queue_size = 1 };
        if (spi_bus_add_device(k->spi_host, &dc, &s_x.dev) != ESP_OK) s_x.dev = NULL;
    }
    // No SPI: the loader fails over to the W25Q32 (spi() returns an error).
    *h = (ecp5_hal_t){ .ctx = &s_x, .set_cfg_sspi = set_cfg_sspi, .set_programn = set_programn,
                       .get_initn = get_initn, .get_done = get_done, .set_cs = set_cs, .spi = spi,
                       .read = rd, .delay_us = delay_us };
    *part_size = s_x.part ? s_x.part->size : 0;
    s_x.open = true;
    return ESP_OK;
}

void ecp5_esp_close(void)
{
    if (!s_x.open) return;
    if (s_x.dev) spi_bus_remove_device(s_x.dev);
    if (s_x.bus) spi_bus_free(s_x.cfg.spi_host);
    s_x.dev = NULL;
    s_x.bus = false;
    set_cfg_sspi(&s_x, false);
    gpio_set_direction(s_x.cfg.pin_sn, GPIO_MODE_INPUT);
    s_x.open = false;
}
