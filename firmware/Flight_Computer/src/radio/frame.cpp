#include "frame.h"

#include <string.h>

namespace radio_link {

void put_u16(uint8_t* p, uint16_t v) {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>(v >> 8);
}

void put_u32(uint8_t* p, uint32_t v) {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
    p[2] = static_cast<uint8_t>((v >> 16) & 0xFFu);
    p[3] = static_cast<uint8_t>(v >> 24);
}

uint16_t get_u16(const uint8_t* p) {
    return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) |
                                 (static_cast<uint16_t>(p[1]) << 8));
}

uint32_t get_u32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

uint16_t crc16(const uint8_t* data, size_t len) {
    uint16_t crc = 0xFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= static_cast<uint16_t>(static_cast<uint16_t>(data[i]) << 8);
        for (int b = 0; b < 8; b++) {
            const uint16_t shifted = static_cast<uint16_t>(crc << 1);
            crc = (crc & 0x8000u) ? static_cast<uint16_t>(shifted ^ 0x1021u)
                                  : shifted;
        }
    }
    return crc;
}

namespace {

// Expected payload length for a type byte, or -1 if the type is unknown.
int payload_len_for(uint8_t type) {
    switch (static_cast<FrameType>(type)) {
        case FrameType::Heartbeat:
            return kHeartbeatLen;
        case FrameType::SelfTest:
            return kSelfTestLen;
        case FrameType::Arm:
            return kArmLen;
        case FrameType::UnArm:
            return kUnArmLen;
        default:
            return -1;
    }
}

}  // namespace

FrameStatus decode_frame(const uint8_t* buf, size_t len, Frame& out) {
    if (buf == nullptr) {
        return FrameStatus::ErrArgs;
    }
    if (len < kFrameOverhead) {
        return FrameStatus::ErrTooShort;
    }
    if (buf[0] != kFrameVersion) {
        return FrameStatus::ErrVersion;
    }
    const uint8_t plen = buf[4];
    // The length field must account for every byte we received, exactly.
    if (plen > kFrameMaxPayload || len != kFrameOverhead + plen) {
        return FrameStatus::ErrLength;
    }
    const size_t body = kFrameHeaderLen + plen;
    if (crc16(buf, body) != get_u16(buf + body)) {
        return FrameStatus::ErrCrc;
    }
    const int want = payload_len_for(buf[1]);
    if (want < 0) {
        return FrameStatus::ErrType;
    }
    if (static_cast<int>(plen) != want) {
        return FrameStatus::ErrPayload;
    }
    out.type = static_cast<FrameType>(buf[1]);
    out.seq = get_u16(buf + 2);
    out.payload_len = plen;
    memcpy(out.payload, buf + kFrameHeaderLen, plen);
    return FrameStatus::Ok;
}

FrameStatus encode_frame(FrameType type, uint16_t seq, const uint8_t* payload,
                         uint8_t payload_len, uint8_t* out, size_t out_cap,
                         size_t& out_len) {
    if (out == nullptr || (payload == nullptr && payload_len > 0)) {
        return FrameStatus::ErrArgs;
    }
    const int want = payload_len_for(static_cast<uint8_t>(type));
    if (want < 0) {
        return FrameStatus::ErrType;
    }
    if (static_cast<int>(payload_len) != want) {
        return FrameStatus::ErrPayload;
    }
    const size_t total = kFrameOverhead + payload_len;
    if (out_cap < total) {
        return FrameStatus::ErrArgs;
    }
    out[0] = kFrameVersion;
    out[1] = static_cast<uint8_t>(type);
    put_u16(out + 2, seq);
    out[4] = payload_len;
    if (payload_len > 0) {
        memcpy(out + kFrameHeaderLen, payload, payload_len);
    }
    const size_t body = kFrameHeaderLen + payload_len;
    put_u16(out + body, crc16(out, body));
    out_len = total;
    return FrameStatus::Ok;
}

}  // namespace radio_link
