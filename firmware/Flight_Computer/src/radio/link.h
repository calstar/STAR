/**
 * @file link.h
 * @brief Glue: radio_receive() -> decode_frame() -> ArmGate. Call poll() from
 *        the main loop (or after the radio interrupt wakes the MCU).
 */
#ifndef LINK_H
#define LINK_H

#include <stdint.h>

#include "arm_gate.h"
#include "frame.h"

namespace radio_link {

class Link {
public:
    explicit Link(uint8_t target_id) : gate_(target_id) {
    }

    /**
     * Drain at most one waiting packet (the SX1262 holds one at a time, so
     * do not loop here; call again on the next DIO1 interrupt). Returns the
     * gate's action for it: ArmAction::None if nothing was waiting, the packet
     * was invalid, or it was not an ARM/UN_ARM frame (check the counters to
     * tell them apart).
     */
    ArmAction poll(uint32_t now_ms);

    uint32_t frames_ok() const {
        return frames_ok_;
    }  // valid frames
    uint32_t frames_dropped() const {
        return frames_dropped_;
    }  // a packet arrived but was unusable: bad CRC, too long, etc.
    uint32_t radio_errors() const {
        return radio_errors_;
    }  // the radio did not answer (ErrNotFound, ErrTimeout, ...)
    // The last frame that decoded (any type), for telemetry and link tests.
    // Valid once frames_ok() > 0; the next good frame overwrites it.
    const Frame& last_frame() const {
        return frame_;
    }

private:
    ArmGate gate_;
    uint32_t frames_ok_ = 0;
    uint32_t frames_dropped_ = 0;
    uint32_t radio_errors_ = 0;
    // Packet and frame buffers live here, not on the caller's stack
    // (~0.5 KB): one Link per radio task.
    uint8_t buf_[kLoraMaxPacket];
    Frame frame_;
};

}  // namespace radio_link

#endif  // LINK_H
