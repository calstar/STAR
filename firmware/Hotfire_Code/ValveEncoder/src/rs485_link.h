#pragma once

// Half-duplex RS-485 through a MAX3485 with separate DE and /RE lines.
//
// The MAX3485 can either talk or listen on the two wires, not both:
//   listening (default):  DE = LOW,  /RE = LOW
//   transmitting:         DE = HIGH, /RE = HIGH (receiver off, so we don't
//                                                read back our own bytes)
// send() flips to transmit, writes the bytes, waits until the LAST bit has
// physically left the UART (not just the buffer), then flips back. Dropping
// DE too early chops the end of the frame; leaving it high blocks everyone
// else on the bus.

#include <Arduino.h>

#include "valve_protocol.h"

class Rs485Link {
public:
    Rs485Link(int uart_num, int tx_pin, int rx_pin, int de_pin, int re_n_pin);

    // Call FIRST in setup(): puts the transceiver in listen mode before
    // anything else can toggle the pins.
    void beginPinsSafe();
    void begin(uint32_t baud);

    // Sends raw bytes as one burst. Blocks for the time on the wire
    // (16 bytes at 115200 baud ~= 1.4 ms).
    void send(const uint8_t* data, size_t len);

    // Reads whatever has arrived and feeds the parser. Returns true when a
    // complete, CRC-checked frame is ready in frame().
    bool poll();
    const valve_proto::Frame& frame() const {
        return parser_.frame();
    }

    uint32_t framesSent() const {
        return frames_sent_;
    }
    uint32_t goodFramesIn() const {
        return parser_.goodFrames();
    }
    uint32_t badFramesIn() const {
        return parser_.badFrames();
    }

private:
    void listenMode();
    void transmitMode();

    HardwareSerial serial_;
    int tx_pin_, rx_pin_, de_pin_, re_n_pin_;
    valve_proto::Parser parser_;
    uint32_t frames_sent_ = 0;
};
