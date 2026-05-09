// Stub: firmware_hash.h — for native tests
#pragma once
namespace FirmwareHash {
    inline const uint8_t* get() { static uint8_t h[32] = {}; return h; }
    inline void print() {}
}
