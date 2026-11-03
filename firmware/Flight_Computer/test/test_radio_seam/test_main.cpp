// Tests for the promises radio.h makes, run against the fake radio.
// They check the fake (they need fake::inject and fake::last_sent), but the
// promises they check are the ones the real radio driver must also keep.
#include <string.h>

#include "radio.h"
#include "radio_fake.h"
#include "unity.h"

using namespace radio_link;

void setUp(void) {
    fake::reset(true);
}
void tearDown(void) {
}

static void test_probe_ok_when_chip_present(void) {
    fake::reset(true);
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_probe());
}

static void test_probe_reports_not_found_when_chip_missing(void) {
    fake::reset(false);
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound, radio_probe());
}

static void test_receive_with_nothing_waiting_returns_no_data(void) {
    uint8_t buf[16];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio_receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(0xAB, len);  // len must be left alone on NoData
}

static void test_receive_returns_injected_packet_with_its_length(void) {
    const uint8_t pkt[] = {1, 2, 3, 4, 5};
    TEST_ASSERT_TRUE(fake::inject(pkt, sizeof pkt));
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(sizeof pkt, len);
    TEST_ASSERT_EQUAL_HEX8_ARRAY(pkt, buf, sizeof pkt);
    // The packet is used up, so a second receive finds nothing.
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio_receive(buf, sizeof buf, len));
}

static void test_receive_is_first_in_first_out(void) {
    const uint8_t a[] = {0xAA};
    const uint8_t b[] = {0xBB, 0xBB};
    TEST_ASSERT_TRUE(fake::inject(a, sizeof a));
    TEST_ASSERT_TRUE(fake::inject(b, sizeof b));
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(1, len);
    TEST_ASSERT_EQUAL_HEX8(0xAA, buf[0]);
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(2, len);
    TEST_ASSERT_EQUAL_HEX8(0xBB, buf[0]);
}

// The queue holds 8 packets in a ring: the read and write positions go back
// to slot 0 after slot 7. Push and pop 20 packets one at a time, so both
// positions wrap around twice, and check every packet comes back intact.
static void test_receive_keeps_working_after_queue_wraps(void) {
    uint8_t buf[16];
    uint8_t len = 0;
    for (uint8_t i = 0; i < 20; i++) {
        const uint8_t pkt[] = {i, static_cast<uint8_t>(i + 100)};
        TEST_ASSERT_TRUE(fake::inject(pkt, sizeof pkt));
        TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_receive(buf, sizeof buf, len));
        TEST_ASSERT_EQUAL_UINT8(sizeof pkt, len);
        TEST_ASSERT_EQUAL_HEX8_ARRAY(pkt, buf, sizeof pkt);
    }
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio_receive(buf, sizeof buf, len));
}

// A full queue must refuse a 9th packet, not write over the oldest one.
static void test_inject_refuses_when_queue_full(void) {
    for (uint8_t i = 0; i < 8; i++) {
        TEST_ASSERT_TRUE(fake::inject(&i, 1));
    }
    const uint8_t extra = 0xEE;
    TEST_ASSERT_FALSE(fake::inject(&extra, 1));
    uint8_t buf[16];
    uint8_t len = 0;
    for (uint8_t i = 0; i < 8; i++) {
        TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_receive(buf, sizeof buf, len));
        TEST_ASSERT_EQUAL_HEX8(i, buf[0]);
    }
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio_receive(buf, sizeof buf, len));
}

static void test_inject_refuses_empty_packet(void) {
    const uint8_t pkt[] = {1};
    TEST_ASSERT_FALSE(fake::inject(pkt, 0));
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio_receive(buf, sizeof buf, len));
}

static void test_receive_drops_packet_bigger_than_buffer(void) {
    const uint8_t pkt[8] = {0};
    TEST_ASSERT_TRUE(fake::inject(pkt, sizeof pkt));
    uint8_t small[4];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::ErrTooLong,
                      radio_receive(small, sizeof small, len));
    // The too-big packet is thrown away, so it does not block the queue.
    TEST_ASSERT_EQUAL(RadioStatus::NoData,
                      radio_receive(small, sizeof small, len));
}

static void test_send_is_visible_to_the_test(void) {
    const uint8_t pkt[] = {9, 8, 7};
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_send(pkt, sizeof pkt));
    uint8_t back[16];
    const uint8_t n = fake::last_sent(back, sizeof back);
    TEST_ASSERT_EQUAL_UINT8(sizeof pkt, n);
    TEST_ASSERT_EQUAL_HEX8_ARRAY(pkt, back, sizeof pkt);
}

static void test_reset_forgets_what_was_sent(void) {
    const uint8_t pkt[] = {1, 2};
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_send(pkt, sizeof pkt));
    fake::reset(true);
    uint8_t back[16];
    TEST_ASSERT_EQUAL_UINT8(0, fake::last_sent(back, sizeof back));
    TEST_ASSERT_EQUAL_UINT(0, fake::sent_count());
}

static void test_send_counts_each_packet(void) {
    const uint8_t a[] = {1};
    const uint8_t b[] = {2, 3};
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_send(a, sizeof a));
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_send(b, sizeof b));
    TEST_ASSERT_EQUAL_UINT(2, fake::sent_count());
    uint8_t back[16];
    TEST_ASSERT_EQUAL_UINT8(sizeof b, fake::last_sent(back, sizeof back));
    TEST_ASSERT_EQUAL_HEX8_ARRAY(b, back, sizeof b);
}

static void test_send_fails_when_chip_missing(void) {
    fake::reset(false);
    const uint8_t pkt[] = {1};
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound, radio_send(pkt, sizeof pkt));
    TEST_ASSERT_EQUAL_UINT(0, fake::sent_count());
}

static void test_send_gives_the_failure_the_test_asks_for(void) {
    fake::set_send_result(RadioStatus::ErrTooLong);
    const uint8_t pkt[] = {1};
    TEST_ASSERT_EQUAL(RadioStatus::ErrTooLong, radio_send(pkt, sizeof pkt));
    TEST_ASSERT_EQUAL_UINT(0, fake::sent_count());
    // reset() puts it back to Ok.
    fake::reset(true);
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio_send(pkt, sizeof pkt));
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_probe_ok_when_chip_present);
    RUN_TEST(test_probe_reports_not_found_when_chip_missing);
    RUN_TEST(test_receive_with_nothing_waiting_returns_no_data);
    RUN_TEST(test_receive_returns_injected_packet_with_its_length);
    RUN_TEST(test_receive_is_first_in_first_out);
    RUN_TEST(test_receive_keeps_working_after_queue_wraps);
    RUN_TEST(test_inject_refuses_when_queue_full);
    RUN_TEST(test_inject_refuses_empty_packet);
    RUN_TEST(test_receive_drops_packet_bigger_than_buffer);
    RUN_TEST(test_send_is_visible_to_the_test);
    RUN_TEST(test_reset_forgets_what_was_sent);
    RUN_TEST(test_send_counts_each_packet);
    RUN_TEST(test_send_fails_when_chip_missing);
    RUN_TEST(test_send_gives_the_failure_the_test_asks_for);
    return UNITY_END();
}
