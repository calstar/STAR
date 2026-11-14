#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include "recorder.h"
#include "rec_ring.h"
#include "driver/sdmmc_host.h"
#include "esp_vfs_fat.h"
#include "esp_heap_caps.h"
#include "esp_check.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "rec";
static rec_ring_t s_q;
static FILE *s_f;
static volatile bool s_on;

static void task(void *arg)
{
    int64_t last_sync = esp_timer_get_time();
    for (;;) {
        const uint8_t *p;
        size_t n = rec_ring_peek(&s_q, &p);
        bool due = esp_timer_get_time() - last_sync > 1000000;
        if (n >= 32768 || (n && due)) {
            if (n > 32768) n = 32768;
            if (fwrite(p, 1, n, s_f) != n) {
                ESP_LOGE(TAG, "write failed: card full or removed; recording stops");
                s_on = false;
                fclose(s_f);
                vTaskDelete(NULL);
            }
            rec_ring_pop(&s_q, n);
        } else {
            vTaskDelay(pdMS_TO_TICKS(20));
        }
        if (due) {
            fflush(s_f);
            fsync(fileno(s_f));
            last_sync = esp_timer_get_time();
        }
    }
}

esp_err_t recorder_start(const recorder_config_t *cfg)
{
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.slot = SDMMC_HOST_SLOT_1;
    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = 1;
    slot.clk = cfg->pin_clk;
    slot.cmd = cfg->pin_cmd;
    slot.d0 = cfg->pin_d0;
    slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
    esp_vfs_fat_sdmmc_mount_config_t mc = { .format_if_mount_failed = false, .max_files = 2,
                                            .allocation_unit_size = 32 * 1024 };
    sdmmc_card_t *card;
    ESP_RETURN_ON_ERROR(esp_vfs_fat_sdmmc_mount("/sdcard", &host, &slot, &mc, &card), TAG, "no card");
    char name[32];
    struct stat st;
    int i = 0;
    do snprintf(name, sizeof name, "/sdcard/TX%04d.TS", i++); while (stat(name, &st) == 0 && i < 10000);
    s_f = fopen(name, "wb");
    ESP_RETURN_ON_FALSE(s_f, ESP_FAIL, TAG, "open %s", name);
    uint8_t *buf = heap_caps_malloc(cfg->ring_bytes, MALLOC_CAP_SPIRAM);
    ESP_RETURN_ON_FALSE(buf, ESP_ERR_NO_MEM, TAG, "ring");
    rec_ring_init(&s_q, buf, cfg->ring_bytes);
    xTaskCreate(task, "rec", 4096, NULL, 3, NULL);
    s_on = true;
    ESP_LOGI(TAG, "recording to %s", name);
    return ESP_OK;
}

void recorder_push(const uint8_t *pkts, size_t n)
{
    if (s_on) rec_ring_push(&s_q, pkts, n * 188);
}

uint32_t recorder_dropped(void)
{
    return s_q.dropped;
}
