#include "ota.h"

#include <stdbool.h>
#include <stdint.h>

#include <string.h>
#include "daq_config.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

static const char *TAG = "ota";

#define OTA_CHUNK      4096
#define OTA_TIMEOUT_S  10

static bool recv_exact(int fd, uint8_t *buf, size_t n)
{
    size_t got = 0;
    while (got < n) {
        int r = recv(fd, buf + got, n - got, 0);
        if (r <= 0) return false;
        got += (size_t)r;
    }
    return true;
}

static void handle_client(int fd)
{
    struct timeval tv = { .tv_sec = OTA_TIMEOUT_S };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    uint8_t hdr[4];
    if (!recv_exact(fd, hdr, 4)) {
        ESP_LOGE(TAG, "timed out waiting for size header");
        return;
    }
    uint32_t size = ((uint32_t)hdr[0] << 24) | ((uint32_t)hdr[1] << 16) | ((uint32_t)hdr[2] << 8) | hdr[3];

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (!target || size == 0 || size > target->size) {
        ESP_LOGE(TAG, "bad image size %lu (slot %lu)", (unsigned long)size,
                 target ? (unsigned long)target->size : 0UL);
        return;
    }
    ESP_LOGW(TAG, "receiving %lu bytes into %s", (unsigned long)size, target->label);

    esp_ota_handle_t h;
    if (esp_ota_begin(target, size, &h) != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin failed");
        return;
    }

    static uint8_t buf[OTA_CHUNK];
    uint32_t left = size;
    while (left) {
        int r = recv(fd, buf, left < OTA_CHUNK ? left : OTA_CHUNK, 0);
        if (r <= 0) {
            ESP_LOGE(TAG, "transfer stopped with %lu bytes left", (unsigned long)left);
            esp_ota_abort(h);
            return;
        }
        if (esp_ota_write(h, buf, r) != ESP_OK) {
            ESP_LOGE(TAG, "flash write failed");
            esp_ota_abort(h);
            return;
        }
        left -= (uint32_t)r;
    }

    if (esp_ota_end(h) != ESP_OK || esp_ota_set_boot_partition(target) != ESP_OK) {
        ESP_LOGE(TAG, "image invalid, keeping current firmware");
        return;
    }
    send(fd, "OK\r\n", 4, 0);
    ESP_LOGW(TAG, "update OK, rebooting");
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
}

static void ota_task(void *arg)
{
    int srv = (int)(intptr_t)arg;
    for (;;) {
        int fd = accept(srv, NULL, NULL);
        if (fd < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        ESP_LOGW(TAG, "client connected");
        handle_client(fd);
        close(fd);
    }
}

esp_err_t ota_server_start(void)
{
    int srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv < 0) return ESP_FAIL;
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(DAQ_OTA_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    int yes = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) < 0 || listen(srv, 1) < 0) {
        ESP_LOGE(TAG, "could not listen on %d", DAQ_OTA_PORT);
        close(srv);
        return ESP_FAIL;
    }
    xTaskCreate(ota_task, "ota", 4096, (void *)(intptr_t)srv, 3, NULL);
    ESP_LOGI(TAG, "OTA on TCP %d", DAQ_OTA_PORT);
    return ESP_OK;
}
