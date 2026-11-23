#pragma once
#include "esp_partition.h"
static const esp_partition_t g_test_part = { "ota_0", 0x300000 };
static inline const esp_partition_t *esp_ota_get_running_partition(void) { return &g_test_part; }
