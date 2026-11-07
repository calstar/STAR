#include "app.h"

#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "gnss_task.h"
#include "idle_task.h"
#include "mode.h"
#include "radio_task.h"
#include "sensors_task.h"

static bool start_emmc(void) {
    static const osThreadAttr_t attr = {
        .name = "emmc",
        .stack_size = 1024, /* emmc_stm32_writer_task: ~1 KB */
        .priority = osPriorityLow,
    };
    if (emmc_stm32_init() != EMMC_OK) {
        return false;
    }
    return osThreadNew(emmc_stm32_writer_task, NULL, &attr) != NULL;
}

static void on_radio_command(radio_command_t command) {
    app_command(command == RADIO_CMD_ARM ? MODE_CMD_ARM : MODE_CMD_DISARM);
}

bool app_start(void) {
    bool ok = start_emmc();
    ok = sensors_task_start() && ok;
    ok = gnss_task_start() && ok;
    ok = radio_task_start() && ok;
    ok = idle_task_start() && ok;
    radio_task_on_command(on_radio_command);
    /* Every task starts stopped; the state decides what runs (mode_core). */
    app_set_state(FLIGHT_IDLE);
    return ok;
}
