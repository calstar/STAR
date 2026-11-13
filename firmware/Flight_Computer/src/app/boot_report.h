#ifndef STAR_BOOT_REPORT_H
#define STAR_BOOT_REPORT_H

/*
 * The start-up self-test, summarised. Portable (no HAL), so the host tests
 * check the exact verdict and text the board produces.
 *
 *   verdict   FAIL   a required chip did not pass, or the battery is FAIL
 *                    or unreadable
 *             WARN   an optional chip did not pass, or the battery is low
 *             READY  everything passed (on USB the battery is not judged)
 *   result_bits      bit <device id> set when that chip passed: the
 *                    SelfTest radio frame's result_bits (src/radio/frame.h)
 *   text             one line per check, for a person (ST-Link, later radio
 *                    or USB)
 * Required vs optional comes from the self-test config (#137 section 7, a
 * proposal: this decides LED2 and the verdict, not arming).
 */

#include <stddef.h>
#include <stdint.h>

#include "battery.h"
#include "self_test_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { BOOT_READY = 0, BOOT_WARN, BOOT_FAIL } boot_verdict_t;

#define BOOT_REPORT_TEXT_MAX 768U

/* Why the chip last reset: RCC_RSR bits, RM0468 Rev 3 (board_watchdog.c
 * checks them against the CMSIS names). An internal reset also pulls NRST,
 * so PIN is set alongside the real cause. */
#define BOOT_RESET_BROWN_OUT (1UL << 21)
#define BOOT_RESET_PIN (1UL << 22)
#define BOOT_RESET_POWER_ON (1UL << 23)
#define BOOT_RESET_SOFTWARE (1UL << 24)
#define BOOT_RESET_IWDG (1UL << 26)
#define BOOT_RESET_WWDG (1UL << 28)
#define BOOT_RESET_LOW_POWER (1UL << 30)

typedef struct {
    boot_verdict_t verdict;
    uint16_t result_bits;
    uint8_t required_failed, optional_failed;
    battery_t battery;
    uint32_t reset_flags; /* boot_report_add_reset */
    char text[BOOT_REPORT_TEXT_MAX];
} boot_report_t;

/* status: the coordinator's final status (NULL: self-test never ran). */
void boot_report_build(boot_report_t* report, const self_test_status_t* status,
                       battery_t battery, uint32_t now_ms);

const char* boot_verdict_name(boot_verdict_t verdict);

/* The reset cause, most specific first: IWDG, WWDG, low-power, software,
 * power-on, brown-out, pin. "unknown" with no flag set. */
const char* boot_reset_name(uint32_t flags);

/* After boot_report_build: keep flags and add a "reset" line to text. Does
 * not change the verdict; a watchdog reset is for a person to see. */
void boot_report_add_reset(boot_report_t* report, uint32_t flags);

#ifdef __cplusplus
}
#endif
#endif
