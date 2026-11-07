#ifndef STAR_IDLE_TASK_H
#define STAR_IDLE_TASK_H

/*
 * The Idle loop on the board: Aaron's idle.c (PR #162, src/app/IDLE.md) with
 * the real adapters, sleeping in Stop between heartbeats (board_sleep).
 *
 *   read_battery    board_bringup_read_battery (PA0, mean of 16)
 *   on_usb_power    board_bringup_on_usb (SW_ST, PE10)
 *   send_heartbeat  Ryan's Heartbeat frame over the radio task, PASS only
 *                   after TxDone: state u8 (IDLE), battery_mV u16 (0 on
 *                   USB or an unread ADC: never USB's 5 V as the pack),
 *                   uptime_s u32 (src/radio/frame.h). The previous-send result
 *                   and failure count do not fit the 7-byte frame (#162
 *                   open question 3).
 *   poll_command    commands the radio task's ARM gate confirmed
 * An Arm -> ARM_REQUESTED -> app_set_state(ARMED): sensors, GPS and the
 * eMMC log start. ARMED is "record", never pyro.
 * LED1 is on while the board is awake in Idle: one short flash every 10 s.
 */

#include <stdbool.h>

#include "idle.h"
#include "mode_core.h"

#ifdef __cplusplus
extern "C" {
#endif

bool idle_task_start(void);
void idle_task_set_active(bool on);
void idle_task_command(mode_command_t command);

/* The Idle instance, read-only (last heartbeat, schedule). */
const idle_t* idle_task_state(void);

#ifdef __cplusplus
}
#endif
#endif
