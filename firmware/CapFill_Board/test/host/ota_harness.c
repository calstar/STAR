#include <stdio.h>
#include "ota.h"
#include "freertos/task.h"
FILE *g_ota_out; int g_ota_ended, g_ota_boot_set; int g_test_log_level = 3;
int main(void) { if (ota_server_start() != ESP_OK) return 1; for (;;) vTaskDelay(1000); }
