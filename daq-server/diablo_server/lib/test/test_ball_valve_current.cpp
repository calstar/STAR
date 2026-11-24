// Ball valve command current: the store config_broadcast reads, and the VALVE_CURRENT_CONFIG
// packet it builds from it for one board.

#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "DiabloPacketUtils.h"
#include "calibration/ValveCommandCurrent.hpp"
#include "daq-protocol.h"

namespace vc = fsw::calibration::valve_current;

static void require(bool condition, const std::string& what) {
    if (!condition)
        throw std::runtime_error("Ball valve current assertion failed: " + what);
}

static bool has_warning_for(const std::vector<std::string>& w, const std::string& entity) {
    for (const auto& s : w)
        if (s.find(entity) != std::string::npos)
            return true;
    return false;
}

int main() {
    // ── validate ──────────────────────────────────────────────────────────────────────────────
    require(vc::validate({4.0, 20.0}).empty(), "4 / 20 is valid");
    require(vc::validate({3.8, 20.475}).empty(), "the limits themselves are valid");
    require(!vc::validate({3.7, 20.0}).empty(), "below 3.8 mA refused (board faults at 3.6)");
    require(!vc::validate({4.0, 20.5}).empty(), "above DAC full scale refused");
    require(!vc::validate({12.0, 12.5}).empty(), "ends under 1 mA apart refused");
    require(vc::validate({20.0, 4.0}).empty(), "a reverse-acting valve (open below closed) is allowed");
    require(!vc::validate({NAN, 20.0}).empty(), "NaN refused");

    // ── parse ─────────────────────────────────────────────────────────────────────────────────
    std::vector<std::string> warnings;
    const auto store = vc::parse(R"({
      "valves": {
        "BV1_Cal.CH1": { "closed_ma": 4.2, "open_ma": 19.55, "updated_at_ms": 1 },
        "BV1_Cal.CH2": { "closed_ma": 2.0, "open_ma": 20.0 },
        "BV1_Cal.CH3": { "closed_ma": "4", "open_ma": 20.0 },
        "PT1_Cal.CH1": { "closed_ma": 4.0, "open_ma": 20.0 }
      }
    })",
                                 &warnings);
    require(store.size() == 1 && store.count("BV1_Cal.CH1"), "only the valid entry kept");
    require(std::fabs(store.at("BV1_Cal.CH1").open_ma - 19.55) < 1e-9, "open_ma read");
    require(has_warning_for(warnings, "BV1_Cal.CH2"), "out-of-range entry warned");
    require(has_warning_for(warnings, "BV1_Cal.CH3"), "non-numeric entry warned");
    require(has_warning_for(warnings, "PT1_Cal.CH1"), "non-valve key warned");

    warnings.clear();
    require(vc::parse("{ not json", &warnings).empty() && warnings.size() == 1,
            "torn file: empty map and one warning");
    require(vc::load_file("/nonexistent/ball_valve_currents.json", &warnings).empty() &&
                warnings.size() == 1,
            "missing file: empty map, no new warning");

    // ── entries_for_board ─────────────────────────────────────────────────────────────────────
    require(vc::entity_for(1, 2) == "BV1_Cal.CH2", "entity naming matches the position cal");
    const auto entries = vc::entries_for_board(1, {1, 2, 0, 300}, store);
    require(entries.size() == 2, "one entry per valid active connector");
    require(entries[0].actuator_id == 1 && entries[0].closed_ua == 4200 &&
                entries[0].open_ua == 19550,
            "calibrated channel carries its currents in uA");
    require(entries[1].actuator_id == 2 && entries[1].closed_ua == 4000 &&
                entries[1].open_ua == 20000,
            "uncalibrated channel is sent 4 / 20, so a cleared cal reaches the board");
    require(vc::entries_for_board(2, {1}, store)[0].open_ua == 20000,
            "another board's slot does not pick up BV1's calibration");

    // ── wire round trip ───────────────────────────────────────────────────────────────────────
    uint8_t buf[MAX_PACKET_SIZE];
    const size_t n = daq::create_valve_current_config_packet(entries, 1234, buf, sizeof(buf));
    require(n == sizeof(daq::PacketHeader) + 1 + 2 * 5, "packet size: header + count + 2 x 5");
    daq::PacketHeader hdr;
    std::vector<daq::ValveCurrentEntry> back;
    require(daq::parse_valve_current_config_packet(buf, n, hdr, back), "parses");
    require(hdr.packet_type == daq::PacketType::VALVE_CURRENT_CONFIG && hdr.timestamp == 1234,
            "header");
    require(back.size() == 2 && back[0].open_ua == 19550 && back[1].closed_ua == 4000,
            "entries survive the trip");
    require(!daq::parse_valve_current_config_packet(buf, n - 1, hdr, back), "truncated refused");

    // ── trials ────────────────────────────────────────────────────────────────────────────────
    warnings.clear();
    const auto trials = vc::parse_trials(R"({
      "valves": {
        "BV1_Cal.CH1": { "ma": 19.6, "expires_at_ms": 2000 },
        "BV1_Cal.CH2": { "ma": 12.0, "expires_at_ms": 999 },
        "BV1_Cal.CH3": { "ma": 25.0, "expires_at_ms": 2000 },
        "BV1_Cal.CH4": { "ma": 12.0 }
      }
    })",
                                         1000, &warnings);
    require(trials.size() == 1 && std::fabs(trials.at("BV1_Cal.CH1") - 19.6) < 1e-9,
            "only the unexpired, in-range trial");
    require(has_warning_for(warnings, "BV1_Cal.CH3"), "out-of-range trial warned");
    require(has_warning_for(warnings, "BV1_Cal.CH4"), "trial with no expiry warned");
    require(!has_warning_for(warnings, "BV1_Cal.CH2"), "an expired trial is not a problem");
    const auto te = vc::trial_entries_for_board(1, {1, 2}, trials);
    require(te.size() == 2 && te[0].actuator_id == 1 && te[0].ua == 19600,
            "a running trial is sent in uA");
    require(te[1].actuator_id == 2 && te[1].ua == 0, "no trial is sent as 0, ending one at once");
    {
        const size_t tn = daq::create_valve_test_current_packet(te, 0, buf, sizeof(buf));
        std::vector<daq::ValveTestCurrentEntry> tb;
        require(tn == sizeof(daq::PacketHeader) + 1 + 2 * 3 &&
                    daq::parse_valve_test_current_packet(buf, tn, hdr, tb) && tb.size() == 2 &&
                    tb[0].ua == 19600 && hdr.packet_type == daq::PacketType::VALVE_TEST_CURRENT,
                "trial packet round trip");
    }

    std::cout << "test_ball_valve_current: all passed" << std::endl;
    return 0;
}
