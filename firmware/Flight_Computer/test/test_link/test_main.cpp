// End-to-end host test: fake radio -> Link::poll -> decode_frame -> ArmGate.
#include <string.h>

#include "../test_radio_seam/radio_fake.h"
#include "unity.h"

// Build the code under test, plus the fake radio from the radio.h tests.
#include "../../src/arm_gate.cpp"
#include "../../src/frame.cpp"
#include "../../src/link.cpp"
#include "../test_radio_seam/radio_fake.cpp"

using namespace radio_link;

static const uint8_t kMe = 7;

static Link lk(kMe);

void setUp(void) {
    fake::reset(true);
    lk = Link(kMe);
}
void tearDown(void) {}

static void inject_arm(uint16_t seq, bool corrupt) {
    uint8_t payload[9];
    uint8_t out[kFrameMaxLen];
    size_t n = 0;
    put_u32(payload, kArmKey);
    put_u32(payload + 4, ~kArmKey);
    payload[8] = kMe;
    TEST_ASSERT_EQUAL(
        FrameStatus::Ok,
        encode_frame(FrameType::Arm, seq, payload, 9, out, sizeof out, n));
    if (corrupt) {
        out[6] ^= 0x01;  // flip one bit in the key
    }
    TEST_ASSERT_TRUE(fake::inject(out, static_cast<uint8_t>(n)));
}

static void test_probe_reports_chip_presence(void) {
    fake::reset(true);
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_probe());
    fake::reset(false);
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound, radio_probe());
}

static void test_nothing_waiting_does_nothing(void) {
    TEST_ASSERT_EQUAL(ArmAction::None, lk.poll(0));
    TEST_ASSERT_EQUAL_UINT32(0, lk.frames_ok());
    TEST_ASSERT_EQUAL_UINT32(0, lk.frames_dropped());
}

static void test_two_good_arms_arm_the_rocket(void) {
    inject_arm(1, false);
    inject_arm(2, false);
    TEST_ASSERT_EQUAL(ArmAction::Pending, lk.poll(0));
    TEST_ASSERT_EQUAL(ArmAction::Arm, lk.poll(100));
    TEST_ASSERT_EQUAL_UINT32(2, lk.frames_ok());
    TEST_ASSERT_EQUAL_UINT32(0, lk.frames_dropped());
}

static void test_corrupted_frame_is_dropped_before_the_gate(void) {
    inject_arm(1, true);  // bit flip: CRC fails
    TEST_ASSERT_EQUAL(ArmAction::None, lk.poll(0));
    TEST_ASSERT_EQUAL_UINT32(0, lk.frames_ok());
    TEST_ASSERT_EQUAL_UINT32(1, lk.frames_dropped());
}

static void test_noise_between_good_arms_does_not_cancel_them(void) {
    uint8_t noise[12] = {0xDE, 0xAD, 0xBE, 0xEF, 1, 2, 3, 4, 5, 6, 7, 8};
    inject_arm(1, false);
    TEST_ASSERT_TRUE(fake::inject(noise, sizeof noise));
    inject_arm(2, false);
    TEST_ASSERT_EQUAL(ArmAction::Pending, lk.poll(0));
    TEST_ASSERT_EQUAL(ArmAction::None, lk.poll(10));  // noise dropped
    TEST_ASSERT_EQUAL(ArmAction::Arm, lk.poll(20));
    TEST_ASSERT_EQUAL_UINT32(1, lk.frames_dropped());
}

static void test_pure_noise_never_arms(void) {
    // 200 deterministic pseudo-random packets of varying length.
    uint32_t x = 12345u;
    for (int i = 0; i < 200; i++) {
        uint8_t buf[kLoraMaxPacket];
        x = x * 1664525u + 1013904223u;
        const uint8_t len = static_cast<uint8_t>(1 + (x >> 24) % 200);
        for (unsigned k = 0; k < len; k++) {
            x = x * 1664525u + 1013904223u;
            buf[k] = static_cast<uint8_t>(x >> 24);
        }
        TEST_ASSERT_TRUE(fake::inject(buf, len));
        const ArmAction a = lk.poll(static_cast<uint32_t>(i));
        TEST_ASSERT_TRUE(a == ArmAction::None);
    }
}

static void test_heartbeat_is_counted_but_not_acted_on(void) {
    uint8_t payload[7] = {1, 0x10, 0x1C, 0, 0, 0, 0};
    uint8_t out[kFrameMaxLen];
    size_t n = 0;
    TEST_ASSERT_EQUAL(
        FrameStatus::Ok,
        encode_frame(FrameType::Heartbeat, 9, payload, 7, out, sizeof out, n));
    TEST_ASSERT_TRUE(fake::inject(out, static_cast<uint8_t>(n)));
    TEST_ASSERT_EQUAL(ArmAction::None, lk.poll(0));
    TEST_ASSERT_EQUAL_UINT32(1, lk.frames_ok());
}

static void test_send_goes_through_the_seam(void) {
    uint8_t payload[4] = {0xFF, 0x01, 0xE8, 0x1C};
    uint8_t out[kFrameMaxLen], back[kFrameMaxLen];
    size_t n = 0;
    Frame f;
    TEST_ASSERT_EQUAL(
        FrameStatus::Ok,
        encode_frame(FrameType::SelfTest, 3, payload, 4, out, sizeof out, n));
    TEST_ASSERT_EQUAL(RadioStatus::Ok,
                      radio_send(out, static_cast<uint8_t>(n)));
    const uint8_t got = fake::last_sent(back, sizeof back);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(n), got);
    TEST_ASSERT_EQUAL(FrameStatus::Ok, decode_frame(back, got, f));
    TEST_ASSERT_EQUAL(FrameType::SelfTest, f.type);
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_probe_reports_chip_presence);
    RUN_TEST(test_nothing_waiting_does_nothing);
    RUN_TEST(test_two_good_arms_arm_the_rocket);
    RUN_TEST(test_corrupted_frame_is_dropped_before_the_gate);
    RUN_TEST(test_noise_between_good_arms_does_not_cancel_them);
    RUN_TEST(test_pure_noise_never_arms);
    RUN_TEST(test_heartbeat_is_counted_but_not_acted_on);
    RUN_TEST(test_send_goes_through_the_seam);
    return UNITY_END();
}
