#include <cstring>

#include "frame.h"
#include "selftest_radio.h"

extern "C" bool selftest_radio_init(selftest_radio_t* tx, uint16_t bits,
                                    uint16_t mv, uint16_t seq, uint32_t now) {
    if (!tx)
        return false;
    std::memset(tx, 0, sizeof(*tx));
    uint8_t payload[radio_link::kSelfTestLen];
    radio_link::put_u16(payload, bits);
    radio_link::put_u16(payload + 2, mv);
    size_t size = 0;
    tx->next_ms = now;
    return radio_link::encode_frame(radio_link::FrameType::SelfTest, seq,
                                    payload, sizeof(payload), tx->bytes,
                                    sizeof(tx->bytes),
                                    size) == radio_link::FrameStatus::Ok &&
           size == sizeof(tx->bytes);
}
