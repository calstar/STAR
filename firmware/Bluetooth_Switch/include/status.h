#pragma once

#include <stdint.h>

// What the continuity/sense divider on VOUT says.
enum class Sense : uint8_t {
    Unknown = 0,
    LoadPresent = 1,  // output off, something low-impedance across VOUT-GND
    Open = 2,         // output off, nothing connected
    Live = 3,         // VOUT is at supply (output on, or back-fed)
};

enum StatusFlags : uint8_t {
    FLAG_INA_OK = 1 << 0,       // INA260 answered with the right IDs at boot
    FLAG_READING_VALID = 1 << 1,  // supply/current fields are from the last conversion
    FLAG_RESTORED = 1 << 2,     // output was re-applied after a non-power-on reset
    FLAG_NO_BATTERY = 1 << 3,   // J1-3 below BATTERY_PRESENT_MIN_MV (main.cpp)
};

// Status characteristic payload, little-endian, 17 bytes (fits the default
// 20-byte ATT payload). Bump STATUS_VERSION whenever the layout changes.
constexpr uint8_t STATUS_VERSION = 1;

struct __attribute__((packed)) StatusPacket {
    uint8_t version;
    uint8_t output;       // 0 = off, 1 = on
    uint8_t sense;        // Sense
    uint8_t flags;        // StatusFlags
    uint16_t supply_mV;   // INA260 bus voltage (J1-3)
    int16_t current_mA;   // INA260 current from the supply input
    uint16_t power_mW;
    uint16_t sense_mV;    // raw CONT_ADC reading
    uint32_t uptime_s;
    uint8_t reset_reason; // esp_reset_reason_t of the last boot
};
static_assert(sizeof(StatusPacket) == 17, "status packet layout changed");
