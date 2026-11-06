#include "mode.h"

#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "gnss_task.h"
#include "idle_task.h"
#include "main.h"
#include "sensors_task.h"

static osMutexId_t lock;
static volatile flight_state_t state = FLIGHT_SELF_TEST;

static void take(void) {
    if (!lock) {
        static const osMutexAttr_t attr = {"mode", osMutexPrioInherit, NULL, 0};
        lock = osMutexNew(&attr);
    }
    (void)osMutexAcquire(lock, osWaitForever);
}

void app_set_state(flight_state_t to) {
    if (to >= FLIGHT_STATE_COUNT) {
        return;
    }
    take();
    flight_state_t from = state;
    if (to != from) {
        state = to;
        mode_outputs_t o = mode_outputs(to);
        /* The W5500 leaves reset before anything could use it. */
        HAL_GPIO_WritePin(ETH_RST_GPIO_Port, ETH_RST_Pin,
                          o.ethernet ? GPIO_PIN_SET : GPIO_PIN_RESET);
        sensors_task_set_active(o.sensors);
        gnss_task_set_active(o.gps);
        idle_task_set_active(o.idle_loop);
        (void)emmc_log_on_state(emmc_stm32_log(), from, to,
                                osKernelGetTickCount());
    }
    (void)osMutexRelease(lock);
}

flight_state_t app_state(void) {
    return state;
}

void app_command(mode_command_t command) {
    flight_state_t next = state;
    switch (mode_route_command(state, command, &next)) {
        case MODE_TO_IDLE_LOOP:
            idle_task_command(command);
            break;
        case MODE_TRANSITION:
            app_set_state(next);
            break;
        default:
            break;
    }
}
