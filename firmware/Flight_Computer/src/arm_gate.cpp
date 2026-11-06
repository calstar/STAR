#include "arm_gate.h"

namespace radio_link {

namespace {

// True if a is strictly newer than b, treating the u16 as a wrapping counter.
bool seq_newer(uint16_t a, uint16_t b) {
    return static_cast<int16_t>(static_cast<uint16_t>(a - b)) > 0;
}

}  // namespace

void ArmGate::tick(uint32_t now_ms) {
    if (pending_ &&
        static_cast<uint32_t>(now_ms - pending_ms_) > kArmConfirmWindowMs) {
        pending_ = false;
    }
}

void ArmGate::note_seq(uint16_t seq) {
    if (!have_last_ || seq_newer(seq, last_seq_)) {
        last_seq_ = seq;
        have_last_ = true;
    }
}

ArmAction ArmGate::on_frame(const Frame& f, uint32_t now_ms) {
    tick(now_ms);

    if (f.type == FrameType::UnArm) {
        pending_ = false;
        note_seq(f.seq);
        return ArmAction::Disarm;
    }
    if (f.type != FrameType::Arm) {
        return ArmAction::None;
    }

    // From here on, any rejection also cancels a pending first ARM.
    const uint32_t key = get_u32(f.payload);
    const uint32_t key_inv = get_u32(f.payload + 4);
    const uint8_t target = f.payload[8];

    if (key != kArmKey || key_inv != static_cast<uint32_t>(~kArmKey)) {
        pending_ = false;
        return ArmAction::RejectKey;
    }
    if (target != target_id_) {
        pending_ = false;
        return ArmAction::RejectTarget;
    }
    if (have_last_ && !seq_newer(f.seq, last_seq_)) {
        pending_ = false;
        return ArmAction::RejectStale;
    }
    note_seq(f.seq);

    if (pending_ && f.seq == static_cast<uint16_t>(pending_seq_ + 1u)) {
        pending_ = false;
        return ArmAction::Arm;
    }
    // First valid ARM, or the second one was not consecutive: start over.
    pending_ = true;
    pending_seq_ = f.seq;
    pending_ms_ = now_ms;
    return ArmAction::Pending;
}

}  // namespace radio_link
