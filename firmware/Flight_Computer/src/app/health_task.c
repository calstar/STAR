#include "health_task.h"

#include <stddef.h>

#include "FreeRTOS.h"
#include "board.h"
#include "board_time.h"
#include "board_watchdog.h"
#include "cmsis_os2.h"
#include "task.h"

static health_t monitor;
static health_core_t core;
static rec_health_t latest;
static bool have_latest;
static uint32_t sleep_offset, tick_at_sleep;
static bool started;
static uint32_t now(void) {
    return board_now_ms() + sleep_offset;
}
void health_task_init(void) {
    sleep_offset = 0;
    started = false;
    health_init(&monitor, now());
    health_core_init(&core, (record_sink_t){health_board_record, NULL});
    have_latest = false;
}
void health_task_beat(health_id_t id) {
    taskENTER_CRITICAL();
    health_beat(&monitor, id, now());
    taskEXIT_CRITICAL();
}
void health_task_set_active(health_id_t id, bool on) {
    taskENTER_CRITICAL();
    health_set_active(&monitor, id, on, now());
    taskEXIT_CRITICAL();
}
bool health_task_latest(rec_health_t* out) {
    taskENTER_CRITICAL();
    bool ok = have_latest;
    if (ok)
        *out = latest;
    taskEXIT_CRITICAL();
    return ok;
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
/* Only this task writes core; others read the copy in latest. */
static void sample(uint32_t faults) {
    uint32_t t = health_board_clock_ms();
    if (!health_core_due(&core, t, health_board_interval_ms()))
        return;
    health_inputs_t in;
    (void)health_board_read(&in);
    health_core_sample(&core, &in, faults, t, board_time_us());
    taskENTER_CRITICAL();
    latest = core.latest;
    have_latest = true;
    taskEXIT_CRITICAL();
}
static void run(void* arg) {
    (void)arg;
    for (;;) {
        taskENTER_CRITICAL();
        if (health_check(&monitor, now()))
            board_watchdog_refresh();
        uint32_t faults = monitor.faults;
        taskEXIT_CRITICAL();
        sample(faults);
        osDelay((osKernelGetTickFreq() + 9U) / 10U);
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
