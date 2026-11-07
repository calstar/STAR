/* sleep_math: wakeup-timer reloads, RTC stamps and elapsed time. Expected
 * values computed independently in Python from RM0468 51.4.7 and the
 * prescalers in firmware.ioc (127 / 249, WUT on RTCCLK / 16). */
#include <stdio.h>
#include <stdlib.h>

#include "sleep_math.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void test_wut_reload(void) {
    CHECK(sleep_wut_reload(10000, 32000) == 19999); /* 20000 ticks */
    /* The measured LSI decides the reload: a slow LSI gets fewer ticks so
     * the real sleep is still 10 s. */
    CHECK(sleep_wut_reload(10000, 29500) == 18436);
    CHECK(sleep_wut_reload(10000, 34500) == 21561);
    CHECK(sleep_wut_reload(1, 32000) == 1);         /* 2 ticks */
    CHECK(sleep_wut_reload(0, 32000) == 0);         /* at least 1 tick */
    CHECK(sleep_wut_reload(60000, 32000) == 65535); /* clamped, ~32.8 s */
}

static void test_rtc_steps_count_down_subseconds(void) {
    /* SSR counts down: 249 is the start of a second, 0 its end. */
    CHECK(sleep_rtc_steps(0, 0, 0, 249) == 0);
    CHECK(sleep_rtc_steps(0, 0, 0, 0) == 249);
    CHECK(sleep_rtc_steps(0, 0, 1, 249) == 250);
    CHECK(sleep_rtc_steps(1, 2, 3, 249) == 3723U * 250U);
}

static void test_elapsed(void) {
    uint32_t a = sleep_rtc_steps(0, 0, 5, 249),
             b = sleep_rtc_steps(0, 0, 15, 249);
    CHECK(sleep_elapsed_ms(a, b, 32000) == 10000);
    /* 10 RTC seconds on a 30 kHz LSI are 10.67 real seconds. */
    CHECK(sleep_elapsed_ms(a, b, 30000) == 10666);
    /* Across midnight. */
    CHECK(sleep_elapsed_ms(sleep_rtc_steps(23, 59, 58, 100),
                           sleep_rtc_steps(0, 0, 8, 100), 32000) == 10000);
    /* A partial sleep (DIO1 woke it): 3.2 s. */
    CHECK(sleep_elapsed_ms(sleep_rtc_steps(0, 0, 5, 249),
                           sleep_rtc_steps(0, 0, 8, 199), 32000) == 3200);
    CHECK(sleep_elapsed_ms(a, a, 32000) == 0);
    CHECK(sleep_elapsed_ms(a, b, 0) == 0);
}

static void test_lsi_measurement(void) {
    CHECK(sleep_lsi_hz(125, 500000) == 32000);
    CHECK(sleep_lsi_hz(125, 533333) == 30000);
    CHECK(sleep_lsi_hz(125, 0) == 0);
}

int main(void) {
    test_wut_reload();
    test_rtc_steps_count_down_subseconds();
    test_elapsed();
    test_lsi_measurement();
    puts("sleep_math: all tests passed");
    return 0;
}
