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
 *                    SelfTest radio frame's result_bits (src/frame.h)
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

typedef struct {
    boot_verdict_t verdict;
    uint16_t result_bits;
    uint8_t required_failed, optional_failed;
    battery_t battery;
    char text[BOOT_REPORT_TEXT_MAX];
} boot_report_t;

/* status: the coordinator's final status (NULL: self-test never ran). */
void boot_report_build(boot_report_t* report, const self_test_status_t* status,
                       battery_t battery, uint32_t now_ms);

const char* boot_verdict_name(boot_verdict_t verdict);

#ifdef __cplusplus
}
#endif
#endif
