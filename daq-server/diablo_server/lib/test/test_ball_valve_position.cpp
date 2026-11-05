// Ball valve position: counts -> mA -> % open, and the Elodin tables it lives in.

#include <cmath>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>

#include "calibration/ValvePosition.hpp"
#include "elodin/DatabaseConfig.hpp"

namespace vp = fsw::calibration::valve_position;
using fsw::elodin::BoardChannels;

static void require(bool condition, const std::string& what) {
    if (!condition)
        throw std::runtime_error("Ball valve position assertion failed: " + what);
}

static bool near(double a, double b, double tol) {
    return std::fabs(a - b) <= tol;
}

/** The counts the board's 12-bit ADC reports for a loop current, as the firmware sees it. */
static uint32_t counts_for_ma(double ma) {
    return static_cast<uint32_t>(std::lround(ma / 1000.0 * 100.0 / 3.3 * 4095.0));
}

int main() {
    // 4 mA across 100 ohm is 0.4 V = 496 counts; 20 mA is 2.0 V = 2482 counts.
    require(counts_for_ma(4.0) == 496 && counts_for_ma(20.0) == 2482, "fixture counts");
    require(near(vp::counts_to_ma(2482), 20.0, 0.01), "2482 counts is 20 mA");

    struct Case {
        double ma;
        double pct;
    };
    for (const Case c :
         {Case{4.0, 0.0}, Case{8.0, 25.0}, Case{12.0, 50.0}, Case{16.0, 75.0}, Case{20.0, 100.0}}) {
        const auto r = vp::from_counts(counts_for_ma(c.ma));
        require(r.status == vp::kStatusOk, std::to_string(c.ma) + " mA is a signal");
        // One count is ~0.008 mA, ~0.05 %.
        require(near(r.percent_open, c.pct, 0.1),
                std::to_string(c.ma) + " mA -> " + std::to_string(r.percent_open) + " %");
    }

    // A loop a little past either end is still the end of travel, not 101 % or -2 %.
    require(vp::from_counts(counts_for_ma(20.6)).percent_open == 100.0f, "clamped at 100");
    require(vp::from_counts(counts_for_ma(3.7)).percent_open == 0.0f, "clamped at 0");
    require(vp::from_counts(counts_for_ma(3.7)).status == vp::kStatusOk, "3.7 mA still a signal");

    // Below 3.5 mA the loop is open or unpowered: say so, rather than report "closed".
    require(vp::from_counts(0).status == vp::kStatusNoSignal, "0 counts is no signal");
    require(vp::from_counts(counts_for_ma(2.0)).status == vp::kStatusNoSignal, "2 mA no signal");

    // Tables: board 71 is slot 1, the same slot as actuator board 11, but on its own type_hi.
    const std::vector<BoardChannels> bv{{71, 1, {1}}};
    const std::vector<BoardChannels> act{{11, 1, {1, 2}}};
    require(fsw::elodin::ball_valve_raw_tables(bv) ==
                std::vector<std::pair<uint8_t, uint8_t>>{{0x33, 0x01}},
            "raw [0x33, 0x01]");
    require(fsw::elodin::ball_valve_calibrated_tables(bv) ==
                std::vector<std::pair<uint8_t, uint8_t>>{{0x34, 0x11}},
            "calibrated [0x34, 0x11]");
    require(fsw::elodin::ball_valve_cmd_tables(bv) ==
                std::vector<std::pair<uint8_t, uint8_t>>{{0x35, 0x01}},
            "commanded [0x35, 0x01]");

    std::set<std::pair<uint8_t, uint8_t>> act_keys;
    for (const auto& k : fsw::elodin::raw_sensor_tables({}, act, {}, {}, {}, {}))
        act_keys.insert(k);
    for (const auto& k : fsw::elodin::calibrated_sensor_tables({}, {}, {}, {}, {}, act))
        act_keys.insert(k);
    act_keys.insert({0x32, 0x01});  // ACT_CMD.B1.CH1
    act_keys.insert({0x32, 0x02});
    for (const auto& k : fsw::elodin::ball_valve_raw_tables(bv))
        require(!act_keys.count(k), "raw key shared with actuator board 11");
    for (const auto& k : fsw::elodin::ball_valve_calibrated_tables(bv))
        require(!act_keys.count(k), "calibrated key shared with actuator board 11");
    for (const auto& k : fsw::elodin::ball_valve_cmd_tables(bv))
        require(!act_keys.count(k), "commanded key shared with actuator board 11");

    std::cout << "Ball valve position passed\n";
}
