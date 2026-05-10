// Stub: esp_partition.h — for native tests
#pragma once
#include <cstdint>

typedef struct {
    uint32_t address;
    uint32_t size;
} esp_partition_t;

#define ESP_OK 0

inline const esp_partition_t* esp_ota_get_running_partition() {
    static esp_partition_t p = {0, 0};
    return &p;
}

inline int esp_partition_get_sha256(const esp_partition_t*, uint8_t* out) {
    memset(out, 0, 32);
    return ESP_OK;
}
