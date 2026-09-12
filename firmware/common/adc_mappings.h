#pragma once
#include "STAR_ADS126X.h"

// Compile-time check of the datasheet's filter/rate pairing rules:
//   SINC1-4 : rates <= 7200 SPS
//   SINC5   : rates 14400 / 19200 / 38400 SPS only
//   FIR     : rates 2.5 / 5 / 10 / 20 SPS only  (it is a fixed 50/60 Hz
//             rejection filter and is not defined at any other rate)
//
// The previous version classified filters as "SINC1-4 or not", which put FIR
// in the high-rate bucket: it rejected the only rates FIR actually supports
// and accepted FIR at 38400 SPS, where the part does not offer it.
constexpr bool ads126x_filter_rate_valid(uint8_t filter, uint8_t data_rate) {
    const bool high_rate =
        (data_rate == ADS126X_RATE_14400 || data_rate == ADS126X_RATE_19200 ||
         data_rate == ADS126X_RATE_38400);
    const bool fir_rate =
        (data_rate == ADS126X_RATE_2_5 || data_rate == ADS126X_RATE_5 ||
         data_rate == ADS126X_RATE_10 || data_rate == ADS126X_RATE_20);
    const bool is_sinc1to4 =
        (filter == ADS126X_SINC1 || filter == ADS126X_SINC2 ||
         filter == ADS126X_SINC3 || filter == ADS126X_SINC4);
    if (filter == ADS126X_FIR)
        return fir_rate;
    if (filter == ADS126X_SINC5)
        return high_rate;
    return is_sinc1to4 && !high_rate;
}

#define ADS126X_ASSERT_FILTER_RATE(filter, rate)                       \
    static_assert(                                                     \
        ads126x_filter_rate_valid((uint8_t)(filter), (uint8_t)(rate)), \
        "Invalid FILTER/DATA_RATE combination: "                       \
        "rates <= 7200 SPS require SINC1-4; "                          \
        "rates 14400/19200/38400 SPS require SINC5")

// From page 64 of ADS126X datasheet
constexpr uint8_t baseSettlePulses(uint8_t f) {
    switch (f) {
        case ADS126X_FIR:
            return 1;
        case ADS126X_SINC1:
            return 1;
        case ADS126X_SINC2:
            return 2;
        case ADS126X_SINC3:
            return 3;
        case ADS126X_SINC4:
            return 4;
        case ADS126X_SINC5:
            return 5;
        default:
            return 1;  // safe fallback
    }
}

constexpr uint8_t settlePulses(uint8_t filter, uint8_t data_rate,
                               bool chop_enabled = false,
                               bool idac_rotation_enabled = false) {
    if (data_rate == ADS126X_RATE_38400)
        return 5;

    uint8_t n = baseSettlePulses(filter);

    if (chop_enabled)
        n *= 2;
    if (idac_rotation_enabled)
        n *= 2;

    return n;
}
