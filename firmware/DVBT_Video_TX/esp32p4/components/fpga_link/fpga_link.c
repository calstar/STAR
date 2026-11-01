#include <string.h>
#include "fpga_link.h"
#include "fpga_proto.h"
#include "dvbt_regs.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_check.h"
#include "esp_heap_caps.h"

static const char *TAG = "fpga";
static spi_device_handle_t s_dev;
static SemaphoreHandle_t s_dreq_sem;
static int s_pin_dreq;
static uint8_t *s_tx, *s_rx;                 // DMA buffers: one 2-packet TS frame
#define FRAME_MAX (1 + 2 * TS_PACKET)

static void IRAM_ATTR dreq_isr(void *arg)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s_dreq_sem, &woken);
    if (woken) portYIELD_FROM_ISR();
}

static esp_err_t frame(size_t len)
{
    spi_transaction_t t = { .length = 8 * len, .tx_buffer = s_tx, .rx_buffer = s_rx };
    return spi_device_polling_transmit(s_dev, &t);
}

esp_err_t fpga_link_init(const fpga_link_config_t *cfg)
{
    spi_bus_config_t bus = {
        .sclk_io_num = cfg->pin_sck, .mosi_io_num = cfg->pin_mosi, .miso_io_num = cfg->pin_miso,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = FRAME_MAX,
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(cfg->spi_host, &bus, SPI_DMA_CH_AUTO), TAG, "bus");
    spi_device_interface_config_t dev = {
        .mode = 0, .clock_speed_hz = cfg->clock_hz, .spics_io_num = cfg->pin_cs,
        .queue_size = 2, .cs_ena_pretrans = 2, .cs_ena_posttrans = 2,
    };
    ESP_RETURN_ON_ERROR(spi_bus_add_device(cfg->spi_host, &dev, &s_dev), TAG, "device");
    s_tx = heap_caps_malloc(FRAME_MAX, MALLOC_CAP_DMA);
    s_rx = heap_caps_malloc(FRAME_MAX, MALLOC_CAP_DMA);
    ESP_RETURN_ON_FALSE(s_tx && s_rx, ESP_ERR_NO_MEM, TAG, "buffers");

    s_pin_dreq = cfg->pin_dreq;
    s_dreq_sem = xSemaphoreCreateBinary();
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << cfg->pin_dreq, .mode = GPIO_MODE_INPUT,
        .pull_down_en = GPIO_PULLDOWN_ENABLE, .intr_type = GPIO_INTR_POSEDGE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "dreq");
    gpio_install_isr_service(0);
    ESP_RETURN_ON_ERROR(gpio_isr_handler_add(cfg->pin_dreq, dreq_isr, NULL), TAG, "isr");

    uint32_t id = 0;
    ESP_RETURN_ON_ERROR(fpga_reg_read(DVBT_REG_ID, &id), TAG, "id");
    ESP_RETURN_ON_FALSE(id == DVBT_ID, ESP_ERR_INVALID_VERSION, TAG,
                        "FPGA ID %08lx, expected %08lx", (unsigned long)id, (unsigned long)DVBT_ID);
    return ESP_OK;
}

esp_err_t fpga_reg_write(unsigned addr, uint32_t val)
{
    return frame(fpga_frame_write(s_tx, addr, val));
}

esp_err_t fpga_reg_read(unsigned addr, uint32_t *val)
{
    esp_err_t e = frame(fpga_frame_read(s_tx, addr));
    if (e == ESP_OK) *val = fpga_parse_read(s_rx);
    return e;
}

esp_err_t fpga_ts_send(const uint8_t *pkts, size_t n, uint32_t timeout_ms, uint8_t *status)
{
    while (n) {
        while (!gpio_get_level(s_pin_dreq)) {
            if (xSemaphoreTake(s_dreq_sem, pdMS_TO_TICKS(timeout_ms)) != pdTRUE &&
                !gpio_get_level(s_pin_dreq))
                return ESP_ERR_TIMEOUT;
        }
        size_t k = n >= 2 ? 2 : 1;
        ESP_RETURN_ON_ERROR(frame(fpga_frame_ts(s_tx, pkts, k)), TAG, "ts");
        if (status) *status = s_rx[0];
        pkts += k * TS_PACKET;
        n -= k;
    }
    return ESP_OK;
}
