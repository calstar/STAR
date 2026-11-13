// Host test for include/led_pattern.h. Plain C++, no framework:
//   c++ -std=c++17 -Iinclude test/host/led_pattern_test.cpp -o /tmp/led && /tmp/led
#include <cstdio>
#include <cstdlib>
#include <initializer_list>

#include "led_pattern.h"

using namespace led;

static int failures = 0;
#define CHECK(cond)                                                    \
    do {                                                               \
        if (!(cond)) {                                                 \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                \
        }                                                              \
    } while (0)

constexpr uint32_t LONG_AGO = 0xFFFFFFFF;

static Inputs base(bool armed, Sense s) { return {armed, s, false, true, LONG_AGO, LONG_AGO}; }

// How many ms in [from, to) the LED shows `c`.
static int msOf(const Inputs &in, Rgb c, uint32_t from, uint32_t to) {
    int n = 0;
    for (uint32_t t = from; t < to; t++) n += color(in, t) == c;
    return n;
}

int main() {
    // Modes.
    CHECK(mode(base(true, Sense::Live)) == Mode::Armed);
    CHECK(mode(base(true, Sense::Open)) == Mode::Fault);
    CHECK(mode(base(true, Sense::LoadPresent)) == Mode::Fault);
    CHECK(mode(base(false, Sense::Live)) == Mode::Fault);
    CHECK(mode(base(false, Sense::LoadPresent)) == Mode::Disarmed);
    CHECK(mode(base(false, Sense::Open)) == Mode::Disarmed);
    CHECK(mode(base(true, Sense::Unknown)) == Mode::Armed);  // settling: no false fault

    // Armed: red half of every second, nothing else.
    auto armed = base(true, Sense::Live);
    CHECK(msOf(armed, RED, 0, 3000) == 1500);
    CHECK(msOf(armed, OFF, 0, 3000) == 1500);

    // Restored: the same blink plus a 100 ms red blip per second.
    auto restored = armed;
    restored.restored = true;
    CHECK(msOf(restored, RED, 0, 3000) == 1800);
    CHECK(color(restored, 750) == RED);
    CHECK(color(armed, 750) == OFF);

    // Disarmed: one 60 ms dim green blip per 3 s, load or not.
    for (Sense s : {Sense::LoadPresent, Sense::Open}) {
        CHECK(msOf(base(false, s), DIM_GREEN, 0, 6000) == 120);
        CHECK(msOf(base(false, s), OFF, 0, 6000) == 6000 - 120);
    }
    CHECK(msOf(base(false, Sense::Unknown), OFF, 0, 3000) == 3000);

    // No battery, disarmed: one 400 ms dim blue pulse per 3 s, whatever the sense
    // line says, and no green (green means ready to arm).
    for (Sense s : {Sense::Open, Sense::LoadPresent, Sense::Unknown}) {
        auto nb = base(false, s);
        nb.noBattery = true;
        CHECK(mode(nb) == Mode::DisarmedNoBattery);
        CHECK(msOf(nb, DIM_BLUE, 0, 3000) == 400);
        CHECK(msOf(nb, DIM_GREEN, 0, 3000) == 0);
    }
    // No battery, armed: VOUT can't be live, so it's the fault.
    auto nbArmed = base(true, Sense::LoadPresent);
    nbArmed.noBattery = true;
    CHECK(mode(nbArmed) == Mode::Fault);
    // INA260 missing on top of no battery: both blue patterns, apart.
    auto nbNoIna = base(false, Sense::Open);
    nbNoIna.noBattery = true;
    nbNoIna.inaOk = false;
    CHECK(msOf(nbNoIna, DIM_BLUE, 0, 3000) == 400);
    CHECK(msOf(nbNoIna, BLUE, 0, 3000) == 120);

    // Fault: red flicker, switching every 100 ms.
    auto fault = base(true, Sense::Open);
    CHECK(msOf(fault, RED, 0, 1000) == 500);
    CHECK(msOf(fault, OFF, 0, 1000) == 500);
    CHECK(color(fault, 50) == RED && color(fault, 150) == OFF && color(fault, 250) == RED);

    // INA260 missing: two 60 ms blue blips per 3 s, and they don't cut into the red
    // or the disarmed green.
    auto noIna = armed;
    noIna.inaOk = false;
    CHECK(msOf(noIna, BLUE, 0, 3000) == 120);
    CHECK(msOf(noIna, RED, 0, 3000) == 1500);
    auto noInaDisarmed = base(false, Sense::Open);
    noInaDisarmed.inaOk = false;
    CHECK(msOf(noInaDisarmed, BLUE, 0, 3000) == 120);
    CHECK(msOf(noInaDisarmed, DIM_GREEN, 0, 3000) == 60);

    // Only pure primaries, anywhere.
    const Inputs all[] = {armed, restored, fault, noIna, noInaDisarmed,
                          base(false, Sense::LoadPresent), base(false, Sense::Open)};
    for (const auto &in : all)
        for (uint32_t t = 0; t < 3000; t++) {
            Rgb c = color(in, t);
            CHECK((c.r != 0) + (c.g != 0) + (c.b != 0) <= 1);
        }

    // Events win over everything, briefly.
    auto cmd = base(true, Sense::Unknown);
    cmd.sinceCommandMs = 0;
    CHECK(color(cmd, 600) == FLASH_RED);
    cmd.armed = false;
    CHECK(color(cmd, 600) == FLASH_GREEN);
    cmd.sinceCommandMs = EVENT_MS;
    CHECK(color(cmd, 600) == OFF);
    auto conn = base(false, Sense::Open);
    conn.sinceConnectMs = 10;
    CHECK(color(conn, 1500) == BLUE);
    auto connFault = fault;
    connFault.sinceConnectMs = 10;
    CHECK(color(connFault, 1500) == BLUE);

    if (failures) {
        std::printf("%d failure(s)\n", failures);
        return EXIT_FAILURE;
    }
    std::printf("led pattern ok\n");
    return 0;
}
