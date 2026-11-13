#include "sx1262.h"

#include <string.h>

namespace radio_link {
namespace {

// Flags we clear once we have dealt with a packet (good or bad).
constexpr uint16_t kPacketFlags = kIrqRxDone | kIrqHeaderErr | kIrqCrcErr;

// The status byte the chip returns in byte 1 of every "get" reply
// (datasheet Rev 1.2, Table 13-76, page 95): bits 6:4 are the chip mode
// (2 STBY_RC .. 6 TX), bits 3:1 the command status (3 timeout, 4 processing
// error, 5 failure to execute). A missing chip or a stuck MISO line reads
// 0x00 or 0xFF, which decode as modes 0 and 7 and are rejected here.
bool status_ok(uint8_t status) {
    const uint8_t mode = (status >> 4) & 0x07;
    const uint8_t result = (status >> 1) & 0x07;
    if (mode < 0x2 || mode > 0x6) {
        return false;
    }
    return result != 0x3 && result != 0x4 && result != 0x5;
}

}  // namespace

bool sx1262_status_ok(uint8_t status) {
    return status_ok(status);
}

bool Sx1262::command(const uint8_t* tx, uint8_t* rx, uint16_t n) {
    if (!bus_.wait_busy()) {
        return false;
    }
    bus_.transfer(tx, rx, n);
    return true;
}

bool Sx1262::start_rx_continuous() {
    const uint8_t tx[4] = {kOpSetRx, 0xFF, 0xFF, 0xFF};
    uint8_t rx[4];
    return command(tx, rx, sizeof tx);
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
    if (!command(irq_tx, irq_rx, sizeof irq_tx) || !status_ok(irq_rx[1])) {
        return RadioStatus::ErrNotFound;
    }
    const uint16_t irq = static_cast<uint16_t>((irq_rx[2] << 8) | irq_rx[3]);

    // A packet the radio itself flagged as damaged: throw it away.
    if ((irq & (kIrqHeaderErr | kIrqCrcErr)) != 0) {
        crc_errors_++;
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
    if (!command(buf_tx, buf_rx, sizeof buf_tx) || !status_ok(buf_rx[1])) {
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
    const uint16_t total = static_cast<uint16_t>(3 + packet_len);
    read_tx_[0] = kOpReadBuffer;
    read_tx_[1] = start;
    memset(read_tx_ + 2, 0, total - 2);  // NOP, then one dummy byte each
    if (!command(read_tx_, read_rx_, total) || !status_ok(read_rx_[1])) {
        return RadioStatus::ErrNotFound;
    }
    memcpy(buf, read_rx_ + 3, packet_len);
    len = packet_len;

    // 4. Tell the chip we have taken the packet (this turns DIO1 off).
    if (!clear_irq(kPacketFlags)) {
        return RadioStatus::ErrNotFound;
    }
    return RadioStatus::Ok;
}

bool Sx1262::packet_status(PacketStatus& out) {
    // Reply bytes: junk, status, RssiPkt, SnrPkt, SignalRssiPkt.
    const uint8_t tx[5] = {kOpGetPacketStatus, 0, 0, 0, 0};
    uint8_t rx[5];
    if (!command(tx, rx, sizeof tx) || !status_ok(rx[1])) {
        return false;
    }
    out.rssi_x2 = static_cast<int16_t>(-static_cast<int16_t>(rx[2]));
    out.snr_x4 = static_cast<int8_t>(rx[3]);  // two's complement
    out.signal_rssi_x2 = static_cast<int16_t>(-static_cast<int16_t>(rx[4]));
    return true;
}

}  // namespace radio_link
