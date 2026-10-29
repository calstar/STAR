#pragma once
#include <stdlib.h>
#include "FreeRTOS.h"
typedef pthread_mutex_t *SemaphoreHandle_t;
static inline SemaphoreHandle_t xSemaphoreCreateMutex(void) { pthread_mutex_t *m = malloc(sizeof *m); pthread_mutex_init(m, NULL); return m; }
static inline int xSemaphoreTake(SemaphoreHandle_t m, TickType_t t) { (void)t; return pthread_mutex_lock(m) == 0; }
static inline int xSemaphoreGive(SemaphoreHandle_t m) { return pthread_mutex_unlock(m) == 0; }
