#pragma once

// AS5600 12-bit magnetic rotary encoder over I2C (address 0x36).
// Ported from firmware/Encoder_Board/src/main.cpp, wrapped so the bus and
// pins come from the pin header instead of being hard-coded.
//
// Read-only on purpose: this driver never writes the ZPOS/MPOS/CONF
// registers or BURN (0xFF). Burning is permanent and the chip only allows
// it a few times; calibration lives in our firmware instead.

#include <Arduino.h>
#include <Wire.h>

struct As5600Reading {
    bool i2c_ok = false;     // chip answered
    uint8_t status = 0;      // STATUS register (0x0B), bits MD/ML/MH
    uint16_t raw_angle = 0;  // 0..4095

    bool magnetDetected() const;
    bool magnetTooWeak() const;
    bool magnetTooStrong() const;
    // Usable for valve position: chip answered, magnet present, field OK.
    bool usable() const;
};

class As5600 {
public:
    static constexpr uint8_t ADDR = 0x36;

    explicit As5600(TwoWire& bus) : bus_(bus) {
    }

    bool begin(int sda, int scl, uint32_t clock_hz);
    bool ping();
    // One I2C transaction: STATUS (0x0B) + RAW ANGLE (0x0C-0x0D).
    As5600Reading read();
    void dumpDiagnostics(Print& out);

private:
    bool readBytes(uint8_t reg, uint8_t* buf, uint8_t len);
    TwoWire& bus_;
};
