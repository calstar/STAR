/**
 * ResubscribeBackoff: calibration_service's schedule for re-subscribing to quiet raw tables.
 * A publisher that starts after the subscriber must be picked up within ~1 s, not 5–8 s.
 */
#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "elodin/ResubscribeBackoff.hpp"

using fsw::elodin::ResubscribeBackoff;
using namespace std::chrono_literals;

static int g_failures = 0;
static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        ++g_failures;
}

/** Seconds (on a 100 ms grid over `span`) at which due() fires, acting on each one. */
static std::vector<double> fires(ResubscribeBackoff& b, ResubscribeBackoff::Clock::time_point t0,
                                 std::chrono::milliseconds span) {
    std::vector<double> at;
    for (auto t = 0ms; t <= span; t += 100ms) {
        if (b.due(t0 + t)) {
            at.push_back(t.count() / 1000.0);
            b.subscribed(t0 + t);
        }
    }
    return at;
}

int main() {
    const auto t0 = ResubscribeBackoff::Clock::time_point{} + 1000s;

    {
        ResubscribeBackoff b(t0);
        const auto at = fires(b, t0, 20000ms);
        const std::vector<double> want{1, 3, 7, 12, 17};
        check(at == want, "quiet from start: re-subscribes at 1, 3, 7, then every 5 s");
        check(!at.empty() && at.front() <= 1.0, "first retry within 1 s (was 5 s)");
    }
    {
        ResubscribeBackoff b(t0);
        for (auto t = 0ms; t <= 10000ms; t += 100ms)
            b.packet(t0 + t);
        check(!b.due(t0 + 10000ms), "never due while packets flow");
        check(!b.due(t0 + 10900ms), "not due 0.9 s after the last packet");
        check(b.due(t0 + 11000ms), "due 1 s after the last packet");
    }
    {
        ResubscribeBackoff b(t0);
        (void)fires(b, t0, 20000ms);  // backed off to 5 s
        b.packet(t0 + 20000ms);       // data flows again
        check(!b.due(t0 + 20900ms) && b.due(t0 + 21000ms),
              "a packet snaps the interval back to 1 s");
    }
    {
        ResubscribeBackoff b(t0);
        (void)fires(b, t0, 20000ms);
        b.restart(t0 + 30000ms);
        check(!b.due(t0 + 30900ms) && b.due(t0 + 31000ms),
              "restart (reconnect) starts from 1 s again");
    }

    std::cout << (g_failures ? "FAILED" : "PASSED") << std::endl;
    return g_failures ? 1 : 0;
}
