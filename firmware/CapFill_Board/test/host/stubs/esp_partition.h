#pragma once
#include <stdint.h>
#include <string.h>
#include "esp_err.h"
typedef struct { const char *label; uint32_t size; } esp_partition_t;
static inline esp_err_t esp_partition_get_sha256(const esp_partition_t *p, uint8_t *out) { (void)p; for (int i = 0; i < 32; i++) out[i] = 0xA0 + i; return ESP_OK; }
