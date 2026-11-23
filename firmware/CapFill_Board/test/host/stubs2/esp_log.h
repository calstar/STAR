#pragma once
#include <stdio.h>
typedef enum { ESP_LOG_NONE, ESP_LOG_ERROR, ESP_LOG_WARN, ESP_LOG_INFO, ESP_LOG_DEBUG } esp_log_level_t;
extern int g_test_log_level;
static inline void esp_log_level_set(const char *t, esp_log_level_t l) { (void)t; g_test_log_level = l; }
#define ESP_LOGE(tag, fmt, ...) fprintf(stderr, "E %s: " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) fprintf(stderr, "W %s: " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) do { if (g_test_log_level >= ESP_LOG_INFO) fprintf(stderr, "I %s: " fmt "\n", tag, ##__VA_ARGS__); } while (0)
#define ESP_LOGD(tag, fmt, ...) do { } while (0)
