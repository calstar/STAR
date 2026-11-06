#include "sensors_task.h"

#include "board_devbus.h"
#include "board_exti.h"
#include "board_time.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "health_task.h"
#include "main.h"

#define EV_MODE (1U << 4) /* sensors_task_set_active() */

static sensors_core_t core;
static osMutexId_t snapshot_lock;
static osThreadId_t thread;
static volatile bool want_active; /* written by the mode, read here */

static void to_emmc(void* ctx, uint8_t type, const void* data, uint8_t len) {
    (void)ctx;
    /* Non-blocking; false outside ARMED/LAUNCHED/RECOVERY or when every
     * chunk is full (the log counts and reports drops itself). */
    (void)emmc_log_append(emmc_stm32_log(), type, osKernelGetTickCount(), data,
                          len);
}

static void sensors_task(void* argument) {
    (void)argument;
    osThreadId_t self = osThreadGetId();
    board_exti_route(IMU_INT1_Pin, self, SENSORS_EV_IMU);
    board_exti_route(ACCEL_INT_1_Pin, self, SENSORS_EV_HIGHG);

    core.imu_bus = board_devbus(BOARD_SPI_IMU);
    core.highg_bus = board_devbus(BOARD_SPI_HIGH_G);
    core.baro_bus = board_devbus(BOARD_SPI_BARO);
    core.sink.record = to_emmc;

    bool active = false; /* chips sit in power-down until the first start */
    for (;;) {
        if (!want_active) {
            if (active) {
                osMutexAcquire(snapshot_lock, osWaitForever);
                sensors_core_stop(&core); /* Idle: power down */
                osMutexRelease(snapshot_lock);
                active = false;
            }
            health_task_set_active(HEALTH_SENSORS, false);
            (void)osThreadFlagsWait(EV_MODE, osFlagsWaitAny, osWaitForever);
            continue;
        }
        if (!active) {
            health_task_set_active(HEALTH_SENSORS, true);
            osMutexAcquire(snapshot_lock, osWaitForever);
            sensors_core_init(&core, board_time_us());
            osMutexRelease(snapshot_lock);
            active = true;
        }
        uint32_t wait_us = sensors_core_wait_us(&core, board_time_us());
        uint32_t ticks = (wait_us + 999U) / 1000U; /* 1 kHz tick */
        uint32_t flags = osThreadFlagsWait(
            SENSORS_EV_IMU | SENSORS_EV_HIGHG | EV_MODE, osFlagsWaitAny, ticks);
        if (flags & osFlagsError) {
            flags = 0; /* timeout: deadlines only */
        }
        flags &= ~EV_MODE; /* re-checked at the top of the loop */
        osMutexAcquire(snapshot_lock, osWaitForever);
        sensors_core_step(&core, flags, board_exti_last_us(IMU_INT1_Pin),
                          board_exti_last_us(ACCEL_INT_1_Pin), board_time_us());
        osMutexRelease(snapshot_lock);
        health_task_beat(HEALTH_SENSORS);
    }
}

void sensors_task_snapshot(sensors_core_t* out) {
    osMutexAcquire(snapshot_lock, osWaitForever);
    *out = core;
    osMutexRelease(snapshot_lock);
}

bool sensors_task_start(void) {
    static const osMutexAttr_t lock_attr = {"sensors", osMutexPrioInherit, NULL,
                                            0};
    static const osThreadAttr_t attr = {
        .name = "sensors",
        .stack_size = 2048,
        .priority = osPriorityRealtime,
    };
    snapshot_lock = osMutexNew(&lock_attr);
    thread = snapshot_lock ? osThreadNew(sensors_task, NULL, &attr) : NULL;
    return thread != NULL;
}

void sensors_task_set_active(bool on) {
    want_active = on;
    if (thread) {
        (void)osThreadFlagsSet(thread, EV_MODE);
    }
}
