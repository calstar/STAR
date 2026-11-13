// Host tests for the environmental board's switch relay logic.
//   pio test -e native        (from firmware/Environmental Tracker)
#include <string.h>
#include <unity.h>

#include "SwitchRelay.h"

// The hash comes from the protocol library; pull in its implementation.
#include "DiabloPacketUtils.cpp"

static const uint8_t A[6] = {0x58, 0xCF, 0x79, 0x01, 0x3F, 0x2A};
static const uint8_t B[6] = {0x58, 0xCF, 0x79, 0x01, 0x11, 0x22};
static const uint8_t STRANGER[6] = {0x58, 0xCF, 0x79, 0x09, 0x09, 0x09};

static daq::SwitchConfig list(std::initializer_list<std::pair<uint8_t, const uint8_t *>> items) {
    daq::SwitchConfig c;
    for (auto &it : items) {
        c.entries[c.count].role = it.first;
        memcpy(c.entries[c.count].mac, it.second, 6);
        ++c.count;
    }
    return c;
}

static void apply(SwitchRelay &r, const daq::SwitchConfig &c) { r.applyConfig(c, daq::switch_config_hash(c)); }

void setUp() {}
void tearDown() {}

void test_no_config_connects_to_nothing() {
    SwitchRelay r;
    daq::SwitchStatusReport out[5];
    TEST_ASSERT_FALSE(r.hasConfig());
    TEST_ASSERT_FALSE(r.wantsScan());
    TEST_ASSERT_FALSE(r.shouldConnect(A));
    TEST_ASSERT_EQUAL(0, r.collectReports(0, out, 5));
}

void test_listed_switch_is_scanned_for_and_reported_down() {
    SwitchRelay r;
    apply(r, list({{2, A}}));
    TEST_ASSERT_TRUE(r.wantsScan());
    TEST_ASSERT_TRUE(r.shouldConnect(A));
    TEST_ASSERT_FALSE(r.shouldConnect(STRANGER));
    TEST_ASSERT_EQUAL(2, r.roleFor(A));

    daq::SwitchStatusReport out[5];
    TEST_ASSERT_EQUAL(1, r.collectReports(10, out, 5));
    TEST_ASSERT_EQUAL(2, out[0].role);
    TEST_ASSERT_EQUAL((int)daq::SwitchLink::DOWN, (int)out[0].link);
    TEST_ASSERT_EQUAL(0, out[0].status_len);
    TEST_ASSERT_EQUAL(0xFFFF, out[0].age_ms);
    TEST_ASSERT_EQUAL_UINT32(r.configHash(), out[0].config_hash);
}

void test_connect_stops_scanning_and_reports_at_once() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    daq::SwitchStatusReport out[5];
    r.collectReports(0, out, 5);
    r.onConnected(A);
    TEST_ASSERT_FALSE(r.wantsScan());
    TEST_ASSERT_FALSE(r.shouldConnect(A));
    TEST_ASSERT_EQUAL(1, r.collectReports(5, out, 5));  // link change: no waiting for the 1 s tick
    TEST_ASSERT_EQUAL((int)daq::SwitchLink::UP, (int)out[0].link);
}

void test_status_passes_through_and_repeats_once_a_second() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    r.onConnected(A);
    daq::SwitchStatusReport out[5];
    r.collectReports(0, out, 5);

    uint8_t st[17];
    for (int i = 0; i < 17; ++i) st[i] = static_cast<uint8_t>(0xA0 + i);
    r.onStatus(A, st, 17, 100);
    r.onRssi(A, -64);
    TEST_ASSERT_EQUAL(1, r.collectReports(100, out, 5));
    TEST_ASSERT_EQUAL(17, out[0].status_len);
    TEST_ASSERT_EQUAL_MEMORY(st, out[0].status, 17);
    TEST_ASSERT_EQUAL(0, out[0].age_ms);
    TEST_ASSERT_EQUAL(-64, out[0].rssi);

    TEST_ASSERT_EQUAL(0, r.collectReports(600, out, 5));  // nothing new, not yet a second
    TEST_ASSERT_EQUAL(1, r.collectReports(1100, out, 5));
    TEST_ASSERT_EQUAL(1000, out[0].age_ms);
}

void test_same_config_again_changes_nothing() {
    SwitchRelay r;
    auto c = list({{0, A}});
    apply(r, c);
    r.onConnected(A);
    daq::SwitchStatusReport out[5];
    r.collectReports(0, out, 5);
    TEST_ASSERT_EQUAL(0, r.applyConfig(c, daq::switch_config_hash(c)));  // the 1 Hz resend
    TEST_ASSERT_TRUE(r.connected(0));
    TEST_ASSERT_EQUAL(0, r.collectReports(10, out, 5));  // and no burst of reports
}

void test_new_list_keeps_links_moves_roles_and_drops_the_unlisted() {
    SwitchRelay r;
    apply(r, list({{0, A}, {1, B}}));
    r.onConnected(A);
    r.onConnected(B);
    uint8_t st[17] = {1, 1, 3};
    r.onStatus(A, st, 17, 50);

    size_t dropped = r.applyConfig(list({{4, A}}), daq::switch_config_hash(list({{4, A}})));
    TEST_ASSERT_EQUAL(1, dropped);
    TEST_ASSERT_EQUAL_MEMORY(B, r.dropped(0), 6);
    TEST_ASSERT_EQUAL(4, r.roleFor(A));
    TEST_ASSERT_TRUE(r.connected(4));  // A's link survived the move
    TEST_ASSERT_EQUAL(-1, r.roleFor(B));
    TEST_ASSERT_FALSE(r.wantsScan());

    daq::SwitchStatusReport out[5];
    TEST_ASSERT_EQUAL(1, r.collectReports(60, out, 5));
    TEST_ASSERT_EQUAL(4, out[0].role);
    TEST_ASSERT_EQUAL(17, out[0].status_len);
}

void test_lost_link_keeps_last_status_and_ages_it() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    r.onConnected(A);
    uint8_t st[17] = {1, 1, 3};
    r.onStatus(A, st, 17, 0);
    r.onRssi(A, -50);
    daq::SwitchStatusReport out[5];
    r.collectReports(0, out, 5);

    r.onDisconnected(A);
    TEST_ASSERT_TRUE(r.wantsScan());
    TEST_ASSERT_TRUE(r.shouldConnect(A));
    TEST_ASSERT_EQUAL(1, r.collectReports(6000, out, 5));
    TEST_ASSERT_EQUAL((int)daq::SwitchLink::DOWN, (int)out[0].link);
    TEST_ASSERT_EQUAL(17, out[0].status_len);
    TEST_ASSERT_EQUAL(6000, out[0].age_ms);
    TEST_ASSERT_EQUAL(0, out[0].rssi);
}

void test_unlisted_switch_is_ignored() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    uint8_t st[17] = {};
    r.onConnected(STRANGER);
    r.onStatus(STRANGER, st, 17, 0);
    TEST_ASSERT_FALSE(r.connected(0));
    daq::SwitchStatusReport out[5];
    TEST_ASSERT_EQUAL(1, r.collectReports(0, out, 5));
    TEST_ASSERT_EQUAL(0, out[0].status_len);
}

void test_oversized_status_is_cut_and_max_is_honoured() {
    SwitchRelay r;
    apply(r, list({{0, A}, {1, B}}));
    uint8_t big[64] = {};
    r.onStatus(A, big, sizeof big, 0);
    daq::SwitchStatusReport out[1];
    TEST_ASSERT_EQUAL(1, r.collectReports(0, out, 1));
    TEST_ASSERT_EQUAL(daq::MAX_SWITCH_STATUS_BYTES, out[0].status_len);
    TEST_ASSERT_EQUAL(1, r.collectReports(0, out, 1));  // the other role next time
    TEST_ASSERT_EQUAL(1, out[0].role);
}


// ---- commands --------------------------------------------------------------

static daq::SwitchCommandResult only_result(SwitchRelay &r, uint16_t id) {
    daq::SwitchCommandResultPacket out[10];
    size_t n = r.collectResults(out, 10);
    TEST_ASSERT_EQUAL(1, n);
    TEST_ASSERT_EQUAL(id, out[0].command_id);
    return out[0].result;
}

void test_command_without_config_is_refused() {
    SwitchRelay r;
    r.submitCommand({1, 0, 1});
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::NO_CONFIG, (int)only_result(r, 1));
}

void test_command_to_unlisted_role_is_refused() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    r.submitCommand({2, 3, 1});
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::UNKNOWN_ROLE, (int)only_result(r, 2));
}

void test_command_with_link_down_is_refused_not_queued() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    r.submitCommand({3, 0, 1});
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::NO_LINK, (int)only_result(r, 3));
    r.onConnected(A);  // the link coming back must not deliver it late
    daq::SwitchCommandPacket c;
    uint8_t mac[6];
    TEST_ASSERT_FALSE(r.takeCommand(c, mac));
}

void test_connected_command_is_written_once_and_answered() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    r.onConnected(A);
    r.submitCommand({4, 0, 1});
    daq::SwitchCommandResultPacket res[4];
    TEST_ASSERT_EQUAL(0, r.collectResults(res, 4));  // no answer until it's written

    daq::SwitchCommandPacket c;
    uint8_t mac[6];
    TEST_ASSERT_TRUE(r.takeCommand(c, mac));
    TEST_ASSERT_EQUAL(1, c.output);
    TEST_ASSERT_EQUAL_MEMORY(A, mac, 6);
    TEST_ASSERT_FALSE(r.takeCommand(c, mac));  // once
    r.finishCommand(c, true);
    TEST_ASSERT_EQUAL(1, r.collectResults(res, 4));
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::WRITTEN, (int)res[0].result);
    TEST_ASSERT_EQUAL(1, res[0].output);
    r.submitCommand({5, 0, 0});
    TEST_ASSERT_TRUE(r.takeCommand(c, mac));
    r.finishCommand(c, false);
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::WRITE_FAILED, (int)only_result(r, 5));
}

void test_link_lost_before_the_write_answers_no_link() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    r.onConnected(A);
    r.submitCommand({6, 0, 1});
    r.onDisconnected(A);
    daq::SwitchCommandPacket c;
    uint8_t mac[6];
    TEST_ASSERT_FALSE(r.takeCommand(c, mac));
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::NO_LINK, (int)only_result(r, 6));
}

void test_new_list_cannot_redirect_a_queued_command() {
    SwitchRelay r;
    apply(r, list({{0, A}, {1, B}}));
    r.onConnected(A);
    r.onConnected(B);
    r.submitCommand({7, 0, 1});  // meant for A
    apply(r, list({{0, B}}));    // B now sits under role 0
    daq::SwitchCommandPacket c;
    uint8_t mac[6];
    TEST_ASSERT_FALSE(r.takeCommand(c, mac));
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::UNKNOWN_ROLE, (int)only_result(r, 7));
}

void test_full_queue_and_bad_output_are_refused() {
    SwitchRelay r;
    apply(r, list({{0, A}}));
    r.onConnected(A);
    for (uint16_t i = 0; i < SwitchRelay::MAX_QUEUED; ++i) r.submitCommand({i, 0, 1});
    r.submitCommand({99, 0, 1});
    r.submitCommand({100, 0, 2});
    daq::SwitchCommandResultPacket res[4];
    TEST_ASSERT_EQUAL(2, r.collectResults(res, 4));
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::BAD_COMMAND, (int)res[0].result);
    TEST_ASSERT_EQUAL((int)daq::SwitchCommandResult::BAD_COMMAND, (int)res[1].result);
}

// The board never writes on its own: through config, connects, statuses, lost links,
// reconnects (an env board reboot looks like this), new lists and reports, nothing is
// ever handed to the BLE task to write.
void test_nothing_is_written_without_a_command() {
    SwitchRelay r;
    daq::SwitchCommandPacket c;
    uint8_t mac[6];
    daq::SwitchStatusReport rep[5];
    uint8_t armed[17] = {1, 1, 3, 3};
    apply(r, list({{0, A}, {1, B}}));
    r.onConnected(A);
    r.onStatus(A, armed, 17, 0);
    r.onDisconnected(A);
    r.onConnected(A);
    r.onStatus(A, armed, 17, 100);
    r.onConnected(B);
    apply(r, list({{1, A}}));
    r.collectReports(5000, rep, 5);
    apply(r, list({{1, A}}));
    TEST_ASSERT_FALSE(r.takeCommand(c, mac));
    daq::SwitchCommandResultPacket res[4];
    TEST_ASSERT_EQUAL(0, r.collectResults(res, 4));
}

int main(int, char **) {
    UNITY_BEGIN();
    RUN_TEST(test_no_config_connects_to_nothing);
    RUN_TEST(test_listed_switch_is_scanned_for_and_reported_down);
    RUN_TEST(test_connect_stops_scanning_and_reports_at_once);
    RUN_TEST(test_status_passes_through_and_repeats_once_a_second);
    RUN_TEST(test_same_config_again_changes_nothing);
    RUN_TEST(test_new_list_keeps_links_moves_roles_and_drops_the_unlisted);
    RUN_TEST(test_lost_link_keeps_last_status_and_ages_it);
    RUN_TEST(test_unlisted_switch_is_ignored);
    RUN_TEST(test_oversized_status_is_cut_and_max_is_honoured);
    RUN_TEST(test_command_without_config_is_refused);
    RUN_TEST(test_command_to_unlisted_role_is_refused);
    RUN_TEST(test_command_with_link_down_is_refused_not_queued);
    RUN_TEST(test_connected_command_is_written_once_and_answered);
    RUN_TEST(test_link_lost_before_the_write_answers_no_link);
    RUN_TEST(test_new_list_cannot_redirect_a_queued_command);
    RUN_TEST(test_full_queue_and_bad_output_are_refused);
    RUN_TEST(test_nothing_is_written_without_a_command);
    return UNITY_END();
}
