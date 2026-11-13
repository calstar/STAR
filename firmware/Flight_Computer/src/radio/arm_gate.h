/**
 * @file arm_gate.h
 * @brief Decides whether a valid frame is allowed to ARM or UN-ARM the rocket.
 *
 * Protects against accidents and noise, NOT a deliberate attacker (there is no
 * secret). Rules for ARM:
 *   1. key must equal kArmKey and the next field must equal ~kArmKey
 *   2. target_id must match this rocket
 *   3. sequence must be newer than the last ARM/UN_ARM seen (wrap-safe). The
 *      ground's counter must keep increasing across ground-station restarts;
 *      otherwise ARM is rejected until the rocket reboots (open decision,
 *      see README "Decisions for the lead").
 *   4. a SECOND valid ARM with seq == first.seq + 1 must arrive within
 *      kArmConfirmWindowMs of the first; only then does on_frame() return Arm
 *   Any rejected ARM cancels a pending first ARM.
 * UN_ARM is deliberately easy (disarming is the safe direction): always
 * honored, cancels a pending ARM, and is not subject to the stale-sequence
 * rule or the target id (any rocket in range disarms).
 *
 * The gate only says whether a command is valid. Whether arming is allowed
 * right now (on the pad, in Idle, not in flight) is the state machine's call.
 *
 * Time is passed in (now_ms) so tests need no clock. Unsigned subtraction makes
 * a wrapping 32-bit millisecond counter safe.
 */
#ifndef ARM_GATE_H
#define ARM_GATE_H

#include <stdint.h>

#include "frame.h"

namespace radio_link {

/** PLACEHOLDER: lead to choose the real key before flight. */
constexpr uint32_t kArmKey = 0xA5C3965Au;
/** Max time between the two ARM frames. PLACEHOLDER pending review. */
constexpr uint32_t kArmConfirmWindowMs = 2000;

enum class ArmAction : uint8_t {
    None = 0,      // frame is not ARM/UN_ARM; gate ignores it
    Pending,       // valid first ARM; waiting for the confirm
    Arm,           // confirmed: arm now
    Disarm,        // UN_ARM honored
    RejectKey,     // key / inverse wrong
    RejectTarget,  // addressed to a different rocket
    RejectStale,   // sequence not newer than last seen
};

class ArmGate {
public:
    explicit ArmGate(uint8_t target_id) : target_id_(target_id) {
    }

    /** Feed one already-validated frame (decode_frame returned Ok). */
    ArmAction on_frame(const Frame& f, uint32_t now_ms);

    /** Call periodically so an unconfirmed ARM expires. */
    void tick(uint32_t now_ms);

    bool pending() const {
        return pending_;
    }

private:
    void note_seq(uint16_t seq);

    uint8_t target_id_;
    bool have_last_ = false;  // any ARM/UN_ARM seen since boot?
    uint16_t last_seq_ = 0;   // newest ARM/UN_ARM sequence seen
    bool pending_ = false;    // first ARM accepted, awaiting confirm
    uint16_t pending_seq_ = 0;
    uint32_t pending_ms_ = 0;
};

}  // namespace radio_link

#endif  // ARM_GATE_H
