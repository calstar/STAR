// Stub: Ethernet.h — for native tests
// Provides EthernetServer/Client/UDP stubs for hotfire_ota.h
#pragma once
#include <cstdint>
#include <cstring>

class EthernetClient {
public:
    operator bool() { return false; }
    int available() { return 0; }
    int read() { return -1; }
    int read(uint8_t*, int) { return 0; }
    void stop() {}
    void flush() {}
    void println(const char*) {}
};

class EthernetServer {
public:
    EthernetServer(uint16_t) {}
    virtual void begin() {}
    EthernetClient available() { return EthernetClient(); }
};
