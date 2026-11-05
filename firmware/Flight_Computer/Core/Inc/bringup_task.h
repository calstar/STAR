#ifndef STAR_BRINGUP_TASK_H
#define STAR_BRINGUP_TASK_H

/*
 * Boot-time bring-up: power/reset sequencing, then Pranay's self-test
 * coordinator over every chip, then an analog snapshot.
 *
 * Results, with no console yet:
 *   LED1 (PB9)  fast blink while checks run, then 1 Hz forever (alive)
 *   LED2 (PE0)  on if a REQUIRED check did not pass
 *               (LED2 on + LED1 stopped = Error_Handler halted the chip)
 *   g_bringup_report  watch it in the debugger (PlatformIO Debug, ST-Link)
 *
 * Nothing here enables a pyro output or transmits on the radio.
 */

#include <stdbool.h>
#include <stdint.h>

#include "board_adc.h"
#include "self_test_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool finished;
    uint32_t finished_at_ms;
    /* Copy of the coordinator's status: per device, result + diagnostic +
     * attempts. Device IDs: self_test_devices.h. Diagnostics: board_*.h. */
    self_test_status_t self_test;
    /* Raw counts of every ADC input, taken after the checks. */
    board_adc_snapshot_t analog;
} bringup_report_t;

extern bringup_report_t g_bringup_report;

/* Create the bring-up task. Call between osKernelInitialize/osKernelStart. */
void bringup_task_start(void);

#ifdef __cplusplus
}
#endif
#endif
