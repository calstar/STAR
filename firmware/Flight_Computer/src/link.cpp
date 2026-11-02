#include "link.h"

#include "radio.h"

namespace radio_link {

ArmAction Link::poll(uint32_t now_ms) {
    uint8_t buf[kLoraMaxPacket];
    uint8_t len = 0;
    Frame f;

    gate_.tick(now_ms);

    const RadioStatus rs = radio_receive(buf, sizeof buf, len);
    if (rs == RadioStatus::NoData) {
        return ArmAction::None;
    }
    if (rs != RadioStatus::Ok) {
        frames_dropped_++;
        return ArmAction::None;
    }
    if (decode_frame(buf, len, f) != FrameStatus::Ok) {
        frames_dropped_++;
        return ArmAction::None;
    }
    frames_ok_++;
    return gate_.on_frame(f, now_ms);
}

}  // namespace radio_link
