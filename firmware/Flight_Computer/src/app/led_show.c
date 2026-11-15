#include "led_show.h"

static bool pulse(uint32_t now_ms, uint32_t on_ms, uint32_t period_ms) {
    return (now_ms % period_ms) < on_ms;
}

/* Two short flashes, then a gap. 80 on, 80 off, 80 on, 160 off. */
static bool double_blink(uint32_t now_ms) {
    uint32_t phase = now_ms % LED_SHOW_DOUBLE_PERIOD_MS;
    return phase < LED_SHOW_FAST_HALF_MS ||
           (phase >= 2U * LED_SHOW_FAST_HALF_MS &&
            phase < 3U * LED_SHOW_FAST_HALF_MS);
}

static bool fast_blink(uint32_t now_ms) {
    return ((now_ms / LED_SHOW_FAST_HALF_MS) % 2U) == 0U;
}

led_lamps_t led_show(flight_state_t state, boot_verdict_t verdict,
                     bool arm_pending, uint32_t now_ms, bool idle_awake) {
    led_lamps_t lamps = {false, false};
    bool fail = verdict == BOOT_FAIL;
    bool warn = verdict == BOOT_WARN;

    if (state == FLIGHT_IDLE && arm_pending) {
        lamps.yellow = double_blink(now_ms);
        lamps.green = fail;
        return lamps;
    }
    if (state >= FLIGHT_ARMED && state < FLIGHT_STATE_COUNT) {
        lamps.yellow = false;
        lamps.green = fail || fast_blink(now_ms);
        return lamps;
    }
    if (state == FLIGHT_IDLE) {
        lamps.yellow = idle_awake;
        lamps.green = fail || (warn && idle_awake);
        return lamps;
    }
    /* SELF_TEST, or a state this board does not use yet: the alive blink. */
    lamps.yellow = pulse(now_ms, LED_SHOW_HEARTBEAT_ON_MS, 1000U);
    lamps.green = fail || (warn && lamps.yellow);
    return lamps;
}
