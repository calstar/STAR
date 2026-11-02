// Host tests for arm_gate.cpp: the "ARM must be hard to trigger by accident"
// rules. No hardware, no clock: time is passed in.
#include <string.h>

#include "unity.h"

// Build the code under test.
#include "../../src/arm_gate.cpp"
#include "../../src/frame.cpp"

using namespace radio_link;

static const uint8_t kMe = 7;  // this rocket's target id

static ArmGate g(kMe);

void setUp(void) {
    g = ArmGate(kMe);
}
void tearDown(void) {
}

static Frame arm_frame(uint16_t seq, uint32_t key, uint32_t inv,
                       uint8_t target) {
    Frame f;
    memset(&f, 0, sizeof f);
    f.type = FrameType::Arm;
    f.seq = seq;
    f.payload_len = kArmLen;
    put_u32(f.payload, key);
    put_u32(f.payload + 4, inv);
    f.payload[8] = target;
    return f;
}

static Frame good_arm(uint16_t seq) {
    return arm_frame(seq, kArmKey, ~kArmKey, kMe);
}

static Frame simple(FrameType type, uint16_t seq) {
    Frame f;
    memset(&f, 0, sizeof f);
    f.type = type;
    f.seq = seq;
    return f;
}

static ArmAction feed(const Frame& f, uint32_t t) {
    return g.on_frame(f, t);
}

static void test_single_arm_does_not_arm(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
}

static void test_two_consecutive_arms_in_window_arm(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    TEST_ASSERT_EQUAL(ArmAction::Arm, feed(good_arm(2), 500));
}

static void test_confirm_exactly_at_window_edge_arms(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 100));
    TEST_ASSERT_EQUAL(ArmAction::Arm,
                      feed(good_arm(2), 100 + kArmConfirmWindowMs));
}

static void test_confirm_after_window_does_not_arm(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    TEST_ASSERT_EQUAL(ArmAction::Pending,
                      feed(good_arm(2), kArmConfirmWindowMs + 1));
    // ...but that late frame became a fresh first ARM, so seq 3 confirms it.
    TEST_ASSERT_EQUAL(ArmAction::Arm,
                      feed(good_arm(3), kArmConfirmWindowMs + 2));
}

static void test_non_consecutive_sequence_does_not_arm(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(3), 100));  // skipped 2
}

static void test_wrong_key_rejected(void) {
    TEST_ASSERT_EQUAL(ArmAction::RejectKey,
                      feed(arm_frame(1, kArmKey ^ 1u, ~kArmKey, kMe), 0));
}

static void test_wrong_inverse_rejected(void) {
    // Right key but the inverse field is not ~key.
    TEST_ASSERT_EQUAL(ArmAction::RejectKey,
                      feed(arm_frame(1, kArmKey, kArmKey, kMe), 0));
    TEST_ASSERT_EQUAL(ArmAction::RejectKey,
                      feed(arm_frame(2, kArmKey, 0u, kMe), 0));
}

static void test_wrong_target_rejected(void) {
    TEST_ASSERT_EQUAL(ArmAction::RejectTarget,
                      feed(arm_frame(1, kArmKey, ~kArmKey, kMe + 1), 0));
}

// A rejected frame does not advance last_seq, so a good ARM can reuse its
// sequence number and look "consecutive" to the first ARM. Only the cancel
// rule stops that from arming.
static void test_rejected_key_cancels_pending(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    TEST_ASSERT_EQUAL(ArmAction::RejectKey,
                      feed(arm_frame(2, kArmKey ^ 1u, ~kArmKey, kMe), 10));
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(2), 20));
}

static void test_rejected_target_cancels_pending(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    TEST_ASSERT_EQUAL(ArmAction::RejectTarget,
                      feed(arm_frame(2, kArmKey, ~kArmKey, kMe + 1), 10));
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(2), 20));
}

// A duplicate of the first ARM is rejected as stale, and (rule 5) cancels the
// pending ARM: seq 11 would otherwise look consecutive to the first.
static void test_rejected_stale_cancels_pending(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(10), 0));
    TEST_ASSERT_EQUAL(ArmAction::RejectStale, feed(good_arm(10), 5));
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(11), 10));
}

static void test_duplicate_sequence_is_stale(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(10), 0));
    TEST_ASSERT_EQUAL(ArmAction::RejectStale, feed(good_arm(10), 5));
}

static void test_replayed_old_arms_are_stale(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(10), 0));
    TEST_ASSERT_EQUAL(ArmAction::Arm, feed(good_arm(11), 5));
    // An attacker/echo replays the same two frames later.
    TEST_ASSERT_EQUAL(ArmAction::RejectStale, feed(good_arm(10), 100));
    TEST_ASSERT_EQUAL(ArmAction::RejectStale, feed(good_arm(11), 105));
}

static void test_sequence_wraps(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(0xFFFF), 0));
    TEST_ASSERT_EQUAL(ArmAction::Arm, feed(good_arm(0x0000), 5));
}

static void test_time_counter_wraps(void) {
    const uint32_t t0 = 0xFFFFFF00u;  // 256 ms before the 32-bit counter wraps
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), t0));
    TEST_ASSERT_EQUAL(ArmAction::Arm,
                      feed(good_arm(2), 0x00000100u));  // +512 ms
}

static void test_tick_expires_pending(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    g.tick(kArmConfirmWindowMs + 1);
    TEST_ASSERT_FALSE(g.pending());
}

static void test_un_arm_always_honored(void) {
    TEST_ASSERT_EQUAL(ArmAction::Disarm, feed(simple(FrameType::UnArm, 5), 0));
}

static void test_un_arm_honored_even_when_stale(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(50), 0));
    TEST_ASSERT_EQUAL(ArmAction::Disarm, feed(simple(FrameType::UnArm, 1), 5));
}

// UN_ARM reusing seq 1 does not advance last_seq, so ARM seq 2 would look
// consecutive to the first ARM. Only the cancel rule stops it arming.
static void test_un_arm_cancels_pending_arm(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    TEST_ASSERT_EQUAL(ArmAction::Disarm, feed(simple(FrameType::UnArm, 1), 5));
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(2), 10));
}

static void test_other_frame_types_ignored(void) {
    TEST_ASSERT_EQUAL(ArmAction::None,
                      feed(simple(FrameType::Heartbeat, 1), 0));
    TEST_ASSERT_EQUAL(ArmAction::None, feed(simple(FrameType::SelfTest, 2), 0));
}

static void test_other_frames_do_not_cancel_pending(void) {
    TEST_ASSERT_EQUAL(ArmAction::Pending, feed(good_arm(1), 0));
    TEST_ASSERT_EQUAL(ArmAction::None,
                      feed(simple(FrameType::Heartbeat, 9), 5));
    TEST_ASSERT_EQUAL(ArmAction::Arm, feed(good_arm(2), 10));
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_single_arm_does_not_arm);
    RUN_TEST(test_two_consecutive_arms_in_window_arm);
    RUN_TEST(test_confirm_exactly_at_window_edge_arms);
    RUN_TEST(test_confirm_after_window_does_not_arm);
    RUN_TEST(test_non_consecutive_sequence_does_not_arm);
    RUN_TEST(test_wrong_key_rejected);
    RUN_TEST(test_wrong_inverse_rejected);
    RUN_TEST(test_wrong_target_rejected);
    RUN_TEST(test_rejected_key_cancels_pending);
    RUN_TEST(test_rejected_target_cancels_pending);
    RUN_TEST(test_rejected_stale_cancels_pending);
    RUN_TEST(test_duplicate_sequence_is_stale);
    RUN_TEST(test_replayed_old_arms_are_stale);
    RUN_TEST(test_sequence_wraps);
    RUN_TEST(test_time_counter_wraps);
    RUN_TEST(test_tick_expires_pending);
    RUN_TEST(test_un_arm_always_honored);
    RUN_TEST(test_un_arm_honored_even_when_stale);
    RUN_TEST(test_un_arm_cancels_pending_arm);
    RUN_TEST(test_other_frame_types_ignored);
    RUN_TEST(test_other_frames_do_not_cancel_pending);
    return UNITY_END();
}
