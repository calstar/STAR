#include "board_exti.h"

#include "board_time.h"
#include "main.h"

typedef struct {
    uint16_t pin;
    osThreadId_t volatile thread;
    uint32_t volatile flags;
    uint32_t volatile last_us;
} route_t;

static route_t routes[] = {
    {IMU_INT1_Pin, NULL, 0, 0},
    {ACCEL_INT_1_Pin, NULL, 0, 0},
    {RADIO_DIO1_Pin, NULL, 0, 0},
    {ETH_INT_Pin, NULL, 0, 0},
};

static route_t* find(uint16_t pin) {
    for (unsigned i = 0; i < sizeof(routes) / sizeof(routes[0]); ++i) {
        if (routes[i].pin == pin) {
            return &routes[i];
        }
    }
    return NULL;
}

bool board_exti_route(uint16_t pin, osThreadId_t thread, uint32_t flags) {
    route_t* r = find(pin);
    if (!r || !thread || !flags) {
        return false;
    }
    r->flags = flags;
    r->thread = thread; /* last: the ISR reads thread, then flags */
    return true;
}

uint32_t board_exti_last_us(uint16_t pin) {
    route_t* r = find(pin);
    return r ? r->last_us : 0U;
}

/* HAL weak override, called from each EXTIx_IRQHandler. */
void HAL_GPIO_EXTI_Callback(uint16_t pin) {
    route_t* r = find(pin);
    if (!r) {
        return;
    }
    r->last_us = board_time_us();
    osThreadId_t thread = r->thread;
    if (thread) {
        (void)osThreadFlagsSet(thread, r->flags); /* ISR-safe */
    }
}
