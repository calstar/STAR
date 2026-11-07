#include "fake_air.h"

static uint32_t g_rx_ms;
static uint32_t g_sleep_ms;

void fake_air_configure(uint32_t rx_ms, uint32_t sleep_ms) {
    g_rx_ms = rx_ms;
    g_sleep_ms = sleep_ms;
}

bool fake_air_packet_heard(uint32_t cycle_offset_ms, uint32_t preamble_ms) {
    if (preamble_ms == 0)
        return false;
    // A preamble longer than the sleep period must overlap some listen window.
    if (preamble_ms > g_sleep_ms)
        return true;

    const uint32_t period = g_rx_ms + g_sleep_ms;
    // Normalize to [0, period).
    const uint32_t offset = cycle_offset_ms % period;

    // The preamble occupies [offset, offset + preamble_ms) across one or more
    // cycle periods. It overlaps the listen window [0, rx_ms) if:
    //   - it starts before the listen window ends (offset < rx_ms), OR
    //   - it wraps past the end of the cycle into the next listen window.
    if (offset < g_rx_ms)
        return true;
    if (offset + preamble_ms > period)
        return true;
    return false;
}

float fake_air_average_current_ma(float rx_ma, float sleep_ua) {
    const float period = (float)(g_rx_ms + g_sleep_ms);
    return (rx_ma * (float)g_rx_ms + (sleep_ua / 1000.0f) * (float)g_sleep_ms) /
           period;
}
