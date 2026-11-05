// Tests for the SX1262 receive path, run against a pretend chip.
#include <string.h>

#include "fake_chip.h"
#include "unity.h"

// Build the code under test.
#include "../../src/sx1262.cpp"

using namespace radio_link;

static FakeChip chip;

void setUp(void) {
    chip.reset();
}
void tearDown(void) {
}

// The UN_ARM frame from the message-format examples.
static const uint8_t kFrame[7] = {0x01, 0x11, 0x05, 0x00, 0x00, 0xBE, 0x3D};

static void test_no_flags_returns_no_data(void) {
    Sx1262 radio(chip);
    uint8_t buf[16];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(0xAB, len);  // len is left alone on NoData
    // Only the "what happened?" question was asked.
    TEST_ASSERT_EQUAL_UINT(1, chip.commands_logged());
    TEST_ASSERT_EQUAL_HEX8(kOpGetIrqStatus, chip.command_at(0));
}

static void test_packet_is_read_with_the_right_bytes_and_length(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0);
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(sizeof kFrame, len);
    TEST_ASSERT_EQUAL_HEX8_ARRAY(kFrame, buf, sizeof kFrame);
}

static void test_the_four_exchanges_happen_in_order(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0);
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT(4, chip.commands_logged());
    TEST_ASSERT_EQUAL_HEX8(kOpGetIrqStatus, chip.command_at(0));
    TEST_ASSERT_EQUAL_HEX8(kOpGetRxBufferStatus, chip.command_at(1));
    TEST_ASSERT_EQUAL_HEX8(kOpReadBuffer, chip.command_at(2));
    TEST_ASSERT_EQUAL_HEX8(kOpClearIrqStatus, chip.command_at(3));
}

static void test_start_position_in_the_chip_buffer_is_used(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 200);  // not at position 0
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_HEX8_ARRAY(kFrame, buf, sizeof kFrame);
}

static void test_packet_flag_is_cleared_after_reading(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0);
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_HEX16(0, chip.irq());
    // The packet is used up, so the next call finds nothing.
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio.receive(buf, sizeof buf, len));
}

static void test_biggest_packet_255_bytes_is_read_whole(void) {
    Sx1262 radio(chip);
    uint8_t big[255];
    for (unsigned i = 0; i < sizeof big; i++) {
        big[i] = static_cast<uint8_t>(i * 7 + 1);
    }
    chip.packet_arrives(big, sizeof big, 100);  // wraps past the buffer end
    uint8_t buf[255];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(255, len);
    TEST_ASSERT_EQUAL_HEX8_ARRAY(big, buf, sizeof big);
}

static void test_packet_bigger_than_the_box_is_dropped(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0);
    uint8_t small[4];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::ErrTooLong,
                      radio.receive(small, sizeof small, len));
    TEST_ASSERT_EQUAL_UINT8(0xAB, len);
    // We never read the bytes, and the flag was cleared.
    TEST_ASSERT_EQUAL_UINT(3, chip.commands_logged());
    TEST_ASSERT_EQUAL_HEX8(kOpClearIrqStatus, chip.command_at(2));
    TEST_ASSERT_EQUAL_HEX16(0, chip.irq());
    TEST_ASSERT_EQUAL(RadioStatus::NoData,
                      radio.receive(small, sizeof small, len));
}

static void test_radio_crc_error_drops_the_packet(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0, kIrqCrcErr);
    uint8_t buf[16];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(0xAB, len);
    TEST_ASSERT_EQUAL_UINT(2, chip.commands_logged());  // asked, then cleared
    TEST_ASSERT_EQUAL_HEX16(0, chip.irq());
}

static void test_header_error_drops_the_packet(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0, kIrqHeaderErr);
    uint8_t buf[16];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT(2, chip.commands_logged());
    TEST_ASSERT_EQUAL_HEX16(0, chip.irq());
}

static void test_zero_length_packet_is_dropped(void) {
    Sx1262 radio(chip);
    chip.set_irq(kIrqRxDone);  // "received", but the length stays 0
    uint8_t buf[16];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::NoData, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(0xAB, len);
    TEST_ASSERT_EQUAL_HEX16(0, chip.irq());
}

static void test_chip_stuck_busy_reports_not_found(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0);
    chip.set_never_ready();
    uint8_t buf[16];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound,
                      radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT(0, chip.transfers());  // we never spoke to it
    TEST_ASSERT_EQUAL_UINT8(0xAB, len);
}

static void test_busy_is_checked_before_every_exchange(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0);
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT(chip.transfers(), chip.waits());
}

// No chip at all: MISO floats or is held at one level. Before the status
// check, 0x00 read as "no flags" and 0xFF as "header + CRC error", so a dead
// radio looked like a quiet one.
static void test_missing_chip_reading_zeros_reports_not_found(void) {
    Sx1262 radio(chip);
    chip.set_stuck(0x00);
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound,
                      radio.receive(buf, sizeof buf, len));
}

static void test_missing_chip_reading_ones_reports_not_found(void) {
    Sx1262 radio(chip);
    chip.set_stuck(0xFF);
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound,
                      radio.receive(buf, sizeof buf, len));
}

// A live chip reporting a failed command (mode RX, status 5 "failure to
// execute": 0x5A) is not treated as "no packet".
static void test_command_failure_status_reports_not_found(void) {
    Sx1262 radio(chip);
    chip.set_status(0x5A);
    uint8_t buf[16];
    uint8_t len = 0;
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound,
                      radio.receive(buf, sizeof buf, len));
}

// A bad status in a later reply (GetRxBufferStatus) is caught too, and no
// packet is handed out.
static void test_bad_status_while_reading_a_packet_reports_not_found(void) {
    Sx1262 radio(chip);
    chip.packet_arrives(kFrame, sizeof kFrame, 0);
    chip.set_status(0x58);  // mode RX, status 4 "processing error"
    uint8_t buf[16];
    uint8_t len = 0xAB;
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound,
                      radio.receive(buf, sizeof buf, len));
    TEST_ASSERT_EQUAL_UINT8(0xAB, len);
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_no_flags_returns_no_data);
    RUN_TEST(test_packet_is_read_with_the_right_bytes_and_length);
    RUN_TEST(test_the_four_exchanges_happen_in_order);
    RUN_TEST(test_start_position_in_the_chip_buffer_is_used);
    RUN_TEST(test_packet_flag_is_cleared_after_reading);
    RUN_TEST(test_biggest_packet_255_bytes_is_read_whole);
    RUN_TEST(test_packet_bigger_than_the_box_is_dropped);
    RUN_TEST(test_radio_crc_error_drops_the_packet);
    RUN_TEST(test_header_error_drops_the_packet);
    RUN_TEST(test_zero_length_packet_is_dropped);
    RUN_TEST(test_chip_stuck_busy_reports_not_found);
    RUN_TEST(test_busy_is_checked_before_every_exchange);
    RUN_TEST(test_missing_chip_reading_zeros_reports_not_found);
    RUN_TEST(test_missing_chip_reading_ones_reports_not_found);
    RUN_TEST(test_command_failure_status_reports_not_found);
    RUN_TEST(test_bad_status_while_reading_a_packet_reports_not_found);
    return UNITY_END();
}
