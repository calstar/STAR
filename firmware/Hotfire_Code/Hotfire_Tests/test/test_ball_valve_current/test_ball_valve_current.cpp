// Ball valve command current on the board: does a VALVE_CURRENT_CONFIG from the server change the
// current the DAC is told to drive? Runs the same header BallValve_Hotfire's main.cpp uses
// (common/ball_valve_current.h), fed from a packet built and parsed by the real protocol library.

#include <unity.h>

#include <vector>

#include "DiabloPacketUtils.h"
#include "ball_valve_current.h"
#include "daq-protocol.h"

// The protocol library is not a PlatformIO lib in the native env; compile it in, as
// test_packet_roundtrip does.
#include "DiabloPacketUtils.cpp"

namespace bvc = ball_valve_current;

// One valve as the board holds it: its codes and its commanded state.
struct ValveModel {
    uint8_t state = 0;
    uint16_t closed_code = bvc::CODE_CLOSED_DEFAULT;
    uint16_t open_code = bvc::CODE_OPEN_DEFAULT;
    uint16_t trial_code = 0;
    uint16_t blocked = 0;
    uint16_t dac() const {
        return bvc::drive_code(state, closed_code, open_code, trial_code);
    }
    float ma() const {
        return dac() / bvc::DAC_CODES_PER_MA;
    }
};

/** Build the packet the server sends, parse it as the board does, apply each entry. */
static std::vector<bvc::Result> deliver(ValveModel& v, uint16_t closed_ua, uint16_t open_ua) {
    std::vector<daq::ValveCurrentEntry> sent{{1, closed_ua, open_ua}};
    uint8_t buf[MAX_PACKET_SIZE];
    size_t n = daq::create_valve_current_config_packet(sent, 0, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);
    daq::PacketHeader hdr;
    std::vector<daq::ValveCurrentEntry> got;
    TEST_ASSERT_TRUE(daq::parse_valve_current_config_packet(buf, n, hdr, got));
    std::vector<bvc::Result> out;
    for (const auto& e : got)
        out.push_back(bvc::apply(v.closed_code, v.open_code, e.closed_ua, e.open_ua));
    return out;
}

void test_defaults_are_4_and_20_ma() {
    ValveModel v;
    TEST_ASSERT_EQUAL_UINT16(800, v.dac());
    v.state = 1;
    TEST_ASSERT_EQUAL_UINT16(4000, v.dac());
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 20.0f, v.ma());
}

void test_open_valve_moves_to_new_open_current() {
    ValveModel v;
    v.state = 1;  // sitting open: the trim takes effect on it at once
    auto r = deliver(v, 4000, 19550);
    TEST_ASSERT_EQUAL(1, r.size());
    TEST_ASSERT_TRUE(r[0] == bvc::Result::Changed);
    TEST_ASSERT_EQUAL_UINT16(3910, v.dac());  // 19.55 mA / 5 uA
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 19.55f, v.ma());
}

void test_closed_valve_moves_to_new_closed_current() {
    ValveModel v;  // state 0
    deliver(v, 4250, 20000);
    TEST_ASSERT_EQUAL_UINT16(850, v.dac());
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 4.25f, v.ma());
}

void test_both_ends_and_command_follow() {
    ValveModel v;
    deliver(v, 3900, 20400);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 3.9f, v.ma());
    v.state = 1;
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 20.4f, v.ma());
}

void test_repeat_is_unchanged() {
    ValveModel v;
    deliver(v, 4100, 19800);
    auto r = deliver(v, 4100, 19800);  // the server sends every cycle
    TEST_ASSERT_TRUE(r[0] == bvc::Result::Unchanged);
}

void test_back_to_defaults_after_clear() {
    ValveModel v;
    deliver(v, 4100, 19800);
    auto r = deliver(v, 4000, 20000);  // the server sends 4 / 20 once cleared
    TEST_ASSERT_TRUE(r[0] == bvc::Result::Changed);
    TEST_ASSERT_EQUAL_UINT16(800, v.closed_code);
    TEST_ASSERT_EQUAL_UINT16(4000, v.open_code);
}

void test_out_of_range_refused_and_codes_kept() {
    ValveModel v;
    deliver(v, 4100, 19800);
    TEST_ASSERT_TRUE(deliver(v, 3500, 20000)[0] == bvc::Result::Refused);  // below 3.8 mA
    TEST_ASSERT_TRUE(deliver(v, 4000, 21000)[0] == bvc::Result::Refused);  // above full scale
    TEST_ASSERT_TRUE(deliver(v, 12000, 12500)[0] == bvc::Result::Refused);  // < 1 mA apart
    TEST_ASSERT_EQUAL_UINT16(820, v.closed_code);
    TEST_ASSERT_EQUAL_UINT16(3960, v.open_code);
}

void test_limits_themselves_accepted() {
    ValveModel v;
    TEST_ASSERT_TRUE(deliver(v, 3800, 20475)[0] == bvc::Result::Changed);
    TEST_ASSERT_EQUAL_UINT16(760, v.closed_code);
    TEST_ASSERT_EQUAL_UINT16(4095, v.open_code);
}

void test_reverse_acting_valve_allowed() {
    ValveModel v;
    TEST_ASSERT_TRUE(deliver(v, 20000, 4000)[0] == bvc::Result::Changed);
    v.state = 1;
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 4.0f, v.ma());
}

void test_nvs_restore() {
    ValveModel v;
    TEST_ASSERT_TRUE(bvc::restore(v.closed_code, v.open_code, 820, 3960));
    TEST_ASSERT_EQUAL_UINT16(3960, v.open_code);
    ValveModel w;
    TEST_ASSERT_FALSE(bvc::restore(w.closed_code, w.open_code, 0, 0));  // nothing stored
    TEST_ASSERT_FALSE(bvc::restore(w.closed_code, w.open_code, 100, 4000));  // 0.5 mA
    TEST_ASSERT_FALSE(bvc::restore(w.closed_code, w.open_code, 800, 5000));  // past full scale
    TEST_ASSERT_EQUAL_UINT16(800, w.closed_code);
    TEST_ASSERT_EQUAL_UINT16(4000, w.open_code);
}

/** A VALVE_TEST_CURRENT through the real packet code, applied as the board does. */
static bvc::TrialResult trial(ValveModel& v, uint16_t ua, bool active = true) {
    std::vector<daq::ValveTestCurrentEntry> sent{{1, ua}};
    uint8_t buf[MAX_PACKET_SIZE];
    size_t n = daq::create_valve_test_current_packet(sent, 0, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);
    daq::PacketHeader hdr;
    std::vector<daq::ValveTestCurrentEntry> got;
    TEST_ASSERT_TRUE(daq::parse_valve_test_current_packet(buf, n, hdr, got));
    TEST_ASSERT_EQUAL(1, got.size());
    return bvc::apply_trial(v.trial_code, v.blocked, got[0].ua, active);
}

void test_trial_drives_the_dac_whatever_the_state() {
    ValveModel v;  // commanded closed
    TEST_ASSERT_TRUE(trial(v, 12000) == bvc::TrialResult::Started);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 12.0f, v.ma());
    v.state = 1;  // a repeat of the trial holds through either state
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 12.0f, v.ma());
}

void test_trial_then_save_as_open_becomes_the_open_state() {
    // The calibration flow: trial 19.6 mA, the server saves it as open and
    // ends the trial; commanded open now drives 19.6.
    ValveModel v;
    v.state = 1;
    trial(v, 19600);
    deliver(v, 4000, 19600);  // VALVE_CURRENT_CONFIG with the saved open
    TEST_ASSERT_TRUE(trial(v, 0) == bvc::TrialResult::Ended);
    TEST_ASSERT_EQUAL_UINT16(0, v.trial_code);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 19.6f, v.ma());
    v.state = 0;
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 4.0f, v.ma());
}

void test_trial_repeat_and_change() {
    ValveModel v;
    trial(v, 10000);
    TEST_ASSERT_TRUE(trial(v, 10000) == bvc::TrialResult::Refreshed);
    TEST_ASSERT_TRUE(trial(v, 10500) == bvc::TrialResult::Changed);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 10.5f, v.ma());
}

void test_trial_needs_the_server_and_a_valid_current() {
    ValveModel v;
    TEST_ASSERT_TRUE(trial(v, 12000, false) == bvc::TrialResult::NotActive);
    TEST_ASSERT_EQUAL_UINT16(0, v.trial_code);
    TEST_ASSERT_TRUE(trial(v, 3000) == bvc::TrialResult::Refused);
    TEST_ASSERT_TRUE(trial(v, 21000) == bvc::TrialResult::Refused);
    TEST_ASSERT_EQUAL_UINT16(800, v.dac());
    TEST_ASSERT_TRUE(trial(v, 0) == bvc::TrialResult::None);
}

void test_trial_expires_when_not_repeated() {
    TEST_ASSERT_FALSE(bvc::trial_expired(0, 100000, 0));  // no trial
    TEST_ASSERT_FALSE(bvc::trial_expired(2400, 13000, 10000));
    TEST_ASSERT_TRUE(bvc::trial_expired(2400, 13001, 10000));
    TEST_ASSERT_FALSE(bvc::trial_expired(2400, 5, 4294967000u));  // millis() wrap, 301 ms
    TEST_ASSERT_TRUE(bvc::trial_expired(2400, 3000, 4294967000u));  // 3296 ms across the wrap
}

void test_command_ends_trial_and_repeat_does_not_resume_it() {
    // Found on the board: a command ended the trial, the server's next repeat
    // (it keeps sending until the operator stops) started it again 1 s later.
    ValveModel v;
    trial(v, 15000);
    TEST_ASSERT_TRUE(bvc::end_trial_on_board(v.trial_code, v.blocked));
    v.state = 1;
    TEST_ASSERT_TRUE(trial(v, 15000) == bvc::TrialResult::Blocked);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 20.0f, v.ma());  // the command's current
    // Drive again with a new current takes it; so does Stop then Drive.
    TEST_ASSERT_TRUE(trial(v, 15500) == bvc::TrialResult::Started);
    bvc::end_trial_on_board(v.trial_code, v.blocked);
    TEST_ASSERT_TRUE(trial(v, 0) == bvc::TrialResult::None);
    TEST_ASSERT_TRUE(trial(v, 15500) == bvc::TrialResult::Started);
}

void test_failsafe_end_is_not_resumed_when_the_server_returns() {
    ValveModel v;
    trial(v, 13000);
    bvc::end_trial_on_board(v.trial_code, v.blocked);  // heartbeat lost
    TEST_ASSERT_TRUE(trial(v, 13000, false) == bvc::TrialResult::Blocked);
    TEST_ASSERT_TRUE(trial(v, 13000, true) == bvc::TrialResult::Blocked);  // back
    TEST_ASSERT_EQUAL_UINT16(0, v.trial_code);
}

void setUp() {
}
void tearDown() {
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_defaults_are_4_and_20_ma);
    RUN_TEST(test_open_valve_moves_to_new_open_current);
    RUN_TEST(test_closed_valve_moves_to_new_closed_current);
    RUN_TEST(test_both_ends_and_command_follow);
    RUN_TEST(test_repeat_is_unchanged);
    RUN_TEST(test_back_to_defaults_after_clear);
    RUN_TEST(test_out_of_range_refused_and_codes_kept);
    RUN_TEST(test_limits_themselves_accepted);
    RUN_TEST(test_reverse_acting_valve_allowed);
    RUN_TEST(test_nvs_restore);
    RUN_TEST(test_trial_drives_the_dac_whatever_the_state);
    RUN_TEST(test_trial_then_save_as_open_becomes_the_open_state);
    RUN_TEST(test_trial_repeat_and_change);
    RUN_TEST(test_trial_needs_the_server_and_a_valid_current);
    RUN_TEST(test_trial_expires_when_not_repeated);
    RUN_TEST(test_command_ends_trial_and_repeat_does_not_resume_it);
    RUN_TEST(test_failsafe_end_is_not_resumed_when_the_server_returns);
    return UNITY_END();
}
