#ifndef STAR_LED_SHOW_H
#define STAR_LED_SHOW_H

/*
 * Which lamp is on at one moment. No HAL: the bring-up task writes the pins.
 *
 * LED1 (PB9) is yellow. LED2 (PE0) is green. There is no third colour.
 *
 * Judgment, agreed with Inez on 2026-11-13: ARMED is a fast green blink,
 * not solid green. Solid green stays "self-test FAIL" and is never replaced
 * by the armed blink, so a failed required chip is still obvious on the pad.
 * WARN keeps blinking with the yellow heartbeat and does not block arming.
 *
 *   checks running     yellow fast (the bring-up task, before this runs)
 *   after the checks   yellow 1 Hz; green off / with yellow / solid
 *                      for READY / WARN / FAIL
 *   Idle               yellow one short flash each wake (~10 s);
 *                      green solid on FAIL, on during that flash on WARN
 *   first Arm frame    yellow double-blink until the second frame or timeout;
 *                      green stays solid only for FAIL
 *   ARMED and later    yellow off; green fast blink, or solid if FAIL
 */

#include <stdbool.h>
#include <stdint.h>

#include "boot_report.h"
#include "flight_state.h"

#ifdef __cplusplus
extern "C" {
#endif

#define LED_SHOW_HEARTBEAT_ON_MS \
    100U /* yellow on-time of the 1 Hz alive blink */
#define LED_SHOW_FAST_HALF_MS \
    80U /* armed green, and each half of a double-blink */
#define LED_SHOW_DOUBLE_PERIOD_MS 400U

typedef struct {
    bool yellow;
    bool green;
} led_lamps_t;

/* idle_awake: the Idle task is in its wake (the 10 s flash). Ignored unless
 * the state is IDLE and no Arm confirm is pending. */
led_lamps_t led_show(flight_state_t state, boot_verdict_t verdict,
                     bool arm_pending, uint32_t now_ms, bool idle_awake);

#ifdef __cplusplus
}
#endif
#endif
