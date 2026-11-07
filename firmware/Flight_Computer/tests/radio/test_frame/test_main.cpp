// Host tests for frame.cpp. Run on a laptop: no hardware.
#include <string.h>

#include "unity.h"

// Build the code under test.
#include "../../../src/radio/frame.cpp"

using namespace radio_link;

void setUp(void) {
}
void tearDown(void) {
}

// Golden frames computed by an independent Python implementation of the layout
// in frame.h, so these catch a mistake shared by encode and decode.
static const uint8_t GOLDEN_UN_ARM[] = {0x01, 0x11, 0x02, 0x01,
                                        0x00, 0x1F, 0x8B};
static const uint8_t GOLDEN_ARM[] = {0x01, 0x10, 0x01, 0x00, 0x09, 0x5A,
                                     0x96, 0xC3, 0xA5, 0xA5, 0x69, 0x3C,
                                     0x5A, 0x07, 0xFA, 0xCF};
static const uint8_t GOLDEN_HEARTBEAT[] = {0x01, 0x01, 0xEF, 0xBE, 0x07,
                                           0x03, 0xE8, 0x1C, 0x40, 0xE2,
                                           0x01, 0x00, 0xFD, 0x1B};

// Build a frame by hand (bypassing encode_frame's checks) with a valid CRC.
static size_t raw_frame(uint8_t* out, uint8_t type, uint16_t seq,
                        const uint8_t* payload, uint8_t plen) {
    out[0] = kFrameVersion;
    out[1] = type;
    put_u16(out + 2, seq);
    out[4] = plen;
    if (plen) {
        memcpy(out + 5, payload, plen);
    }
    put_u16(out + 5 + plen, crc16(out, 5u + plen));
    return 7u + plen;
}

static void test_crc16_standard_check_value(void) {
    TEST_ASSERT_EQUAL_HEX16(
        0x29B1, crc16(reinterpret_cast<const uint8_t*>("123456789"), 9));
}

static void test_crc16_empty_is_init_value(void) {
    TEST_ASSERT_EQUAL_HEX16(0xFFFF,
                            crc16(reinterpret_cast<const uint8_t*>(""), 0));
}

static void test_little_endian_helpers(void) {
    uint8_t b[4];
    put_u32(b, 0x01020304u);
    TEST_ASSERT_EQUAL_HEX8(0x04, b[0]);
    TEST_ASSERT_EQUAL_HEX8(0x01, b[3]);
    TEST_ASSERT_EQUAL_HEX32(0x01020304u, get_u32(b));
    put_u16(b, 0xBEEF);
    TEST_ASSERT_EQUAL_HEX8(0xEF, b[0]);
    TEST_ASSERT_EQUAL_HEX16(0xBEEF, get_u16(b));
}

static void test_encode_matches_golden_un_arm(void) {
    uint8_t out[kFrameMaxLen];
    size_t n = 0;
    TEST_ASSERT_EQUAL(
        FrameStatus::Ok,
        encode_frame(FrameType::UnArm, 0x0102, nullptr, 0, out, sizeof out, n));
    TEST_ASSERT_EQUAL_UINT(sizeof GOLDEN_UN_ARM, n);
    TEST_ASSERT_EQUAL_HEX8_ARRAY(GOLDEN_UN_ARM, out, n);
}

static void test_encode_matches_golden_arm(void) {
    uint8_t payload[9];
    put_u32(payload, 0xA5C3965Au);
    put_u32(payload + 4, ~0xA5C3965Au);
    payload[8] = 7;
    uint8_t out[kFrameMaxLen];
    size_t n = 0;
    TEST_ASSERT_EQUAL(FrameStatus::Ok, encode_frame(FrameType::Arm, 1, payload,
                                                    9, out, sizeof out, n));
    TEST_ASSERT_EQUAL_UINT(sizeof GOLDEN_ARM, n);
    TEST_ASSERT_EQUAL_HEX8_ARRAY(GOLDEN_ARM, out, n);
}

static void test_decode_golden_heartbeat(void) {
    Frame f;
    TEST_ASSERT_EQUAL(
        FrameStatus::Ok,
        decode_frame(GOLDEN_HEARTBEAT, sizeof GOLDEN_HEARTBEAT, f));
    TEST_ASSERT_EQUAL(FrameType::Heartbeat, f.type);
    TEST_ASSERT_EQUAL_HEX16(0xBEEF, f.seq);
    TEST_ASSERT_EQUAL_UINT8(7, f.payload_len);
    TEST_ASSERT_EQUAL_UINT8(3, f.payload[0]);                  // state
    TEST_ASSERT_EQUAL_UINT16(7400, get_u16(f.payload + 1));    // battery mV
    TEST_ASSERT_EQUAL_UINT32(123456, get_u32(f.payload + 3));  // uptime s
}

static void test_roundtrip_every_type(void) {
    static const struct {
        FrameType type;
        uint8_t len;
    } cases[] = {{FrameType::Heartbeat, 7},
                 {FrameType::SelfTest, 4},
                 {FrameType::Arm, 9},
                 {FrameType::UnArm, 0}};
    for (unsigned i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        uint8_t payload[9];
        for (unsigned k = 0; k < sizeof payload; k++) {
            payload[k] = static_cast<uint8_t>(0x30 + k);
        }
        uint8_t out[kFrameMaxLen];
        size_t n = 0;
        Frame f;
        TEST_ASSERT_EQUAL(FrameStatus::Ok,
                          encode_frame(cases[i].type, 0xFFFF, payload,
                                       cases[i].len, out, sizeof out, n));
        TEST_ASSERT_EQUAL_UINT(7u + cases[i].len, n);
        TEST_ASSERT_EQUAL(FrameStatus::Ok, decode_frame(out, n, f));
        TEST_ASSERT_EQUAL(cases[i].type, f.type);
        TEST_ASSERT_EQUAL_HEX16(0xFFFF, f.seq);
        TEST_ASSERT_EQUAL_UINT8(cases[i].len, f.payload_len);
        if (cases[i].len > 0) {  // Unity rejects zero-length array compares
            TEST_ASSERT_EQUAL_HEX8_ARRAY(payload, f.payload, cases[i].len);
        }
    }
}

static void test_decode_rejects_too_short(void) {
    Frame f;
    TEST_ASSERT_EQUAL(FrameStatus::ErrTooShort,
                      decode_frame(GOLDEN_UN_ARM, 0, f));
    TEST_ASSERT_EQUAL(FrameStatus::ErrTooShort,
                      decode_frame(GOLDEN_UN_ARM, 6, f));
}

static void test_decode_rejects_null_buffer(void) {
    Frame f;
    TEST_ASSERT_EQUAL(FrameStatus::ErrArgs, decode_frame(nullptr, 7, f));
}

static void test_decode_rejects_wrong_version(void) {
    uint8_t b[16];
    const size_t n =
        raw_frame(b, static_cast<uint8_t>(FrameType::UnArm), 1, nullptr, 0);
    b[0] = 0x02;  // CRC now wrong too, but version is checked first
    Frame f;
    TEST_ASSERT_EQUAL(FrameStatus::ErrVersion, decode_frame(b, n, f));
}

static void test_decode_rejects_extra_or_missing_bytes(void) {
    uint8_t b[32];
    const size_t n =
        raw_frame(b, static_cast<uint8_t>(FrameType::UnArm), 1, nullptr, 0);
    Frame f;
    b[n] = 0x00;  // one trailing byte
    TEST_ASSERT_EQUAL(FrameStatus::ErrLength, decode_frame(b, n + 1, f));
    TEST_ASSERT_EQUAL(FrameStatus::ErrTooShort, decode_frame(b, n - 1, f));
    // Truncated ARM: length field says 9 but bytes are missing.
    TEST_ASSERT_EQUAL(FrameStatus::ErrLength,
                      decode_frame(GOLDEN_ARM, sizeof GOLDEN_ARM - 1, f));
}

static void test_decode_rejects_oversize_length_field(void) {
    uint8_t b[300];
    memset(b, 0, sizeof b);
    b[0] = kFrameVersion;
    b[1] = static_cast<uint8_t>(FrameType::Heartbeat);
    b[4] = 249;  // > kFrameMaxPayload
    Frame f;
    TEST_ASSERT_EQUAL(FrameStatus::ErrLength, decode_frame(b, 7u + 249u, f));
}

static void test_decode_rejects_any_single_bit_flip(void) {
    // CRC-16 detects every single-bit error: flip each bit of each byte of a
    // valid ARM frame and confirm none of them decodes as Ok.
    uint8_t b[sizeof GOLDEN_ARM];
    Frame f;
    for (unsigned i = 0; i < sizeof b; i++) {
        for (unsigned bit = 0; bit < 8; bit++) {
            memcpy(b, GOLDEN_ARM, sizeof b);
            b[i] ^= static_cast<uint8_t>(1u << bit);
            TEST_ASSERT_NOT_EQUAL_MESSAGE(
                static_cast<int>(FrameStatus::Ok),
                static_cast<int>(decode_frame(b, sizeof b, f)),
                "corrupted frame was accepted");
        }
    }
}

static void test_decode_rejects_unknown_type_with_valid_crc(void) {
    uint8_t b[16];
    const size_t n = raw_frame(b, 0x7F, 1, nullptr, 0);
    Frame f;
    TEST_ASSERT_EQUAL(FrameStatus::ErrType, decode_frame(b, n, f));
}

static void test_decode_rejects_wrong_payload_size_with_valid_crc(void) {
    uint8_t payload[8] = {0};
    uint8_t b[32];
    Frame f;
    // ARM must be exactly 9 bytes.
    size_t n =
        raw_frame(b, static_cast<uint8_t>(FrameType::Arm), 1, payload, 8);
    TEST_ASSERT_EQUAL(FrameStatus::ErrPayload, decode_frame(b, n, f));
    // UN_ARM must be empty.
    n = raw_frame(b, static_cast<uint8_t>(FrameType::UnArm), 1, payload, 1);
    TEST_ASSERT_EQUAL(FrameStatus::ErrPayload, decode_frame(b, n, f));
}

static void test_encode_rejects_bad_inputs(void) {
    uint8_t payload[9] = {0};
    uint8_t out[kFrameMaxLen];
    size_t n = 0;
    TEST_ASSERT_EQUAL(FrameStatus::ErrType,
                      encode_frame(static_cast<FrameType>(0x7F), 0, nullptr, 0,
                                   out, sizeof out, n));
    TEST_ASSERT_EQUAL(
        FrameStatus::ErrPayload,
        encode_frame(FrameType::Arm, 0, payload, 8, out, sizeof out, n));
    TEST_ASSERT_EQUAL(FrameStatus::ErrArgs,
                      encode_frame(FrameType::Arm, 0, payload, 9, out, 15, n));
    TEST_ASSERT_EQUAL(
        FrameStatus::ErrArgs,
        encode_frame(FrameType::Arm, 0, nullptr, 9, out, sizeof out, n));
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_crc16_standard_check_value);
    RUN_TEST(test_crc16_empty_is_init_value);
    RUN_TEST(test_little_endian_helpers);
    RUN_TEST(test_encode_matches_golden_un_arm);
    RUN_TEST(test_encode_matches_golden_arm);
    RUN_TEST(test_decode_golden_heartbeat);
    RUN_TEST(test_roundtrip_every_type);
    RUN_TEST(test_decode_rejects_too_short);
    RUN_TEST(test_decode_rejects_null_buffer);
    RUN_TEST(test_decode_rejects_wrong_version);
    RUN_TEST(test_decode_rejects_extra_or_missing_bytes);
    RUN_TEST(test_decode_rejects_oversize_length_field);
    RUN_TEST(test_decode_rejects_any_single_bit_flip);
    RUN_TEST(test_decode_rejects_unknown_type_with_valid_crc);
    RUN_TEST(test_decode_rejects_wrong_payload_size_with_valid_crc);
    RUN_TEST(test_encode_rejects_bad_inputs);
    return UNITY_END();
}
