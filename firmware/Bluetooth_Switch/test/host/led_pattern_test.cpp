// Host test for include/led_pattern.h. Plain C++, no framework:
//   c++ -std=c++17 -Iinclude test/host/led_pattern_test.cpp -o /tmp/led && /tmp/led
#include <cstdio>
#include <cstdlib>

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
    CHECK(mode(base(false, Sense::LoadPresent)) == Mode::DisarmedLoad);
    CHECK(mode(base(false, Sense::Open)) == Mode::DisarmedOpen);
    CHECK(mode(base(true, Sense::Unknown)) == Mode::Armed);  // settling: no false fault

    // Armed: red half of every second, nothing else.
    auto armed = base(true, Sense::Live);
    CHECK(msOf(armed, RED, 0, 3000) == 1500);
    CHECK(msOf(armed, OFF, 0, 3000) == 1500);

    // Restored: the same blink plus 100 ms amber per second.
    auto restored = armed;
    restored.restored = true;
    CHECK(msOf(restored, RED, 0, 3000) == 1500);
    CHECK(msOf(restored, AMBER, 0, 3000) == 300);

    // Disarmed: one 60 ms dim blip per 3 s, green with a load, amber without.
    CHECK(msOf(base(false, Sense::LoadPresent), DIM_GREEN, 0, 6000) == 120);
    CHECK(msOf(base(false, Sense::LoadPresent), OFF, 0, 6000) == 6000 - 120);
    CHECK(msOf(base(false, Sense::Open), DIM_AMBER, 0, 6000) == 120);
    CHECK(msOf(base(false, Sense::Unknown), OFF, 0, 3000) == 3000);

    // Fault: never dark, both colours, switching every 100 ms.
    auto fault = base(true, Sense::Open);
    CHECK(msOf(fault, OFF, 0, 3000) == 0);
    CHECK(msOf(fault, RED, 0, 1000) == 500);
    CHECK(msOf(fault, AMBER, 0, 1000) == 500);

    // INA260 missing: two 60 ms amber blips per 3 s, and they don't cut into the red.
    auto noIna = armed;
    noIna.inaOk = false;
    CHECK(msOf(noIna, AMBER, 0, 3000) == 120);
    CHECK(msOf(noIna, RED, 0, 3000) == 1500);
    auto noInaDisarmed = base(false, Sense::LoadPresent);
    noInaDisarmed.inaOk = false;
    CHECK(msOf(noInaDisarmed, AMBER, 0, 3000) == 120);

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
