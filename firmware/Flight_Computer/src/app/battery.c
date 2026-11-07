#include "battery.h"

uint16_t battery_counts_to_mv(uint32_t counts) {
    if (counts > BATTERY_ADC_FULL_SCALE) {
        return 0U;
    }
    return (uint16_t)((counts * BATTERY_MV_AT_FULL_SCALE +
                       BATTERY_ADC_FULL_SCALE / 2U) /
                      BATTERY_ADC_FULL_SCALE);
}

battery_t battery_assess(bool valid, uint32_t counts, bool on_usb) {
    battery_t b = {BATTERY_INVALID, 0, 0};
    if (!valid || counts > BATTERY_ADC_FULL_SCALE) {
        return b;
    }
    b.counts = (uint16_t)counts;
    b.mv = battery_counts_to_mv(counts);
    if (on_usb) {
        b.state = BATTERY_USB;
    } else if (b.mv < BATTERY_FAIL_MV || b.mv > BATTERY_MAX_MV) {
        b.state = BATTERY_FAIL;
    } else if (b.mv < BATTERY_WARN_MV) {
        b.state = BATTERY_WARN;
    } else {
        b.state = BATTERY_OK;
    }
    return b;
}

const char* battery_state_name(battery_state_t state) {
    switch (state) {
        case BATTERY_OK:
            return "OK";
        case BATTERY_WARN:
            return "LOW, charge before flight";
        case BATTERY_FAIL:
            return "FAIL";
        case BATTERY_USB:
            return "on USB (battery not measured)";
        case BATTERY_INVALID:
            return "ADC read failed";
        default:
            return "not read";
    }
}
