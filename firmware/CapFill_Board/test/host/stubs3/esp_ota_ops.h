#pragma once
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>
#include "esp_partition.h"
typedef int esp_ota_handle_t;
extern FILE *g_ota_out; extern int g_ota_ended, g_ota_boot_set;
static const esp_partition_t g_slot1 = { "ota_1", 0x300000 };
static inline const esp_partition_t *esp_ota_get_next_update_partition(const esp_partition_t *p) { return &g_slot1; }
static inline esp_err_t esp_ota_begin(const esp_partition_t *p, size_t sz, esp_ota_handle_t *h) { g_ota_out = fopen("ota_received.bin", "wb"); *h = 1; return ESP_OK; }
static inline esp_err_t esp_ota_write(esp_ota_handle_t h, const void *d, size_t n) { return fwrite(d, 1, n, g_ota_out) == n ? ESP_OK : ESP_FAIL; }
static inline esp_err_t esp_ota_abort(esp_ota_handle_t h) { fclose(g_ota_out); return ESP_OK; }
static inline esp_err_t esp_ota_end(esp_ota_handle_t h) { fclose(g_ota_out); g_ota_ended = 1; return ESP_OK; }
static inline esp_err_t esp_ota_set_boot_partition(const esp_partition_t *p) { g_ota_boot_set = 1; return ESP_OK; }
