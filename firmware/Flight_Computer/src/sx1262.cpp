#include "sx1262.h"

#include <string.h>

namespace radio_link {
namespace {

// Biggest SPI exchange we make: ReadBuffer = opcode + offset + NOP + up to
// 255 packet bytes.
constexpr unsigned kMaxExchange = 3 + 255;

// Flags we clear once we have dealt with a packet (good or bad).
constexpr uint16_t kPacketFlags = kIrqRxDone | kIrqHeaderErr | kIrqCrcErr;

}  // namespace

bool Sx1262::command(const uint8_t* tx, uint8_t* rx, uint16_t n) {
    if (!bus_.wait_busy()) {
        return false;
    }
    bus_.transfer(tx, rx, n);
    return true;
}

bool Sx1262::clear_irq(uint16_t mask) {
    const uint8_t tx[3] = {kOpClearIrqStatus, static_cast<uint8_t>(mask >> 8),
                           static_cast<uint8_t>(mask & 0xFF)};
    uint8_t rx[3];
    return command(tx, rx, sizeof tx);
}

RadioStatus Sx1262::receive(uint8_t* buf, uint8_t max_len, uint8_t& len) {
    // 1. What happened? Reply bytes: junk, status, IRQ high, IRQ low.
    const uint8_t irq_tx[4] = {kOpGetIrqStatus, 0, 0, 0};
    uint8_t irq_rx[4];
    if (!command(irq_tx, irq_rx, sizeof irq_tx)) {
        return RadioStatus::ErrNotFound;
    }
    const uint16_t irq = static_cast<uint16_t>((irq_rx[2] << 8) | irq_rx[3]);

    // A packet the radio itself flagged as damaged: throw it away.
    if ((irq & (kIrqHeaderErr | kIrqCrcErr)) != 0) {
        return clear_irq(kPacketFlags) ? RadioStatus::NoData
                                       : RadioStatus::ErrNotFound;
    }
    if ((irq & kIrqRxDone) == 0) {
        return RadioStatus::NoData;
    }

    // 2. How long is the packet, and where is it?
    // Reply bytes: junk, status, length, start position.
    const uint8_t buf_tx[4] = {kOpGetRxBufferStatus, 0, 0, 0};
    uint8_t buf_rx[4];
    if (!command(buf_tx, buf_rx, sizeof buf_tx)) {
        return RadioStatus::ErrNotFound;
    }
    const uint8_t packet_len = buf_rx[2];
    const uint8_t start = buf_rx[3];

    // Nothing useful, or too big for the caller's box: throw it away.
    if (packet_len == 0 || packet_len > max_len) {
        if (!clear_irq(kPacketFlags)) {
            return RadioStatus::ErrNotFound;
        }
        return packet_len == 0 ? RadioStatus::NoData : RadioStatus::ErrTooLong;
    }

    // 3. Read the packet. We send the opcode, the start position and one
    // NOP, then one dummy byte for each packet byte we want back. Reply
    // bytes: junk, status, status, then the packet.
    uint8_t read_tx[kMaxExchange] = {kOpReadBuffer, start, 0};
    uint8_t read_rx[kMaxExchange];
    const uint16_t total = static_cast<uint16_t>(3 + packet_len);
    if (!command(read_tx, read_rx, total)) {
        return RadioStatus::ErrNotFound;
    }
    memcpy(buf, read_rx + 3, packet_len);
    len = packet_len;

    // 4. Tell the chip we have taken the packet (this turns DIO1 off).
    if (!clear_irq(kPacketFlags)) {
        return RadioStatus::ErrNotFound;
    }
    return RadioStatus::Ok;
}

}  // namespace radio_link
