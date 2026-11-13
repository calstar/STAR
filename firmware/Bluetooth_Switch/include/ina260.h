#pragma once

#include <Arduino.h>
#include <Wire.h>

// TI INA260 on the supply input (J1-3 -> shunt -> +9V). Measures the supply
// voltage and total current: switched load plus the board's own draw when not
// on USB. Run in triggered mode so it sits idle between readings.
class INA260 {
public:
    struct Reading {
        uint16_t bus_mV;
        int32_t current_mA;
        uint32_t power_mW;
    };

    bool begin(TwoWire &wire, uint8_t addr);
    bool read(Reading &out);  // one triggered conversion, ~40 ms
    void shutdown();

private:
    bool write16(uint8_t reg, uint16_t val);
    bool read16(uint8_t reg, uint16_t &val);

    TwoWire *wire_ = nullptr;
    uint8_t addr_ = 0;
};
