// CapFill board firmware
// FDC1004 (4 capacitive channels on GX12 connectors 1-4) -> Diablo DAQ server over W5500 Ethernet (UDP),
// plus USB serial log and a small HTTP bench page.

#include <stdio.h>
#include "board.h"
#include "daq_config.h"
#include "daq_link.h"
#include "driver/i2c_master.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "eth.h"
#include "fdc1004.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "http_api.h"
#include "nvs_flash.h"
#include "ota.h"
#include "readings.h"
#include "status_led.h"

static const char *TAG = "capfill";

#if CAPFILL_BOARD_ID_IS_PLACEHOLDER
// TODO(BOARD_ID): this warning shows on every build until the real ID is set in main/daq_config.h
#warning "CapFill BOARD_ID is still the placeholder (99). Set the real ID in main/daq_config.h before using the DAQ network."
#endif

#define SAMPLE_POLL_MS  10     // 4 channels at 100 S/s -> each channel updates ~every 40 ms
#define LOG_PERIOD_MS   1000
#define RETRY_MS        2000

static i2c_master_bus_handle_t s_i2c_bus;

static void sensor_task(void *arg)
{
    fdc1004_t fdc;
    fdc1004_sample_t s[FDC1004_NUM_CH];
    const fdc1004_sample_t none[FDC1004_NUM_CH] = { 0 };

    for (;;) {
        // (Re)connect: covers a missing/loose sensor at boot and I2C faults later.
        if (fdc1004_init(&fdc, s_i2c_bus, FDC1004_I2C_ADDR, FDC1004_RATE_100) != ESP_OK) {
            readings_set_sensor_ok(false);
            daq_link_on_samples(none, false);
            if (fdc.dev) i2c_master_bus_rm_device(fdc.dev);
            vTaskDelay(pdMS_TO_TICKS(RETRY_MS));
            continue;
        }
        readings_set_sensor_ok(true);

        int errors = 0;
        while (errors < 5) {
            if (fdc1004_poll(&fdc, s) != ESP_OK) {
                errors++;
            } else {
                errors = 0;
                for (int ch = 0; ch < FDC1004_NUM_CH; ch++) {
                    if (s[ch].fresh) readings_update(ch, s[ch].pf, s[ch].capdac, s[ch].saturated);
                }
                daq_link_on_samples(s, true);
            }
            vTaskDelay(pdMS_TO_TICKS(SAMPLE_POLL_MS));
        }

        ESP_LOGW(TAG, "lost FDC1004, reinitializing");
        readings_set_sensor_ok(false);
        daq_link_on_samples(none, false);
        i2c_master_bus_rm_device(fdc.dev);
        i2c_master_bus_reset(s_i2c_bus);
    }
}

static void log_task(void *arg)
{
    readings_t r;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(LOG_PERIOD_MS));
        readings_get(&r);
        if (!r.sensor_ok) {
            ESP_LOGW(TAG, "sensor not responding | ip %s | daq state %d", eth_ip_str(), daq_link_state());
            continue;
        }
        char line[160];
        int n = 0;
        for (int i = 0; i < CAPFILL_NUM_CHANNELS; i++) {
            const channel_reading_t *c = &r.ch[i];
            if (c->valid) {
                n += snprintf(line + n, sizeof(line) - n, "CIN%d %8.3f pF%s | ",
                              i + 1, c->pf_avg, c->saturated ? "!" : " ");
            } else {
                n += snprintf(line + n, sizeof(line) - n, "CIN%d     ---    | ", i + 1);
            }
        }
        ESP_LOGI(TAG, "%sip %s | daq state %d", line, eth_ip_str(), daq_link_state());
    }
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    ESP_LOGI(TAG, "CapFill board, BOARD_ID %d -> IP %d.%d.%d.%d", BOARD_ID,
             DAQ_NET_OCTET_1, DAQ_NET_OCTET_2, DAQ_NET_OCTET_3, BOARD_ID);
#if CAPFILL_BOARD_ID_IS_PLACEHOLDER
    // TODO(BOARD_ID): remove by setting the real ID in main/daq_config.h
    ESP_LOGW(TAG, "*** BOARD_ID %d is a PLACEHOLDER - set CapFill's assigned ID in main/daq_config.h ***", BOARD_ID);
#endif

    readings_init();
    status_led_start();

    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = PIN_I2C_SDA,
        .scl_io_num = PIN_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = false,   // R1/R2 4.7k on board
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &s_i2c_bus));

    xTaskCreate(sensor_task, "sensor", 4096, NULL, 5, NULL);

    // Keep running on sensor/serial even if the Ethernet breakout is absent.
    if (eth_start() == ESP_OK) {
        daq_link_start();
        ota_server_start();
        http_api_start();
    } else {
        ESP_LOGE(TAG, "Ethernet unavailable; serial output only");
    }

    xTaskCreate(log_task, "log", 4096, NULL, 3, NULL);
}
