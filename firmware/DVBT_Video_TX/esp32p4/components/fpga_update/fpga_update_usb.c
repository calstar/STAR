#include <string.h>
#include <stdio.h>
#include "fpga_update.h"
#include "driver/usb_serial_jtag.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_check.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "fpga_update";
static const esp_partition_t *s_part;
static void (*s_before)(void);

static esp_err_t erase(void *ctx, size_t len)
{
    if (s_before) { s_before(); s_before = NULL; }
    size_t blk = s_part->erase_size;
    return esp_partition_erase_range(s_part, 0, (len + blk - 1) / blk * blk);
}

static esp_err_t write(void *ctx, size_t off, const uint8_t *p, size_t n)
{
    return esp_partition_write(s_part, off, p, n);
}

static void say(const char *s)
{
    usb_serial_jtag_write_bytes(s, strlen(s), pdMS_TO_TICKS(100));
}

static void task(void *arg)
{
    static fpga_update_t u;
    u = (fpga_update_t){ .erase = erase, .write = write, .part_size = s_part->size };
    fpga_update_init(&u);
    static uint8_t buf[512];
    for (;;) {
        int n = usb_serial_jtag_read_bytes(buf, sizeof buf, pdMS_TO_TICKS(1000));
        if (n <= 0) continue;
        const char *msg;
        fu_status_t s = fpga_update_feed(&u, buf, n, &msg);
        char line[96];
        if (s == FU_DONE) {
            snprintf(line, sizeof line, "\nFPGA-UPDATE OK %lu %08lx\n", (unsigned long)u.img.length,
                     (unsigned long)u.img.crc32);
            say(line);
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        } else if (s == FU_ERROR) {
            snprintf(line, sizeof line, "\nFPGA-UPDATE ERR %s\n", msg);
            say(line);
        }
    }
}

esp_err_t fpga_update_usb_start(const char *partition, void (*before_write)(void))
{
    s_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, partition);
    ESP_RETURN_ON_FALSE(s_part, ESP_ERR_NOT_FOUND, TAG, "no %s partition", partition);
    s_before = before_write;
    usb_serial_jtag_driver_config_t cfg = { .rx_buffer_size = 4096, .tx_buffer_size = 512 };
    ESP_RETURN_ON_ERROR(usb_serial_jtag_driver_install(&cfg), TAG, "usb");
    xTaskCreate(task, "fpga_update", 4096, NULL, 2, NULL);
    return ESP_OK;
}
