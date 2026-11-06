#pragma once
#include <stddef.h>
#include <stdint.h>
typedef void* osMessageQueueId_t;
typedef void* osThreadId_t;
typedef int osStatus_t;
enum { osOK = 0, osError = -1, osPriorityBelowNormal = 16 };
typedef struct {
    const char* name;
    uint32_t stack_size;
    int priority;
} osThreadAttr_t;
osMessageQueueId_t osMessageQueueNew(uint32_t count, uint32_t size,
                                     const void* attr);
osStatus_t osMessageQueuePut(osMessageQueueId_t id, const void* p, uint8_t pri,
                             uint32_t timeout);
osStatus_t osMessageQueueGet(osMessageQueueId_t id, void* p, uint8_t* pri,
                             uint32_t timeout);
osStatus_t osMessageQueueReset(osMessageQueueId_t id);
osStatus_t osMessageQueueDelete(osMessageQueueId_t id);
osThreadId_t osThreadNew(void (*fn)(void*), void* arg,
                         const osThreadAttr_t* attr);
osStatus_t osDelay(uint32_t ticks);
