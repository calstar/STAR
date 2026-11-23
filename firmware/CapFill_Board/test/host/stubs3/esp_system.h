#pragma once
#include <stdio.h>
#include <stdlib.h>
extern int g_ota_ended, g_ota_boot_set;
static inline void esp_restart(void) { fprintf(stderr, "RESTART (ota_end=%d boot_set=%d)\n", g_ota_ended, g_ota_boot_set); exit(42); }
