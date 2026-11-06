#include "health_task.h"

#include <stddef.h>

#include "FreeRTOS.h"
#include "board.h"
#include "board_watchdog.h"
#include "cmsis_os2.h"
#include "task.h"

static health_t monitor;
static uint32_t sleep_offset, tick_at_sleep;
static bool started;
static uint32_t now(void) {
    return board_now_ms() + sleep_offset;
}
void health_task_init(void) {
    sleep_offset = 0;
    started = false;
    health_init(&monitor, now());
}
void health_task_beat(health_id_t id) {
    taskENTER_CRITICAL();
    health_beat(&monitor, id, now());
    taskEXIT_CRITICAL();
}
uint32_t health_task_faults(void) {
    taskENTER_CRITICAL();
    uint32_t faults = monitor.faults;
    taskEXIT_CRITICAL();
    return faults;
}
bool health_task_prepare_sleep(uint32_t duration_ms) {
    taskENTER_CRITICAL();
    bool ok = started && health_prepare_sleep(&monitor, now(), duration_ms);
    if (ok) {
        tick_at_sleep = board_now_ms();
        board_watchdog_refresh();
    }
    taskEXIT_CRITICAL();
    return ok;
}
bool health_task_resume(uint32_t elapsed_ms) {
    taskENTER_CRITICAL();
    uint32_t tick_elapsed_ms = board_now_ms() - tick_at_sleep;
    bool ok = false;
    if (started && monitor.sleeping) {
        if (elapsed_ms < tick_elapsed_ms ||
            elapsed_ms > HEALTH_MAX_SLEEP_MS + HEALTH_WAKE_MARGIN_MS) {
            monitor.faults |= HEALTH_ALL;
            monitor.sleeping = false;
        } else {
            sleep_offset += elapsed_ms - tick_elapsed_ms;
            ok = health_resume(&monitor, now());
            if (ok)
                board_watchdog_refresh();
        }
    }
    taskEXIT_CRITICAL();
    return ok;
}
static void run(void* arg) {
    (void)arg;
    for (;;) {
        taskENTER_CRITICAL();
        if (health_check(&monitor, now()))
            board_watchdog_refresh();
        taskEXIT_CRITICAL();
        osDelay((osKernelGetTickFreq() + 3U) / 4U);
    }
}
bool health_task_start(void) {
    static const osThreadAttr_t attr = {
        .name = "health",
        .stack_size = 1024,
        .priority = osPriorityLow,
    };
    if (!board_watchdog_start()) {
        monitor.faults |= HEALTH_ALL;
        return false;
    }
    started = true;
    /* If allocation fails the running IWDG resets; there is no feeder. */
    return osThreadNew(run, NULL, &attr) != NULL;
}
