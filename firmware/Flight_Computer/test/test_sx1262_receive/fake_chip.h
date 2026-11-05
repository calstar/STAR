#ifndef FAKE_CHIP_H
#define FAKE_CHIP_H

#include <string.h>

#include "sx1262.h"

namespace radio_link {

// A pretend SX1262 for tests. It keeps the chip's 256-byte buffer and IRQ
// register in memory, answers the four commands the receive path uses, and
// writes down every command it is given.
class FakeChip : public SpiBus {
public:
    static constexpr unsigned kLogSize = 16;
    // Status byte it replies with: chip mode RX (5), command status "data
    // available" (2). Datasheet Rev 1.2, Table 13-76, page 95.
    static constexpr uint8_t kStatus = 0x54;

    FakeChip() {
        reset();
    }

    void reset() {
        memset(buffer_, 0, sizeof buffer_);
        irq_ = 0;
        packet_len_ = 0;
        packet_start_ = 0;
        never_ready_ = false;
        status_ = kStatus;
        stuck_ = false;
        stuck_level_ = 0;
        waits_ = 0;
        transfers_ = 0;
        log_len_ = 0;
    }

    // Pretend a packet arrived and was stored at `start`.
    void packet_arrives(const uint8_t* bytes, uint8_t n, uint8_t start,
                        uint16_t extra_flags = 0) {
        for (unsigned i = 0; i < n; i++) {
            buffer_[(start + i) & 0xFF] = bytes[i];
        }
        packet_len_ = n;
        packet_start_ = start;
        irq_ = static_cast<uint16_t>(kIrqRxDone | extra_flags);
    }

    // Pretend the chip raised only these flags (no packet stored).
    void set_irq(uint16_t flags) {
        irq_ = flags;
    }

    // Pretend the BUSY pin never goes low.
    void set_never_ready() {
        never_ready_ = true;
    }

    // Reply with this status byte instead of kStatus.
    void set_status(uint8_t status) {
        status_ = status;
    }

    // Pretend there is no chip: MISO reads `level` on every byte.
    void set_stuck(uint8_t level) {
        stuck_ = true;
        stuck_level_ = level;
    }

    uint16_t irq() const {
        return irq_;
    }
    unsigned waits() const {
        return waits_;
    }
    unsigned transfers() const {
        return transfers_;
    }
    unsigned commands_logged() const {
        return log_len_;
    }
    uint8_t command_at(unsigned i) const {
        return log_[i];
    }

    bool wait_busy() override {
        waits_++;
        return !never_ready_;
    }

    void transfer(const uint8_t* tx, uint8_t* rx, uint16_t len) override {
        transfers_++;
        if (log_len_ < kLogSize) {
            log_[log_len_++] = tx[0];
        }
        if (stuck_) {
            memset(rx, stuck_level_, len);
            return;
        }
        memset(rx, 0xEE, len);  // junk, so tests catch reads of the wrong byte
        switch (tx[0]) {
            case kOpGetIrqStatus:
                rx[1] = status_;
                rx[2] = static_cast<uint8_t>(irq_ >> 8);
                rx[3] = static_cast<uint8_t>(irq_ & 0xFF);
                break;
            case kOpGetRxBufferStatus:
                rx[1] = status_;
                rx[2] = packet_len_;
                rx[3] = packet_start_;
                break;
            case kOpReadBuffer:
                rx[1] = status_;
                rx[2] = status_;
                for (unsigned i = 3; i < len; i++) {
                    rx[i] = buffer_[(tx[1] + (i - 3)) & 0xFF];
                }
                break;
            case kOpClearIrqStatus:
                irq_ = static_cast<uint16_t>(
                    irq_ & ~static_cast<uint16_t>((tx[1] << 8) | tx[2]));
                break;
            default:
                break;
        }
    }

private:
    uint8_t buffer_[256];
    uint16_t irq_;
    uint8_t packet_len_;
    uint8_t packet_start_;
    bool never_ready_;
    uint8_t status_;
    bool stuck_;
    uint8_t stuck_level_;
    unsigned waits_;
    unsigned transfers_;
    uint8_t log_[kLogSize];
    unsigned log_len_;
};

}  // namespace radio_link

#endif  // FAKE_CHIP_H
