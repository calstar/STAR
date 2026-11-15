/* The pad lamps. Solid green is FAIL and must survive arming. */
#include <stdio.h>
#include <stdlib.h>

#include "led_show.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void test_idle_flash(void) {
    led_lamps_t on = led_show(FLIGHT_IDLE, BOOT_READY, false, 0, true);
    led_lamps_t off = led_show(FLIGHT_IDLE, BOOT_READY, false, 0, false);
    CHECK(on.yellow && !on.green);
    CHECK(!off.yellow && !off.green);

    led_lamps_t warn = led_show(FLIGHT_IDLE, BOOT_WARN, false, 0, true);
    led_lamps_t warn_asleep = led_show(FLIGHT_IDLE, BOOT_WARN, false, 0, false);
    CHECK(warn.yellow && warn.green);
    CHECK(!warn_asleep.yellow && !warn_asleep.green);

    led_lamps_t fail = led_show(FLIGHT_IDLE, BOOT_FAIL, false, 5000, false);
    CHECK(!fail.yellow && fail.green);
}

static void test_pending_is_a_yellow_double_blink(void) {
    led_lamps_t a = led_show(FLIGHT_IDLE, BOOT_READY, true, 0, false);
    led_lamps_t gap = led_show(FLIGHT_IDLE, BOOT_READY, true, 100, false);
    led_lamps_t b = led_show(FLIGHT_IDLE, BOOT_READY, true, 180, false);
    led_lamps_t rest = led_show(FLIGHT_IDLE, BOOT_READY, true, 300, false);
    CHECK(a.yellow && !gap.yellow && b.yellow && !rest.yellow);
    CHECK(!a.green && !b.green);

    /* FAIL stays solid through the double-blink. */
    led_lamps_t fail = led_show(FLIGHT_IDLE, BOOT_FAIL, true, 0, true);
    CHECK(fail.yellow && fail.green);
}

static void test_armed_blinks_unless_failed(void) {
    led_lamps_t on = led_show(FLIGHT_ARMED, BOOT_READY, false, 0, true);
    led_lamps_t off = led_show(FLIGHT_ARMED, BOOT_READY, false, 80, true);
    CHECK(!on.yellow && on.green);
    CHECK(!off.yellow && !off.green);

    /* The judgment: a failed board stays solid green when armed. */
    led_lamps_t fail_on = led_show(FLIGHT_ARMED, BOOT_FAIL, false, 0, false);
    led_lamps_t fail_off = led_show(FLIGHT_ARMED, BOOT_FAIL, false, 80, false);
    CHECK(!fail_on.yellow && fail_on.green);
    CHECK(!fail_off.yellow && fail_off.green);

    led_lamps_t flying = led_show(FLIGHT_LAUNCHED, BOOT_WARN, false, 0, false);
    CHECK(!flying.yellow && flying.green);
}

static void test_after_checks_still_shows_warn_and_fail(void) {
    led_lamps_t ready = led_show(FLIGHT_SELF_TEST, BOOT_READY, false, 0, false);
    led_lamps_t ready_off =
        led_show(FLIGHT_SELF_TEST, BOOT_READY, false, 200, false);
    CHECK(ready.yellow && !ready.green);
    CHECK(!ready_off.yellow && !ready_off.green);

    led_lamps_t warn = led_show(FLIGHT_SELF_TEST, BOOT_WARN, false, 0, false);
    CHECK(warn.yellow && warn.green);
    led_lamps_t fail = led_show(FLIGHT_SELF_TEST, BOOT_FAIL, false, 200, false);
    CHECK(!fail.yellow && fail.green);
}

int main(void) {
    test_idle_flash();
    test_pending_is_a_yellow_double_blink();
    test_armed_blinks_unless_failed();
    test_after_checks_still_shows_warn_and_fail();
    puts("led_show checks passed");
    return 0;
}
