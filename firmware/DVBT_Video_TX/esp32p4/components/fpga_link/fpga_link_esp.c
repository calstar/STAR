#include <string.h>
#include "fpga_link_esp.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_check.h"
#include "esp_heap_caps.h"

static const char *TAG = "fpga";

typedef struct {
    spi_device_handle_t dev;
    SemaphoreHandle_t dreq_sem;
    int pin_dreq, host;
    bool up;
} ctx_t;
static ctx_t s_ctx;
static uint8_t *s_tx, *s_rx;

static void IRAM_ATTR dreq_isr(void *arg)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(((ctx_t *)arg)->dreq_sem, &woken);
    if (woken) portYIELD_FROM_ISR();
}

static esp_err_t frame(void *vc, const uint8_t *tx, uint8_t *rx, size_t n)
{
    ctx_t *c = vc;
    spi_transaction_t t = { .length = 8 * n, .tx_buffer = tx, .rx_buffer = rx };
    return spi_device_polling_transmit(c->dev, &t);
}

static bool wait_dreq(void *vc, uint32_t timeout_ms)
{
    ctx_t *c = vc;
    while (!gpio_get_level(c->pin_dreq)) {
        if (xSemaphoreTake(c->dreq_sem, pdMS_TO_TICKS(timeout_ms)) != pdTRUE &&
            !gpio_get_level(c->pin_dreq))
            return false;
    }
    return true;
}

esp_err_t fpga_link_esp_init(const fpga_link_esp_config_t *cfg, fpga_link_t *link)
{
    spi_bus_config_t bus = {
        .sclk_io_num = cfg->pin_sck, .mosi_io_num = cfg->pin_mosi, .miso_io_num = cfg->pin_miso,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = FPGA_FRAME_MAX,
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(cfg->spi_host, &bus, SPI_DMA_CH_AUTO), TAG, "bus");
    spi_device_interface_config_t dev = {
        .mode = 0, .clock_speed_hz = cfg->clock_hz, .spics_io_num = cfg->pin_cs,
        .queue_size = 2, .cs_ena_pretrans = 2, .cs_ena_posttrans = 2,
    };
    ESP_RETURN_ON_ERROR(spi_bus_add_device(cfg->spi_host, &dev, &s_ctx.dev), TAG, "device");
    if (!s_tx) {
        s_tx = heap_caps_malloc(FPGA_FRAME_MAX, MALLOC_CAP_DMA);
        s_rx = heap_caps_malloc(FPGA_FRAME_MAX, MALLOC_CAP_DMA);
    }
    ESP_RETURN_ON_FALSE(s_tx && s_rx, ESP_ERR_NO_MEM, TAG, "buffers");

    if (!s_ctx.dreq_sem) {
        s_ctx.dreq_sem = xSemaphoreCreateBinary();
        gpio_config_t io = {
            .pin_bit_mask = 1ULL << cfg->pin_dreq, .mode = GPIO_MODE_INPUT,
            .pull_down_en = GPIO_PULLDOWN_ENABLE, .intr_type = GPIO_INTR_POSEDGE,
        };
        ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "dreq");
        gpio_install_isr_service(0);
        ESP_RETURN_ON_ERROR(gpio_isr_handler_add(cfg->pin_dreq, dreq_isr, &s_ctx), TAG, "isr");
    }
    s_ctx.pin_dreq = cfg->pin_dreq;
    s_ctx.host = cfg->spi_host;
    s_ctx.up = true;
    *link = (fpga_link_t){ .frame = frame, .wait_dreq = wait_dreq, .ctx = &s_ctx, .tx = s_tx, .rx = s_rx };
    return ESP_OK;
}

void fpga_link_esp_deinit(void)
{
    if (!s_ctx.up) return;
    spi_bus_remove_device(s_ctx.dev);
    spi_bus_free(s_ctx.host);
    s_ctx.up = false;
}
