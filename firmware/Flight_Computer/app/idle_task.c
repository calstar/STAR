#include "idle_task.h"

#include "cmsis_os2.h"
#include "radio_task.h"

// Sniff parameters (DS 13.1.7, p.71). The ground must send Arm/Un-arm with
// a preamble of at least 260 symbols (~1.08 s at SF9/125 kHz) so it outlasts
// the sleep period. Rocket heartbeats keep the short preamble.
#define SNIFF_RX_MS   33u
#define SNIFF_SLEEP_MS 1000u

static void idle_task_fn(void* arg) {
    (void)arg;
    radio_task_start_sniff(SNIFF_RX_MS, SNIFF_SLEEP_MS);
    // The STM32 enters Stop mode in the FreeRTOS idle hook; this task just
    // yields indefinitely. mode.c switches the radio back to continuous RX
    // when arming.
    osDelay(osWaitForever);
}

bool idle_task_start(void) {
    static const osThreadAttr_t attr = {
        .name       = "idle",
        .stack_size = 256,
        .priority   = osPriorityLow,
    };
    return osThreadNew(idle_task_fn, NULL, &attr) != NULL;
}
