#pragma once

// RS-485 frame format, Valve Encoder Board <-> Receiver Board.
// CHECK Receiver Board. tools/rs485_monitor.py
// mirror file, change both simultaneously
//
// Frame (multi-byte fields little-endian):
//
//   offset  size  field
//   0       1     SYNC0 = 0xAA
//   1       1     SYNC1 = 0x55
//   2       1     type    (MsgType)
//   3       1     valve_id (1..254; 0 and 0xFF reserved)
//   4       1     len     (payload bytes, 0..MAX_PAYLOAD)
//   5       len   payload
//   5+len   2     CRC-16/CCITT-FALSE over bytes [2 .. 5+len), little-endian
//
// VALVE_STATUS payload (9 bytes):
//   0  u8   seq        +1 per status frame, so drops are visible
//   1  u8   state      ValveState (see valve_state.h)
//   2  u8   flags      StatusFlags bits below
//   3  u16  raw_angle  AS5600 RAW ANGLE, 0..4095 counts (360 deg = 4096)
//   5  u32  uptime_ms  millis() when the reading was taken
//
// POLL payload: 0 bytes. The addressed valve answers with VALVE_STATUS.
// No broadcast poll: every valve answering at once would collide.

#include <stddef.h>
#include <stdint.h>

namespace valve_proto {

constexpr uint8_t SYNC0 = 0xAA;
constexpr uint8_t SYNC1 = 0x55;
constexpr uint8_t HEADER_LEN = 5;  // sync0, sync1, type, id, len
constexpr uint8_t CRC_LEN = 2;
constexpr uint8_t MAX_PAYLOAD = 32;
constexpr size_t MAX_FRAME = HEADER_LEN + MAX_PAYLOAD + CRC_LEN;

enum class MsgType : uint8_t {
    VALVE_STATUS = 0x01,  // valve -> receiver
    POLL = 0x10,          // receiver -> valve
};

namespace StatusFlags {
constexpr uint8_t MAGNET_DETECTED = 0x01;    // AS5600 STATUS.MD
constexpr uint8_t MAGNET_TOO_WEAK = 0x02;    // AS5600 STATUS.ML
constexpr uint8_t MAGNET_TOO_STRONG = 0x04;  // AS5600 STATUS.MH
constexpr uint8_t I2C_ERROR = 0x08;
constexpr uint8_t NOT_CALIBRATED = 0x10;
}  // namespace StatusFlags

constexpr uint8_t STATUS_PAYLOAD_LEN = 9;

struct ValveStatus {
    uint8_t seq;
    uint8_t state;
    uint8_t flags;
    uint16_t raw_angle;
    uint32_t uptime_ms;
};

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). crc16("123456789") == 0x29B1.
inline uint16_t crc16(const uint8_t* data, size_t len, uint16_t crc = 0xFFFF) {
    for (size_t i = 0; i < len; i++) {
        crc ^= static_cast<uint16_t>(data[i]) << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021)
                                 : static_cast<uint16_t>(crc << 1);
        }
    }
    return crc;
}

inline void putU16(uint8_t* p, uint16_t v) {
    p[0] = static_cast<uint8_t>(v & 0xFF);
    p[1] = static_cast<uint8_t>(v >> 8);
}
inline void putU32(uint8_t* p, uint32_t v) {
    for (int i = 0; i < 4; i++)
        p[i] = static_cast<uint8_t>((v >> (8 * i)) & 0xFF);
}
inline uint16_t getU16(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}
inline uint32_t getU32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

// Returns the frame length, or 0 if it doesn't fit.
inline size_t encodeFrame(MsgType type, uint8_t valve_id,
                          const uint8_t* payload, uint8_t len, uint8_t* out,
                          size_t out_cap) {
    if (len > MAX_PAYLOAD)
        return 0;
    const size_t total = HEADER_LEN + len + CRC_LEN;
    if (out_cap < total)
        return 0;
    out[0] = SYNC0;
    out[1] = SYNC1;
    out[2] = static_cast<uint8_t>(type);
    out[3] = valve_id;
    out[4] = len;
    for (uint8_t i = 0; i < len; i++)
        out[HEADER_LEN + i] = payload[i];
    putU16(out + HEADER_LEN + len, crc16(out + 2, 3 + len));
    return total;
}

inline size_t encodeStatus(uint8_t valve_id, const ValveStatus& s, uint8_t* out,
                           size_t out_cap) {
    uint8_t p[STATUS_PAYLOAD_LEN];
    p[0] = s.seq;
    p[1] = s.state;
    p[2] = s.flags;
    putU16(p + 3, s.raw_angle);
    putU32(p + 5, s.uptime_ms);
    return encodeFrame(MsgType::VALVE_STATUS, valve_id, p, STATUS_PAYLOAD_LEN,
                       out, out_cap);
}

inline size_t encodePoll(uint8_t valve_id, uint8_t* out, size_t out_cap) {
    return encodeFrame(MsgType::POLL, valve_id, nullptr, 0, out, out_cap);
}

struct Frame {
    uint8_t type;
    uint8_t valve_id;
    uint8_t len;
    uint8_t payload[MAX_PAYLOAD];
};

inline bool decodeStatus(const Frame& f, ValveStatus& s) {
    if (f.type != static_cast<uint8_t>(MsgType::VALVE_STATUS) ||
        f.len != STATUS_PAYLOAD_LEN)
        return false;
    s.seq = f.payload[0];
    s.state = f.payload[1];
    s.flags = f.payload[2];
    s.raw_angle = getU16(f.payload + 3);
    s.uptime_ms = getU32(f.payload + 5);
    return true;
}

// feed() returns true when a CRC-checked frame is ready in frame().
class Parser {
public:
    bool feed(uint8_t b) {
        switch (state_) {
            case St::SYNC0:
                if (b == SYNC0)
                    state_ = St::SYNC1;
                return false;
            case St::SYNC1:
                if (b == SYNC1)
                    state_ = St::TYPE;
                else if (b != SYNC0)
                    state_ = St::SYNC0;  // 0xAA 0xAA 0x55 still syncs
                return false;
            case St::TYPE:
                frame_.type = b;
                state_ = St::ID;
                return false;
            case St::ID:
                frame_.valve_id = b;
                state_ = St::LEN;
                return false;
            case St::LEN:
                if (b > MAX_PAYLOAD) {
                    bad_frames_++;
                    state_ = St::SYNC0;
                    return false;
                }
                frame_.len = b;
                got_ = 0;
                state_ = (b == 0) ? St::CRC_LO : St::PAYLOAD;
                return false;
            case St::PAYLOAD:
                frame_.payload[got_++] = b;
                if (got_ == frame_.len)
                    state_ = St::CRC_LO;
                return false;
            case St::CRC_LO:
                crc_rx_ = b;
                state_ = St::CRC_HI;
                return false;
            case St::CRC_HI: {
                crc_rx_ |= static_cast<uint16_t>(b) << 8;
                state_ = St::SYNC0;
                uint8_t hdr[3] = {frame_.type, frame_.valve_id, frame_.len};
                uint16_t crc = crc16(hdr, 3);
                crc = crc16(frame_.payload, frame_.len, crc);
                if (crc != crc_rx_) {
                    bad_frames_++;
                    return false;
                }
                good_frames_++;
                return true;
            }
        }
        return false;
    }

    const Frame& frame() const {
        return frame_;
    }
    uint32_t goodFrames() const {
        return good_frames_;
    }
    uint32_t badFrames() const {
        return bad_frames_;
    }

private:
    enum class St : uint8_t {
        SYNC0,
        SYNC1,
        TYPE,
        ID,
        LEN,
        PAYLOAD,
        CRC_LO,
        CRC_HI
    };
    St state_ = St::SYNC0;
    Frame frame_ = {};
    uint8_t got_ = 0;
    uint16_t crc_rx_ = 0;
    uint32_t good_frames_ = 0;
    uint32_t bad_frames_ = 0;
};

}  // namespace valve_proto
