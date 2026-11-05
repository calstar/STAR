#include "link.h"

#include "radio.h"

namespace radio_link {

ArmAction Link::poll(uint32_t now_ms) {
    uint8_t len = 0;

    gate_.tick(now_ms);

    const RadioStatus rs = radio_receive(buf_, sizeof buf_, len);
    if (rs == RadioStatus::NoData) {
        return ArmAction::None;
    }
    if (rs == RadioStatus::ErrTooLong) {
        frames_dropped_++;  // a packet arrived but could not be used
        return ArmAction::None;
    }
    if (rs != RadioStatus::Ok) {
        radio_errors_++;  // the radio itself did not answer
        return ArmAction::None;
    }
    if (decode_frame(buf_, len, frame_) != FrameStatus::Ok) {
        frames_dropped_++;
        return ArmAction::None;
    }
    frames_ok_++;
    return gate_.on_frame(frame_, now_ms);
}

}  // namespace radio_link
