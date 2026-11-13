#pragma once

// What the SK6805 shows, as a pure function of the switch's state and time, so
// the pattern can be tested on the host (test/led_pattern_test.cpp).
//
//   disarmed, altimeter seen   dim green blip every 3 s
//   disarmed, nothing connected dim amber blip every 3 s
//   ARMED, output live         red blink, 1 Hz
//   ARMED, restored after reset red blink with an amber blip between
//   FAULT                      red/amber alternating, 5 Hz
//                              (armed but VOUT not live, or disarmed but live)
//   INA260 missing             amber double blip once per 3 s, on top of the above
//   phone connected            one blue blip
//   arm / disarm command       one bright flash in the new state's colour

#include <stdint.h>

#include "status.h"

namespace led {

struct Rgb {
    uint8_t r, g, b;
    bool operator==(const Rgb &o) const { return r == o.r && g == o.g && b == o.b; }
};

constexpr Rgb OFF{0, 0, 0};
constexpr Rgb DIM_GREEN{0, 10, 0};
constexpr Rgb DIM_AMBER{10, 5, 0};
constexpr Rgb RED{60, 0, 0};
constexpr Rgb AMBER{50, 22, 0};
constexpr Rgb BLUE{0, 0, 40};
constexpr Rgb FLASH_RED{160, 0, 0};
constexpr Rgb FLASH_GREEN{0, 140, 0};

constexpr uint32_t EVENT_MS = 250;  // connect blip and command flash

enum class Mode : uint8_t { DisarmedLoad, DisarmedOpen, DisarmedUnknown, Armed, Fault };

struct Inputs {
    bool armed;
    Sense sense;        // Unknown while the sense line settles after a switch
    bool restored;      // armed state re-applied after an MCU reset
    bool inaOk;
    uint32_t sinceCommandMs;  // since the last arm/disarm; large if none
    uint32_t sinceConnectMs;  // since a phone last connected; large if none
};

inline Mode mode(const Inputs &in) {
    if (in.sense == Sense::Unknown) return in.armed ? Mode::Armed : Mode::DisarmedUnknown;
    if (in.armed) return in.sense == Sense::Live ? Mode::Armed : Mode::Fault;
    if (in.sense == Sense::Live) return Mode::Fault;
    return in.sense == Sense::LoadPresent ? Mode::DisarmedLoad : Mode::DisarmedOpen;
}

inline Rgb color(const Inputs &in, uint32_t nowMs) {
    if (in.sinceCommandMs < EVENT_MS) return in.armed ? FLASH_RED : FLASH_GREEN;
    if (in.sinceConnectMs < EVENT_MS) return BLUE;

    const uint32_t t1 = nowMs % 1000;
    const uint32_t t3 = nowMs % 3000;
    const Mode m = mode(in);

    if (m == Mode::Fault) return (nowMs / 100) % 2 ? AMBER : RED;

    // INA260 missing: two amber blips in the off half of the armed blink.
    if (!in.inaOk && ((t3 >= 2550 && t3 < 2610) || (t3 >= 2850 && t3 < 2910))) return AMBER;

    switch (m) {
        case Mode::Armed:
            if (t1 < 500) return RED;
            if (in.restored && t1 >= 700 && t1 < 800) return AMBER;
            return OFF;
        case Mode::DisarmedLoad:
            return t3 < 60 ? DIM_GREEN : OFF;
        case Mode::DisarmedOpen:
            return t3 < 60 ? DIM_AMBER : OFF;
        default:
            return OFF;  // settling: say nothing rather than guess
    }
}

}  // namespace led
