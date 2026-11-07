#include "sleep_math.h"

uint16_t sleep_wut_reload(uint32_t ms, uint32_t lsi_hz) {
    uint64_t ticks = (uint64_t)ms * lsi_hz / (1000ULL * SLEEP_WUT_DIV);
    if (ticks < 1U) {
        ticks = 1U;
    }
    if (ticks > 65536U) {
        ticks = 65536U;
    }
    return (uint16_t)(ticks - 1U);
}

uint32_t sleep_rtc_steps(uint8_t hours, uint8_t minutes, uint8_t seconds,
                         uint32_t ssr) {
    uint32_t s = (uint32_t)hours * 3600U + (uint32_t)minutes * 60U + seconds;
    if (ssr > SLEEP_RTC_SYNC_DIV - 1U) {
        ssr = SLEEP_RTC_SYNC_DIV - 1U;
    }
    return s * SLEEP_RTC_SYNC_DIV + (SLEEP_RTC_SYNC_DIV - 1U - ssr);
}

uint32_t sleep_elapsed_ms(uint32_t from_steps, uint32_t to_steps,
                          uint32_t lsi_hz) {
    uint32_t steps =
        (to_steps + SLEEP_DAY_STEPS - from_steps) % SLEEP_DAY_STEPS;
    if (lsi_hz == 0U) {
        return 0U;
    }
    return (uint32_t)((uint64_t)steps * SLEEP_RTC_ASYNC_DIV * 1000ULL / lsi_hz);
}

uint32_t sleep_lsi_hz(uint32_t steps, uint32_t us) {
    if (us == 0U) {
        return 0U;
    }
    return (uint32_t)((uint64_t)steps * SLEEP_RTC_ASYNC_DIV * 1000000ULL / us);
}
