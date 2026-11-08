// A CalibrationCommand delivered twice (two subscriptions to its table) is handled once.
#include <cstdio>
#include <cstring>

#include "calibration/CommandDedupe.hpp"

using fsw::calibration::CommandDedupe;

static int failures = 0;
#define CHECK(cond, msg)                    \
    do {                                    \
        if (!(cond)) {                      \
            std::printf("FAIL: %s\n", msg); \
            ++failures;                     \
        }                                   \
    } while (0)

static void make(uint8_t* out, uint64_t ts, uint8_t type, uint16_t sensor, float ref) {
    std::memset(out, 0, CommandDedupe::kBytes);
    std::memcpy(out, &ts, 8);
    out[8] = type;
    std::memcpy(out + 10, &sensor, 2);
    std::memcpy(out + 12, &ref, 4);
}

int main() {
    CommandDedupe d;
    uint8_t a[16], b[16];

    make(a, 1000, 5, 4206, 75.f);
    CHECK(!d.seen(a), "a first command is handled");
    CHECK(d.seen(a), "the same command arriving again (a second subscription) is dropped");

    // Ten captures sent 120 ms apart, each delivered twice: ten handled, not twenty.
    int handled = 0;
    for (int i = 0; i < 10; ++i) {
        make(b, 2000 + 120 * i, 5, 4202, 100.f);
        for (int copy = 0; copy < 2; ++copy)
            if (!d.seen(b))
                ++handled;
    }
    CHECK(handled == 10, "ten captures delivered twice are handled ten times");

    // The same capture repeated by the operator is a new command: a new timestamp.
    make(a, 5000, 5, 4206, 75.f);
    make(b, 5001, 5, 4206, 75.f);
    CHECK(!d.seen(a) && !d.seen(b), "two captures a millisecond apart are both handled");

    // Each field distinguishes a command.
    uint8_t c[16];
    make(c, 6000, 5, 4206, 75.f);
    CHECK(!d.seen(c), "base");
    make(c, 6000, 6, 4206, 75.f);
    CHECK(!d.seen(c), "type differs");
    make(c, 6000, 5, 4207, 75.f);
    CHECK(!d.seen(c), "sensor differs");
    make(c, 6000, 5, 4206, 76.f);
    CHECK(!d.seen(c), "reference differs");

    // Memory is bounded: a command older than kDepth others is forgotten.
    CommandDedupe e;
    make(a, 1, 5, 1, 0.f);
    e.seen(a);
    for (int i = 0; i < static_cast<int>(CommandDedupe::kDepth); ++i) {
        make(b, 100 + i, 5, 1, 0.f);
        e.seen(b);
    }
    CHECK(!e.seen(a), "only the last kDepth commands are remembered");

    if (failures == 0)
        std::printf("command_dedupe: all checks passed\n");
    return failures == 0 ? 0 : 1;
}
