#ifndef STAR_BOARD_SLEEP_H
#define STAR_BOARD_SLEEP_H

/*
 * Sleep in Stop mode on the RTC wakeup timer (Idle: ~10 s between LoRa
 * heartbeats). RM0468 Rev 3:
 *   Stop = D1 and D2 in DStop, system Stop; any EXTI wakes it, including
 *   the RTC wakeup timer and DIO1 (PB2, EXTI2) (p.259). After wake the
 *   system clock is HSI (STOPWUCK, p.333); SystemClock_Config() restores
 *   it. RAM and GPIO levels are kept, so pyro outputs stay low (never
 *   written here).
 *   NRST_STOP_D1 = 0 makes D1 DStop a reset (p.208): then Stop is refused
 *   and board_sleep() waits awake instead.
 *   With a debugger attached, DBGMCU keeps SWD alive in Stop (p.3230); not
 *   set otherwise, so flight current is not spent on it.
 * Time: the RTC calendar is read before and after, scaled by the LSI rate
 * measured at init (sleep_math.h), and FreeRTOS catches up on the ticks it
 * missed, so osKernelGetTickCount() and uptime include the sleep.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool ready;        /* RTC running, LSI measured */
    bool stop_allowed; /* NRST_STOP_D1 = 1 in the option bytes */
    uint32_t lsi_hz;   /* measured against TIM2 */
    uint32_t sleeps, rtc_wakes, early_wakes;
    uint32_t awake_waits; /* sleeps refused: not ready or NRST_STOP_D1 = 0 */
    uint32_t last_slept_ms;
} board_sleep_info_t;

/* Once, from a task, after board_time_start(): ~0.5 s to measure LSI. */
bool board_sleep_init(void);

/* Sleep up to `ms` in Stop. Returns the ms that really passed. Wakes early
 * on any EXTI (radio DIO1). Other tasks are frozen until it returns.
 * wake_now (may be NULL) is checked with the scheduler already suspended:
 * true means work arrived just before (a queued command), so it returns 0
 * without sleeping. Not ready / NRST_STOP_D1 = 0: returns 0 at once; the
 * caller waits awake instead (board_sleep_info().stop_allowed). */
uint32_t board_sleep(uint32_t ms, bool (*wake_now)(void));

const board_sleep_info_t* board_sleep_info(void);

#ifdef __cplusplus
}
#endif
#endif
