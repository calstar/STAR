#ifndef SX1262_H
#define SX1262_H

#include <stdint.h>

#include "radio.h"

namespace radio_link {

// How the driver talks to the radio chip. The rocket gets a real version
// (SPI plus the BUSY pin). Tests get a pretend chip.
class SpiBus {
public:
    // Wait until the chip's BUSY pin is low. Returns false if it never is.
    virtual bool wait_busy() = 0;

    // One SPI exchange: pull NSS low, send `len` bytes from `tx` while
    // receiving `len` bytes into `rx`, then raise NSS. Both arrays must hold
    // at least `len` bytes.
    virtual void transfer(const uint8_t* tx, uint8_t* rx, uint16_t len) = 0;

protected:
    ~SpiBus() {
    }
};

// SX1262 command numbers (datasheet Rev 1.2, section 11, pages 62-64).
constexpr uint8_t kOpClearIrqStatus = 0x02;
constexpr uint8_t kOpGetIrqStatus = 0x12;
constexpr uint8_t kOpGetRxBufferStatus = 0x13;
constexpr uint8_t kOpGetPacketStatus = 0x14;
constexpr uint8_t kOpReadBuffer = 0x1E;
constexpr uint8_t kOpSetRx = 0x82;

// Event flags in the chip's IRQ register (datasheet Rev 1.2, table 13-29,
// page 80).
constexpr uint16_t kIrqRxDone = 1u << 1;     // a packet was received
constexpr uint16_t kIrqHeaderErr = 1u << 5;  // LoRa header failed its check
constexpr uint16_t kIrqCrcErr = 1u << 6;     // the radio's own CRC was wrong

// True when a reply's status byte is one a working chip sends (Table 13-76,
// p.95); 0x00/0xFF (no chip, stuck MISO) and error statuses are false.
bool sx1262_status_ok(uint8_t status);

// Signal quality of the last LoRa packet, from GetPacketStatus (opcode 0x14,
// datasheet Rev 1.2, Tables 13-79 and 13-80, page 96). Kept in the chip's own
// units so nothing is rounded: RSSI in half-dB steps, SNR in quarter-dB steps.
struct PacketStatus {
    int16_t rssi_x2;         // average RSSI over the packet, dBm x 2
    int8_t snr_x4;           // SNR, dB x 4 (negative below the noise floor)
    int16_t signal_rssi_x2;  // RSSI of the LoRa signal after despreading
};

// Receives packets from an SX1262 over a SpiBus.
//
// The chip must be listening in continuous RX for receive() to see packets:
// in single RX it returns to standby after the first packet and nothing here
// would re-arm it. Call start_rx_continuous() once start-up is done and again
// after every transmission (a send leaves the chip in standby).
class Sx1262 {
public:
    explicit Sx1262(SpiBus& bus) : bus_(bus) {
    }

    // SetRx (opcode 0x82, datasheet Rev 1.2 page 62) with timeout 0xFFFFFF:
    // continuous RX, the chip stays listening until told otherwise (page 70).
    // Returns false if the chip never left BUSY.
    bool start_rx_continuous();

    // Same promise as radio_receive() in radio.h. ErrNotFound means the chip
    // did not answer: BUSY never went low, or a reply's status byte is not
    // one a working chip can send (a missing chip reads 0x00 or 0xFF).
    RadioStatus receive(uint8_t* buf, uint8_t max_len, uint8_t& len);

    // Packets the radio received but rejected (LoRa header or CRC error).
    // receive() reports them as NoData; this count makes a bad antenna or
    // too much range visible in telemetry. Needs LoRa CRC on at start-up.
    // Signal quality of the packet receive() just returned (call it right
    // after an Ok, before the next packet arrives). False if the chip did
    // not answer; `out` is then left alone.
    bool packet_status(PacketStatus& out);
    uint32_t crc_errors() const {
        return crc_errors_;
    }

private:
    // Wait for BUSY to go low, then do one SPI exchange.
    bool command(const uint8_t* tx, uint8_t* rx, uint16_t n);

    // Reset the flags in `mask` in the chip's IRQ register.
    bool clear_irq(uint16_t mask);

    // Biggest SPI exchange: ReadBuffer = opcode + offset + NOP + up to 255
    // packet bytes. Kept here, not on the caller's stack (~0.5 KB).
    static constexpr unsigned kMaxExchange = 3 + 255;

    SpiBus& bus_;
    uint32_t crc_errors_ = 0;
    uint8_t read_tx_[kMaxExchange];
    uint8_t read_rx_[kMaxExchange];
};

}  // namespace radio_link

#endif  // SX1262_H
