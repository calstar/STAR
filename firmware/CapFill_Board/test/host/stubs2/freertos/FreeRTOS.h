#pragma once
#include <pthread.h>
#include <stdint.h>
#include <unistd.h>
typedef uint32_t TickType_t;
#define portMAX_DELAY 0xffffffffu
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
