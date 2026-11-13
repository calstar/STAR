#pragma once

// Half-duplex RS-485 through a MAX3485 with separate DE and /RE.
//   listen (default): DE LOW,  /RE LOW
//   transmit:         DE HIGH, /RE HIGH (so we don't read our own echo)

#include <Arduino.h>

#include "valve_protocol.h"

class Rs485Link {
public:
    Rs485Link(int uart_num, int tx_pin, int rx_pin, int de_pin, int re_n_pin);

    // Call first in setup() so nothing can drive the bus during startup.
    void beginPinsSafe();
    void begin(uint32_t baud);

    // Blocks until the last bit is on the wire (~1.4 ms for 16 bytes at 115200).
    void send(const uint8_t* data, size_t len);

    // True when a CRC-checked frame is ready in frame().
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
