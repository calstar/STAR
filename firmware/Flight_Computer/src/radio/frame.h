/**
 * @file frame.h
 * @brief Over-the-air frame format for the LoRa command link.
 *
 * Layout (all multi-byte fields little-endian):
 *
 *   byte 0      version   (kFrameVersion)
 *   byte 1      type      (FrameType)
 *   bytes 2-3   sequence  (u16, +1 per frame sent, wraps)
 *   byte 4      length    (payload bytes, 0..kFrameMaxPayload)
 *   bytes 5..   payload   (layout depends on type)
 *   last 2      CRC-16/CCITT-FALSE over every byte before it
 *
 * The LoRa sync word is handled by the radio hardware and is not in the frame.
 *
 * Payloads:
 *   Heartbeat   state u8, battery_mV u16, uptime_s u32          (7 bytes)
 *   SelfTest    result_bits u16, battery_mV u16                 (4 bytes)
 *   Arm         key u32, ~key u32, target_id u8                 (9 bytes)
 *   UnArm       (empty)                                         (0 bytes)
 *
 * Every number here is a proposal pending review (see README.md).
 */
#ifndef FRAME_H
#define FRAME_H

#include <stddef.h>
#include <stdint.h>

#include "radio.h"

namespace radio_link {

constexpr uint8_t kFrameVersion = 0x01;
constexpr size_t kFrameHeaderLen = 5;
constexpr size_t kFrameCrcLen = 2;
constexpr size_t kFrameOverhead = kFrameHeaderLen + kFrameCrcLen;
// The biggest packet the radio can carry (the SX1262 buffer is 256 bytes).
constexpr size_t kLoraMaxPacket = 255;
constexpr size_t kFrameMaxPayload = kLoraMaxPacket - kFrameOverhead;  // 248
constexpr size_t kFrameMaxLen = kFrameOverhead + kFrameMaxPayload;    // 255

static_assert(kFrameMaxLen <= kLoraMaxPacket,
              "a frame must fit in one LoRa packet");

enum class FrameType : uint8_t {
    Heartbeat = 0x01,  // rocket -> ground
    SelfTest = 0x02,   // rocket -> ground
    Status = 0x03,     // rocket -> ground, Idle: ADC + chip checks
    Telemetry = 0x20,  // rocket -> ground, armed: latest sensors
    Arm = 0x10,        // ground -> rocket
    UnArm = 0x11,      // ground -> rocket
};

/** Required payload length per type. */
constexpr uint8_t kHeartbeatLen = 7;
constexpr uint8_t kSelfTestLen = 4;
constexpr uint8_t kArmLen = 9;
constexpr uint8_t kUnArmLen = 0;
// Layouts in src/app/status_report.h (STATUS_REPORT_LEN, TELEMETRY_LEN).
constexpr uint8_t kStatusLen = 45;
constexpr uint8_t kTelemetryLen = 57;

enum class FrameStatus : uint8_t {
    Ok = 0,
    ErrTooShort,  // fewer than kFrameOverhead bytes
    ErrVersion,   // unknown version byte
    ErrLength,    // length field disagrees with bytes received
    ErrCrc,       // checksum mismatch
    ErrType,      // unknown type
    ErrPayload,   // payload size wrong for this type
    ErrArgs,      // bad pointer / capacity passed in
};

struct Frame {
    FrameType type;
    uint16_t seq;
    uint8_t payload_len;
    uint8_t payload[kFrameMaxPayload];
};

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout.
 *  Check value: crc16("123456789") == 0x29B1. */
uint16_t crc16(const uint8_t* data, size_t len);

/**
 * Parse and validate a received packet. On Ok, @p out is filled in.
 * Checks, in order: size, version, length field, CRC, type, payload size.
 * Nothing in @p out is valid unless Ok is returned.
 */
FrameStatus decode_frame(const uint8_t* buf, size_t len, Frame& out);

/**
 * Build a frame into out[0..out_cap). On Ok, @p out_len is the byte count.
 * Payload size is checked against the type, so a malformed frame can't be sent.
 */
FrameStatus encode_frame(FrameType type, uint16_t seq, const uint8_t* payload,
                         uint8_t payload_len, uint8_t* out, size_t out_cap,
                         size_t& out_len);

// Little-endian helpers (byte-wise: no alignment or struct-packing traps).
void put_u16(uint8_t* p, uint16_t v);
void put_u32(uint8_t* p, uint32_t v);
uint16_t get_u16(const uint8_t* p);
uint32_t get_u32(const uint8_t* p);

}  // namespace radio_link

#endif  // FRAME_H
