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

// SX1262 command numbers (datasheet section 11, pages 62-64).
constexpr uint8_t kOpClearIrqStatus = 0x02;
constexpr uint8_t kOpGetIrqStatus = 0x12;
constexpr uint8_t kOpGetRxBufferStatus = 0x13;
constexpr uint8_t kOpReadBuffer = 0x1E;

// Event flags in the chip's IRQ register (datasheet table 13-29, page 80).
constexpr uint16_t kIrqRxDone = 1u << 1;     // a packet was received
constexpr uint16_t kIrqHeaderErr = 1u << 5;  // LoRa header failed its check
constexpr uint16_t kIrqCrcErr = 1u << 6;     // the radio's own CRC was wrong

// Receives packets from an SX1262 over a SpiBus.
class Sx1262 {
public:
    explicit Sx1262(SpiBus& bus) : bus_(bus) {
    }

    // Same promise as radio_receive() in radio.h. ErrNotFound means the chip
    // did not answer: BUSY never went low, or a reply's status byte is not
    // one a working chip can send (a missing chip reads 0x00 or 0xFF).
    RadioStatus receive(uint8_t* buf, uint8_t max_len, uint8_t& len);

private:
    // Wait for BUSY to go low, then do one SPI exchange.
    bool command(const uint8_t* tx, uint8_t* rx, uint16_t n);

    // Reset the flags in `mask` in the chip's IRQ register.
    bool clear_irq(uint16_t mask);

    SpiBus& bus_;
};

}  // namespace radio_link

#endif  // SX1262_H
