#ifndef STAR_BATTERY_H
#define STAR_BATTERY_H

/*
 * Battery adapter: PA0 counts -> millivolts -> health. Portable.
 *
 * Schematic rev 1:
 *   p.12  TPS2121 (U17) picks the supply: IN1 = VBAT, IN2 = USB_5V; the
 *         battery wins while above ~3.5 V (PR1 divider R66/R69). Its output
 *         is VDD. ST (SW_ST, PE10) is pulled up by R65: HIGH = battery,
 *         LOW = USB (TPS2121 datasheet p.21).
 *   p.2   VDD -> R1 22k / R3 10k (x 0.3125) -> TLV9004 follower -> PA0.
 *         VREF+ = VDDA = 3V3 through FB1.
 *   p.12  3V3 = TPS562201, 0.768 V x (1 + 33.2k/10k) = 3.318 V, ~ +/-2 %.
 * So mV = counts x (3320 / 0.3125) / 65535 = counts x 10624 / 65535, the
 * same conversion as Aaron's idle module (PR #162).
 *
 * On USB the reading is the USB supply, never battery health (#137).
 * Pack: 2S Li-ion, 7.4 V nominal / 8.4 V full (DEVICE_CHECKS.md).
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BATTERY_MV_AT_FULL_SCALE 10624U /* 3320 mV / 0.3125 */
#define BATTERY_ADC_FULL_SCALE 65535U   /* ADC1, 16-bit */
/* Proposals, not approved (#137, PR #162): the same numbers as idle. */
#define BATTERY_WARN_MV 7000U
#define BATTERY_FAIL_MV 6600U
/* Above a full 2S pack plus the +2 % reference error: wrong pack or a
 * broken divider, so the number cannot be trusted. */
#define BATTERY_MAX_MV 8800U

typedef enum {
    BATTERY_UNKNOWN = 0, /* not read yet */
    BATTERY_OK,
    BATTERY_WARN,   /* below BATTERY_WARN_MV: charge before flight */
    BATTERY_FAIL,   /* below BATTERY_FAIL_MV, or above BATTERY_MAX_MV */
    BATTERY_USB,    /* on USB: the reading is not the pack */
    BATTERY_INVALID /* ADC read failed */
} battery_state_t;

typedef struct {
    battery_state_t state;
    uint16_t mv; /* supply in mV (USB's when on USB); 0 if not read */
    uint16_t counts;
} battery_t;

/* Rounded to the nearest mV; 0 above full scale. */
uint16_t battery_counts_to_mv(uint32_t counts);

/* One reading -> health. valid: the ADC returned a sample. */
battery_t battery_assess(bool valid, uint32_t counts, bool on_usb);

const char* battery_state_name(battery_state_t state);

#ifdef __cplusplus
}
#endif
#endif
