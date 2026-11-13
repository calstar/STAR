#ifndef TEST_CMSIS_OS2_H
#define TEST_CMSIS_OS2_H
#include <stdint.h>
typedef void* osThreadId_t;
typedef struct {
    const char* name;
    uint32_t stack_size;
    int priority;
} osThreadAttr_t;
enum { osPriorityLow = 8, osPriorityNormal = 24 };
osThreadId_t osThreadNew(void (*fn)(void*), void* arg,
                         const osThreadAttr_t* attr);
uint32_t osKernelGetTickFreq(void);
void osDelay(uint32_t ticks);
#endif
