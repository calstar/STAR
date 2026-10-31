// Tests for the promises radio.h makes, run against the fake radio.
// Any real radio driver must keep these same promises.
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

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_probe_ok_when_chip_present);
    RUN_TEST(test_probe_reports_not_found_when_chip_missing);
    RUN_TEST(test_receive_with_nothing_waiting_returns_no_data);
    RUN_TEST(test_receive_returns_injected_packet_with_its_length);
    RUN_TEST(test_receive_is_first_in_first_out);
    RUN_TEST(test_receive_drops_packet_bigger_than_buffer);
    RUN_TEST(test_send_is_visible_to_the_test);
    return UNITY_END();
}
