// Stub: Update.h — for native tests
// Provides minimal Update global used by hotfire_ota.h
#pragma once
#include <cstdint>
#include <cstddef>

struct UpdateClass {
    bool begin(size_t) { return true; }
    size_t write(uint8_t*, int) { return 0; }
    bool end(bool) { return true; }
    void abort() {}
    template<typename T> void printError(T&) {}
};
static UpdateClass Update;
