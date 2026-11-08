#pragma once

// AS5600 magnetic encoder, I2C 0x36. Ported from firmware/Encoder_Board.
// Read-only on purpose: never writes ZPOS/MPOS/CONF or BURN, which is
// permanent and limited to 3 times. Calibration lives in NVS instead.

#include <Arduino.h>
#include <Wire.h>

struct As5600Reading {
    bool i2c_ok = false;
    uint8_t status = 0;  // MD/ML/MH bits of STATUS
    uint16_t raw_angle = 0;

    bool magnetDetected() const;
    bool magnetTooWeak() const;
    bool magnetTooStrong() const;
    bool usable() const;
};

class As5600 {
public:
    static constexpr uint8_t ADDR = 0x36;

    explicit As5600(TwoWire& bus) : bus_(bus) {
    }

    bool begin(int sda, int scl, uint32_t clock_hz);
    bool ping();
    As5600Reading read();
    void dumpDiagnostics(Print& out);

private:
    bool readBytes(uint8_t reg, uint8_t* buf, uint8_t len);
    TwoWire& bus_;
};
