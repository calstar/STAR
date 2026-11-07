#ifndef STAR_FAKE_AIR_H
#define STAR_FAKE_AIR_H

// A pretend SX1262 on a virtual clock, for the Idle end-to-end checks.
// It answers the commands Sx1262Setup (start-up, send) and Ryan's Sx1262
// (receive) use, the way DS_SX1261-2 Rev 1.2 describes: TxDone after the
// packet's time on air (6.1.4 p.41), Timeout when the SetTx timer runs out
// (p.69), RxDone + DIO1 when the ground's packet lands while it listens in
// continuous RX (SetRx 0xFFFFFF, p.70). Every sent packet is captured with
// the virtual time it left the antenna.

#include <string.h>

#include "sx1262.h"
#include "sx1262_setup.h"

namespace radio_link {

class FakeAir : public SpiBus {
public:
    struct Sent {
        uint32_t t_ms;
        uint8_t len;
        uint8_t data[255];
    };
    static constexpr unsigned kMaxSent = 64;

    explicit FakeAir(uint32_t* now_ms) : now_(now_ms) {
        memset(buffer_, 0, sizeof buffer_);
    }

    // Test knobs.
    bool tx_never_done = false;  // TxDone never comes (bad PA, no antenna)

    // What happened.
    bool listening = false;  // in continuous RX
    uint16_t irq = 0;
    unsigned n_sent = 0;
    Sent sent[kMaxSent];
    unsigned tx_attempts = 0;

    // The ground's packet arrives now. Heard only while listening.
    bool packet_arrives(const uint8_t* bytes, uint8_t n) {
        if (!listening)
            return false;
        memcpy(buffer_ + kRxBase, bytes, n);
        rx_len_ = n;
        irq |= kIrqRxDone;
        return true;
    }
    bool dio1() const {
        return (irq & kDio1Mask) != 0;
    }

    bool wait_busy() override {
        return true;
    }

    void transfer(const uint8_t* tx, uint8_t* rx, uint16_t len) override {
        memset(rx, 0, len);
        rx[1] = listening ? 0x54 : 0x24;  // RX / STBY_RC, no error (p.95)
        const uint16_t addr =
            len >= 3 ? static_cast<uint16_t>(tx[1] << 8 | tx[2]) : 0;
        switch (tx[0]) {
            case 0x80:  // SetStandby
                listening = false;
                break;
            case 0x82:  // SetRx: 0xFFFFFF = continuous
                listening = tx[1] == 0xFF && tx[2] == 0xFF && tx[3] == 0xFF;
                break;
            case 0x8C:  // SetPacketParams: byte 4 = payload length
                payload_len_ = tx[4];
                break;
            case 0x1D:  // ReadRegister
                rx[4] = addr == 0x08D8 ? 0xC8 : addr == 0x0889 ? 0x01 : 0;
                break;
            case 0x0E:  // WriteBuffer
                memcpy(buffer_ + tx[1], tx + 2, len - 2u);
                break;
            case 0x83: {  // SetTx with timeout steps of 15.625 us
                tx_attempts++;
                const uint32_t steps = static_cast<uint32_t>(tx[1]) << 16 |
                                       static_cast<uint32_t>(tx[2]) << 8 |
                                       tx[3];
                tx_start_ = *now_;
                tx_timeout_ms_ = steps * 15625u / 1000000u;
                LoraConfig cfg = kDefaultLora;
                tx_done_ms_ =
                    (lora_time_on_air_us(cfg, payload_len_) + 999u) / 1000u;
                transmitting_ = true;
                listening = false;
                break;
            }
            case 0x12:  // GetIrqStatus
                if (transmitting_) {
                    const uint32_t dt = *now_ - tx_start_;
                    if (!tx_never_done && dt >= tx_done_ms_) {
                        transmitting_ = false;
                        irq |= 1u << 0;  // TxDone
                        if (n_sent < kMaxSent) {
                            Sent& s = sent[n_sent++];
                            s.t_ms = tx_start_;
                            s.len = payload_len_;
                            memcpy(s.data, buffer_, payload_len_);
                        }
                    } else if (dt >= tx_timeout_ms_) {
                        transmitting_ = false;
                        irq |= 1u << 9;  // Timeout
                    }
                }
                rx[2] = static_cast<uint8_t>(irq >> 8);
                rx[3] = static_cast<uint8_t>(irq);
                break;
            case 0x02:  // ClearIrqStatus
                irq = static_cast<uint16_t>(irq & ~(tx[1] << 8 | tx[2]));
                break;
            case 0x13:  // GetRxBufferStatus
                rx[2] = rx_len_;
                rx[3] = kRxBase;
                break;
            case 0x1E:  // ReadBuffer: RFU, status, status, data
                for (unsigned i = 3; i < len; ++i)
                    rx[i] = buffer_[(tx[1] + i - 3) & 0xFF];
                break;
            default:
                break;
        }
    }

private:
    static constexpr uint8_t kRxBase = 0x80;  // anywhere but the TX bytes
    static constexpr uint16_t kDio1Mask = 0x0263;
    uint32_t* now_;
    uint8_t buffer_[256];
    uint8_t payload_len_ = 0, rx_len_ = 0;
    bool transmitting_ = false;
    uint32_t tx_start_ = 0, tx_done_ms_ = 0, tx_timeout_ms_ = 0;
};

}  // namespace radio_link

#endif  // STAR_FAKE_AIR_H
