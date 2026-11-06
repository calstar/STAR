#include "app.h"

#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "gnss_task.h"
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

bool app_start(void) {
    bool ok = start_emmc();
    ok = sensors_task_start() && ok;
    ok = gnss_task_start() && ok;
    return ok;
}
