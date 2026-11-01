#include "ecp5_cfg.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_partition.h"
#include "esp_rom_sys.h"
#include "esp_check.h"

static const char *TAG = "ecp5";

typedef struct {
    const ecp5_esp_config_t *cfg;
    spi_device_handle_t dev;
    const esp_partition_t *part;
} ctx_t;

static void set_cfg_sspi(void *c, bool sspi)
{
    const ecp5_esp_config_t *k = ((ctx_t *)c)->cfg;
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
static void set_programn(void *c, bool high) { gpio_set_level(((ctx_t *)c)->cfg->pin_programn, high); }
static bool get_initn(void *c) { return gpio_get_level(((ctx_t *)c)->cfg->pin_initn); }
static bool get_done(void *c) { return gpio_get_level(((ctx_t *)c)->cfg->pin_done); }
static void set_cs(void *c, bool low) { gpio_set_level(((ctx_t *)c)->cfg->pin_sn, !low); }
static void delay_us(void *c, uint32_t us) { esp_rom_delay_us(us); }

static esp_err_t spi(void *c, const uint8_t *tx, uint8_t *rx, size_t n)
{
    ctx_t *x = c;
    if (!x->dev) return ESP_ERR_INVALID_STATE;
    spi_transaction_t t = { .length = 8 * n, .tx_buffer = tx, .rx_buffer = rx };
    return spi_device_polling_transmit(x->dev, &t);
}

static esp_err_t rd(void *c, size_t off, uint8_t *buf, size_t n)
{
    ctx_t *x = c;
    return x->part ? esp_partition_read(x->part, off, buf, n) : ESP_ERR_NOT_FOUND;
}

esp_err_t ecp5_configure_esp(const ecp5_esp_config_t *k, ecp5_result_t *res)
{
    ctx_t x = { .cfg = k };
    x.part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, k->partition);

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
    bool bus = spi_bus_initialize(k->spi_host, &bc, SPI_DMA_CH_AUTO) == ESP_OK;
    if (bus) {
        spi_device_interface_config_t dc = { .mode = 0, .clock_speed_hz = k->clock_hz,
                                             .spics_io_num = -1, .queue_size = 1 };
        if (spi_bus_add_device(k->spi_host, &dc, &x.dev) != ESP_OK) x.dev = NULL;
    }
    ecp5_hal_t h = { .ctx = &x, .set_cfg_sspi = set_cfg_sspi, .set_programn = set_programn,
                     .get_initn = get_initn, .get_done = get_done, .set_cs = set_cs, .spi = spi,
                     .read = rd, .delay_us = delay_us };
    esp_err_t e = ecp5_configure(&h, x.part ? x.part->size : 0, res);

    // Hand the pins back: the SPI bus is freed (fpga_link reuses the host on
    // the stream pins), CFG released to the straps, SN high-impedance with
    // its pull-up, so the configuration port is quiet.
    if (x.dev) spi_bus_remove_device(x.dev);
    if (bus) spi_bus_free(k->spi_host);
    set_cfg_sspi(&x, false);
    gpio_set_direction(k->pin_sn, GPIO_MODE_INPUT);
    ESP_LOGI(TAG, "FPGA configured via %s (slave SPI: %s, idcode %08lx, status %08lx)",
             res->via == ECP5_VIA_SSPI ? "slave SPI from the P4" : res->via == ECP5_VIA_FLASH ? "its W25Q32" : "nothing",
             esp_err_to_name(res->sspi_err), (unsigned long)res->idcode, (unsigned long)res->status);
    return e;
}
