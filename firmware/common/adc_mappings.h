#pragma once
#include "STAR_ADS126X.h"

// NOTE: ADS126X_SINC5 is not defined in STAR_ADS126X_definitions.h.
// If high data rates (14400 / 19200 / 38400 SPS) are ever needed, add:
//   #define ADS126X_SINC5  0b101   (verify value against datasheet before use)

// Compile-time check: rates <= 7200 SPS require SINC1-4;
//                     rates 14400 / 19200 / 38400 SPS require SINC5.
constexpr bool ads126x_filter_rate_valid(uint8_t filter, uint8_t data_rate)
{
    const bool high_rate    = (data_rate == ADS126X_RATE_14400 ||
                               data_rate == ADS126X_RATE_19200 ||
                               data_rate == ADS126X_RATE_38400);
    const bool is_sinc1to4  = (filter == ADS126X_SINC1 ||
                               filter == ADS126X_SINC2 ||
                               filter == ADS126X_SINC3 ||
                               filter == ADS126X_SINC4);
    return high_rate ? !is_sinc1to4 : is_sinc1to4;
}

#define ADS126X_ASSERT_FILTER_RATE(filter, rate)                                    \
    static_assert(                                                                   \
        ads126x_filter_rate_valid((uint8_t)(filter), (uint8_t)(rate)),              \
        "Invalid FILTER/DATA_RATE combination: "                                    \
        "rates <= 7200 SPS require SINC1-4; "                                       \
        "rates 14400/19200/38400 SPS require SINC5")

// From page 64 of ADS126X datasheet
constexpr uint8_t baseSettlePulses(uint8_t f)
{
    switch (f) {
        case ADS126X_FIR:   return 1;
        case ADS126X_SINC1: return 1;
        case ADS126X_SINC2: return 2;
        case ADS126X_SINC3: return 3;
        case ADS126X_SINC4: return 4;
        case ADS126X_SINC5: return 5;
        default:            return 1;    // safe fallback
    }
}

constexpr uint8_t settlePulses(uint8_t filter, uint8_t data_rate,
                               bool chop_enabled = false,
                               bool idac_rotation_enabled = false)
{
    if (data_rate == ADS126X_RATE_38400)
        return 5;

    uint8_t n = baseSettlePulses(filter);

    if (chop_enabled)          n *= 2;
    if (idac_rotation_enabled) n *= 2;

    return n;
}
