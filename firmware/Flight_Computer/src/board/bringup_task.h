#ifndef STAR_BRINGUP_TASK_H
#define STAR_BRINGUP_TASK_H

/*
 * Boot-time bring-up: power/reset sequencing, then Pranay's self-test
 * coordinator over every chip, then an analog snapshot.
 *
 * Results, with no console yet. After the checks, src/app/led_show.h
 * decides the lamps. Solid green is self-test FAIL and stays solid when
 * the rocket arms. LED2 on and LED1 stopped means Error_Handler halted.
 *   g_bringup_report  watch it in the debugger (PlatformIO Debug, ST-Link)
 *
 * Nothing here enables a pyro output or transmits on the radio.
 */

#include <stdbool.h>
#include <stdint.h>

#include "board_adc.h"
#include "board_bringup.h"
#include "boot_report.h"
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
    bool app_started; /* app_start(): every application task created */
    /* Verdict, battery (mV, OK/WARN/FAIL/USB), result_bits, and the same
     * thing as text: in gdb, printf "%s", g_bringup_report.report.text */
    boot_report_t report;
} bringup_report_t;

extern bringup_report_t g_bringup_report;

/* The board context (ADC ready, chips powered), for the Idle battery read. */
board_bringup_t* bringup_task_board(void);

/* Create the bring-up task. Call between osKernelInitialize/osKernelStart. */
void bringup_task_start(void);

/* Idle calls these around its wake. awake is the 10 s yellow flash. */
void bringup_leds_note_awake(bool on);
void bringup_leds_refresh(void);

#ifdef __cplusplus
}
#endif
#endif
