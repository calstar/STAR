// Host unit tests for the Valve Encoder's pure logic (no hardware):
//   cd firmware/Hotfire_Code/ValveEncoder && pio test -e native

#include <string.h>
#include <unity.h>

#include "valve_protocol.h"
#include "valve_state.h"

using namespace valve_proto;
using valve::Calibration;
using valve::State;

void setUp() {
}
void tearDown() {
}

// ---------------------------------------------------------------- protocol

static void test_crc_matches_published_check_value() {
    const uint8_t msg[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
    TEST_ASSERT_EQUAL_HEX16(0x29B1, crc16(msg, sizeof(msg)));
}

static void test_status_frame_layout() {
    ValveStatus s = {7, 2, StatusFlags::MAGNET_DETECTED, 0x0ABC, 0x01020304};
    uint8_t buf[MAX_FRAME];
    size_t n = encodeStatus(3, s, buf, sizeof(buf));
    TEST_ASSERT_EQUAL(16, n);
    const uint8_t expect_head[] = {0xAA, 0x55, 0x01, 3,    9,    7,    2,
                                   0x01, 0xBC, 0x0A, 0x04, 0x03, 0x02, 0x01};
    TEST_ASSERT_EQUAL_HEX8_ARRAY(expect_head, buf, sizeof(expect_head));
    uint16_t crc = crc16(buf + 2, 3 + 9);
    TEST_ASSERT_EQUAL_HEX8(crc & 0xFF, buf[14]);
    TEST_ASSERT_EQUAL_HEX8(crc >> 8, buf[15]);
}

static void test_status_roundtrip_through_parser() {
    ValveStatus s = {200, 3, 0x11, 4095, 123456789u};
    uint8_t buf[MAX_FRAME];
    size_t n = encodeStatus(42, s, buf, sizeof(buf));
    Parser p;
    int done = 0;
    for (size_t i = 0; i < n; i++)
        done += p.feed(buf[i]);
    TEST_ASSERT_EQUAL(1, done);
    TEST_ASSERT_EQUAL(42, p.frame().valve_id);
    ValveStatus out;
    TEST_ASSERT_TRUE(decodeStatus(p.frame(), out));
    TEST_ASSERT_EQUAL(200, out.seq);
    TEST_ASSERT_EQUAL(3, out.state);
    TEST_ASSERT_EQUAL_HEX8(0x11, out.flags);
    TEST_ASSERT_EQUAL(4095, out.raw_angle);
    TEST_ASSERT_EQUAL_UINT32(123456789u, out.uptime_ms);
}

static void test_parser_skips_garbage_and_finds_frames() {
    uint8_t stream[64];
    size_t k = 0;
    const uint8_t junk[] = {0x00, 0xAA, 0x13, 0x55, 0xAA, 0xAA};
    memcpy(stream, junk, sizeof(junk));
    k += sizeof(junk);  // ends in 0xAA 0xAA: next real 0xAA 0x55 must sync
    ValveStatus s = {1, 1, 0, 100, 5};
    k += encodeStatus(9, s, stream + k, sizeof(stream) - k);
    k += encodePoll(9, stream + k, sizeof(stream) - k);
    Parser p;
    int frames = 0;
    uint8_t types[2] = {0, 0};
    for (size_t i = 0; i < k; i++) {
        if (p.feed(stream[i])) {
            if (frames < 2)
                types[frames] = p.frame().type;
            frames++;
        }
    }
    TEST_ASSERT_EQUAL(2, frames);
    TEST_ASSERT_EQUAL_HEX8(0x01, types[0]);
    TEST_ASSERT_EQUAL_HEX8(0x10, types[1]);
}

static void test_parser_rejects_corrupted_byte() {
    ValveStatus s = {1, 1, 0, 1234, 99};
    uint8_t buf[MAX_FRAME];
    size_t n = encodeStatus(5, s, buf, sizeof(buf));
    buf[8] ^= 0x01;  // flip one bit in raw_angle
    Parser p;
    int done = 0;
    for (size_t i = 0; i < n; i++)
        done += p.feed(buf[i]);
    TEST_ASSERT_EQUAL(0, done);
    TEST_ASSERT_EQUAL_UINT32(1, p.badFrames());
    // and it recovers on the next good frame
    n = encodeStatus(5, s, buf, sizeof(buf));
    for (size_t i = 0; i < n; i++)
        done += p.feed(buf[i]);
    TEST_ASSERT_EQUAL(1, done);
}

static void test_parser_rejects_oversize_length() {
    const uint8_t bad[] = {0xAA, 0x55, 0x01, 1, MAX_PAYLOAD + 1};
    Parser p;
    for (size_t i = 0; i < sizeof(bad); i++)
        TEST_ASSERT_FALSE(p.feed(bad[i]));
    TEST_ASSERT_EQUAL_UINT32(1, p.badFrames());
}

static void test_encode_refuses_small_buffer() {
    ValveStatus s = {0, 0, 0, 0, 0};
    uint8_t buf[10];
    TEST_ASSERT_EQUAL(0, encodeStatus(1, s, buf, sizeof(buf)));
}

// ------------------------------------------------------------------- state

static Calibration cal(uint16_t closed, uint16_t open, uint16_t tol = 57) {
    Calibration c;
    c.closed_raw = closed;
    c.open_raw = open;
    c.tolerance = tol;
    c.has_closed = true;
    c.has_open = true;
    return c;
}

static void test_wrap_delta() {
    TEST_ASSERT_EQUAL(16, valve::wrapDelta(10, 4090));
    TEST_ASSERT_EQUAL(-16, valve::wrapDelta(4090, 10));
    TEST_ASSERT_EQUAL(1024, valve::wrapDelta(2024, 1000));
    TEST_ASSERT_EQUAL(-2048, valve::wrapDelta(0, 2048));
}

static void test_closed_open_moving() {
    Calibration c = cal(1000, 2024);  // 90 deg, clockwise
    TEST_ASSERT_EQUAL(State::CLOSED, valve::classify(1000, true, c));
    TEST_ASSERT_EQUAL(State::CLOSED, valve::classify(1057, true, c));
    TEST_ASSERT_EQUAL(State::MOVING, valve::classify(1058, true, c));
    TEST_ASSERT_EQUAL(State::MOVING, valve::classify(1512, true, c));
    TEST_ASSERT_EQUAL(State::OPEN, valve::classify(1967, true, c));
    TEST_ASSERT_EQUAL(State::OPEN, valve::classify(2024, true, c));
    TEST_ASSERT_EQUAL(500, valve::travelPermille(1512, c));
}

static void test_counterclockwise_valve() {
    Calibration c = cal(2024, 1000);  // open is "below" closed
    TEST_ASSERT_EQUAL(State::CLOSED, valve::classify(2024, true, c));
    TEST_ASSERT_EQUAL(State::MOVING, valve::classify(1512, true, c));
    TEST_ASSERT_EQUAL(State::OPEN, valve::classify(1000, true, c));
    TEST_ASSERT_EQUAL(State::FAULT, valve::classify(2600, true, c));
}

static void test_travel_across_zero() {
    Calibration c = cal(3800, 728);  // 3800 -> 4095 -> 0 -> 728 (90 deg)
    TEST_ASSERT_EQUAL(State::CLOSED, valve::classify(3790, true, c));
    TEST_ASSERT_EQUAL(State::MOVING, valve::classify(4095, true, c));
    TEST_ASSERT_EQUAL(State::MOVING, valve::classify(0, true, c));
    TEST_ASSERT_EQUAL(State::OPEN, valve::classify(730, true, c));
    TEST_ASSERT_EQUAL(State::FAULT, valve::classify(2000, true, c));
}

static void test_beyond_end_stops_is_fault() {
    Calibration c = cal(1000, 2024);
    TEST_ASSERT_EQUAL(State::FAULT, valve::classify(900, true, c));
    TEST_ASSERT_EQUAL(State::FAULT, valve::classify(2200, true, c));
}

static void test_bad_sensor_is_fault_even_if_angle_looks_closed() {
    Calibration c = cal(1000, 2024);
    TEST_ASSERT_EQUAL(State::FAULT, valve::classify(1000, false, c));
}

static void test_uncalibrated_is_unknown() {
    Calibration c;  // nothing saved
    TEST_ASSERT_EQUAL(State::UNKNOWN, valve::classify(1000, true, c));
    c.closed_raw = 1000;
    c.has_closed = true;  // only one end saved
    TEST_ASSERT_EQUAL(State::UNKNOWN, valve::classify(1000, true, c));
    Calibration tooClose = cal(1000, 1100);  // windows would overlap
    TEST_ASSERT_FALSE(tooClose.valid());
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_crc_matches_published_check_value);
    RUN_TEST(test_status_frame_layout);
    RUN_TEST(test_status_roundtrip_through_parser);
    RUN_TEST(test_parser_skips_garbage_and_finds_frames);
    RUN_TEST(test_parser_rejects_corrupted_byte);
    RUN_TEST(test_parser_rejects_oversize_length);
    RUN_TEST(test_encode_refuses_small_buffer);
    RUN_TEST(test_wrap_delta);
    RUN_TEST(test_closed_open_moving);
    RUN_TEST(test_counterclockwise_valve);
    RUN_TEST(test_travel_across_zero);
    RUN_TEST(test_beyond_end_stops_is_fault);
    RUN_TEST(test_bad_sensor_is_fault_even_if_angle_looks_closed);
    RUN_TEST(test_uncalibrated_is_unknown);
    return UNITY_END();
}
