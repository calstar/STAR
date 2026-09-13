/**
 * Minimal Arduino.h stub for native unit tests.
 * Provides just enough to compile DAQv2-Comms, SensorHotfireCore,
 * firmware_hash.h, and hotfire_ota.h off-target.
 */
#pragma once

#include <algorithm>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

// Standard Arduino types
typedef uint8_t byte;

// Arduino constants
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define LED_BUILTIN 2
#define HEX 16
#define DEC 10

// Stub millis() / micros()
static unsigned long _stub_millis_value = 0;
inline unsigned long millis() {
    return _stub_millis_value;
}
inline void stub_set_millis(unsigned long v) {
    _stub_millis_value = v;
}

static unsigned long _stub_micros_value = 0;
inline unsigned long micros() {
    return _stub_micros_value;
}

// Arduino min/max macros
#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) > (b) ? (a) : (b))

// GPIO stubs
inline void pinMode(int, int) {
}
inline void digitalWrite(int, int) {
}
inline int digitalRead(int) {
    return LOW;
}
inline int analogRead(int) {
    return 0;
}
inline void delay(unsigned long) {
}
inline void delayMicroseconds(unsigned int) {
}

// Minimal IPAddress stub (real Arduino gets this from IPAddress.h via
// Ethernet.h). Declared before SerialStub so Serial.print(ip) can exist.
class IPAddress {
public:
    IPAddress() : _o{0, 0, 0, 0} {
    }
    IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) : _o{a, b, c, d} {
    }
    uint8_t operator[](int i) const {
        return _o[i];
    }
    uint8_t& operator[](int i) {
        return _o[i];
    }
    bool operator==(const IPAddress& o) const {
        return memcmp(_o, o._o, 4) == 0;
    }
    bool operator!=(const IPAddress& o) const {
        return !(*this == o);
    }
    operator uint32_t() const {
        return (uint32_t)_o[0] << 24 | (uint32_t)_o[1] << 16 |
               (uint32_t)_o[2] << 8 | (uint32_t)_o[3];
    }

private:
    uint8_t _o[4];
};

// Minimal Serial stub with printf support
#include <cstdio>
struct SerialStub {
    void print(const IPAddress&) {
    }
    void println(const IPAddress&) {
    }
    void begin(unsigned long) {
    }
    void print(const char*) {
    }
    void print(int) {
    }
    void print(unsigned int) {
    }
    void print(unsigned long) {
    }
    void print(float) {
    }
    void print(int, int) {
    }
    void print(uint8_t v, int base) {
    }  // For firmware_hash.h
    void println(const char* s = "") {
    }
    void println(int) {
    }
    void println(unsigned int) {
    }
    void println(unsigned long) {
    }
    void println(float) {
    }
    void flush() {
    }
    void printf(const char* fmt, ...) {
    }  // For hotfire_ota.h
};
static SerialStub Serial;

// SPI constants
#define SPI_MODE1 1
#define HSPI 2

// ESP class stub (for ESP.restart())
struct ESPClassStub {
    void restart() {
    }
};
static ESPClassStub ESP;
