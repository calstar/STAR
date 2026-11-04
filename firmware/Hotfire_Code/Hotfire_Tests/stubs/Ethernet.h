// Stub: Ethernet.h — for native tests
// Provides EthernetServer/Client/UDP stubs, plus enough of EthernetClass for
// board_net.h: DHCP can be made to succeed or fail, and every address write is
// recorded so a test can assert what the board pushed into the W5500.
#pragma once
#include <Arduino.h>  // IPAddress

#include <cstdint>
#include <cstring>

class EthernetClient {
public:
    operator bool() {
        return false;
    }
    int available() {
        return 0;
    }
    int read() {
        return -1;
    }
    int read(uint8_t*, int) {
        return 0;
    }
    void stop() {
    }
    void flush() {
    }
    void println(const char*) {
    }
};

class EthernetServer {
public:
    EthernetServer(uint16_t) {
    }
    virtual void begin() {
    }
    EthernetClient available() {
        return EthernetClient();
    }
};

// Records what board_net.h writes into the chip, so tests can inspect it.
class EthernetClass {
public:
    IPAddress local_ip;
    IPAddress subnet_mask;
    int set_local_ip_calls = 0;
    int set_subnet_calls = 0;

    // --- DHCP, scripted by the test ---
    bool dhcp_should_succeed = false;
    IPAddress dhcp_assigned;
    int maintain_calls = 0;
    // --- static configuration, recorded so a test can prove it did or did
    //     not happen ---
    int static_begin_calls = 0;
    IPAddress static_ip;
    IPAddress static_subnet;
    // --- W5500 send retries. Like the real chip, every begin() puts them
    //     back to the defaults (200 ms x 8). ---
    uint16_t retry_timeout_ms = 200;
    uint8_t retry_count = 8;

    /** DHCP form: returns 1 on success, 0 on failure, like Ethernet 2.x. */
    int begin(uint8_t*, unsigned long, unsigned long) {
        resetRetries();
        if (!dhcp_should_succeed)
            return 0;
        local_ip = dhcp_assigned;
        return 1;
    }
    /** Static form. */
    void begin(uint8_t*, IPAddress ip, IPAddress, IPAddress, IPAddress mask) {
        resetRetries();
        static_begin_calls++;
        static_ip = ip;
        static_subnet = mask;
        local_ip = ip;
        subnet_mask = mask;
    }

    void setLocalIP(const IPAddress ip) {
        local_ip = ip;
        set_local_ip_calls++;
    }
    void setSubnetMask(const IPAddress mask) {
        subnet_mask = mask;
        set_subnet_calls++;
    }
    IPAddress localIP() const {
        return local_ip;
    }
    IPAddress subnetMask() const {
        return subnet_mask;
    }
    void setRetransmissionTimeout(uint16_t ms) {
        retry_timeout_ms = ms;
    }
    void setRetransmissionCount(uint8_t n) {
        retry_count = n;
    }
    void resetRetries() {
        retry_timeout_ms = 200;
        retry_count = 8;
    }
    int maintain() {
        maintain_calls++;
        return 0;
    }
    void reset() {
        local_ip = IPAddress();
        subnet_mask = IPAddress();
        set_local_ip_calls = 0;
        set_subnet_calls = 0;
        dhcp_should_succeed = false;
        dhcp_assigned = IPAddress();
        maintain_calls = 0;
        static_begin_calls = 0;
        static_ip = IPAddress();
        static_subnet = IPAddress();
        resetRetries();
    }
};

static EthernetClass Ethernet;
