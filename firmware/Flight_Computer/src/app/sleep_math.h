#ifndef STAR_SLEEP_MATH_H
#define STAR_SLEEP_MATH_H

/*
 * Arithmetic for sleeping in Stop on the RTC (board_sleep.c), portable.
 *
 * RTC from LSI (no LSE: PC14/PC15 are pyro pins). Prescalers 127 / 249
 * (firmware.ioc): ck_apre = LSI / 128 drives the sub-second counter SSR,
 * which counts DOWN from 249 to 0, then the seconds tick. One SSR step is
 * 128 / LSI seconds: 4 ms at the nominal 32 kHz, but LSI varies chip to
 * chip and with temperature, so board_sleep measures it against TIM2.
 * Wakeup timer on RTCCLK / 16 (RM0468 51.4.7, p.1950): one WUT tick is
 * 16 / LSI s, reload R wakes after R + 1 ticks, at most 65536 (~32 s).
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SLEEP_RTC_ASYNC_DIV 128U /* AsynchPrediv + 1 */
#define SLEEP_RTC_SYNC_DIV 250U  /* SynchPrediv + 1 */
#define SLEEP_WUT_DIV 16U        /* RTC_WAKEUPCLOCK_RTCCLK_DIV16 */
#define SLEEP_DAY_STEPS (86400UL * SLEEP_RTC_SYNC_DIV)

/* WUT reload for a sleep of `ms` at `lsi_hz` (rounded down, so the board
 * never oversleeps; at least 1 tick, at most 65536). */
uint16_t sleep_wut_reload(uint32_t ms, uint32_t lsi_hz);

/* Calendar time of day -> SSR steps since midnight (seconds x 250 plus the
 * steps already counted down in this second). */
uint32_t sleep_rtc_steps(uint8_t hours, uint8_t minutes, uint8_t seconds,
                         uint32_t ssr);

/* Milliseconds between two stamps, across midnight, at `lsi_hz`. */
uint32_t sleep_elapsed_ms(uint32_t from_steps, uint32_t to_steps,
                          uint32_t lsi_hz);

/* LSI frequency from `steps` SSR steps that took `us` on TIM2 (1 MHz). */
uint32_t sleep_lsi_hz(uint32_t steps, uint32_t us);

#ifdef __cplusplus
}
#endif
#endif
