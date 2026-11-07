#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "w5500_udp.h"
#define CHECK(x)                                            \
    do {                                                    \
        if (!(x)) {                                         \
            fprintf(stderr, "line %d: %s\n", __LINE__, #x); \
            abort();                                        \
        }                                                   \
    } while (0)
#include "fake_w5500.h"
int main(void) {
    fake_t f;
    w5500_udp_t d;
    init(&f, &d);
    CHECK(memcmp(f.common + 9, net.mac, 6) == 0);
    CHECK(memcmp(f.common + 15, net.ip, 4) == 0);
    CHECK(memcmp(f.common + 5, net.subnet, 4) == 0);
    CHECK(memcmp(f.common + 1, net.gateway, 4) == 0);
    CHECK(read16(f.socket + 4) == 5005 && f.socket[0] == 2);
    CHECK(w5500_udp_link(&d) == 1);
    f.common[0x2e] = 0;
    CHECK(w5500_udp_link(&d) == 0);
    uint8_t data[512];
    for (unsigned i = 0; i < sizeof(data); ++i)
        data[i] = (uint8_t)i;
    uint8_t ip[4] = {192, 0, 2, 20};
    be16(f.socket + 0x24, 65530);
    CHECK(w5500_udp_send(&d, ip, 5006, data, sizeof(data)) == 1);
    CHECK(read16(f.socket + 0x24) == 506);
    CHECK(memcmp(f.tx + 2042, data, 6) == 0 &&
          memcmp(f.tx, data + 6, 506) == 0);
    CHECK(read16(f.socket + 0x10) == 5006 &&
          memcmp(f.socket + 0x0c, ip, 4) == 0);
    CHECK(w5500_udp_send(&d, ip, 5006, data, 1) == 0);
    CHECK(w5500_udp_sent(&d) == 0);
    f.socket[2] = 0x10;
    CHECK(w5500_udp_sent(&d) == 1 && !d.sending && f.socket[2] == 0);
    CHECK(w5500_udp_send(&d, ip, 5006, data, 1) == 1);
    f.socket[2] = 0x18;
    CHECK(w5500_udp_sent(&d) == -1);
    CHECK(w5500_udp_send(&d, ip, 5006, data, 513) == -1);
    be16(f.socket + 0x20, 0);
    CHECK(w5500_udp_send(&d, ip, 5006, data, 1) == 0);
    f.unstable = true;
    unsigned before = f.calls;
    CHECK(w5500_udp_send(&d, ip, 5006, data, 1) == -1 && f.calls - before == 9);
    f.unstable = false;
    uint8_t out[512], from[4];
    uint16_t port;
    size_t n;
    datagram(&f, 65532, data, 512);
    CHECK(w5500_udp_receive(&d, from, &port, out, sizeof(out), &n) == 1);
    CHECK(n == 512 && port == 5006 && memcmp(from, ip, 4) == 0 &&
          memcmp(out, data, n) == 0);
    CHECK(read16(f.socket + 0x28) == 516 && read16(f.socket + 0x26) == 0);
    CHECK(w5500_udp_receive(&d, from, &port, out, sizeof(out), &n) == 0 &&
          n == 0);
    datagram(&f, 2040, data, 100);
    CHECK(w5500_udp_receive(&d, from, &port, out, 50, &n) == 0 && n == 0 &&
          read16(f.socket + 0x26) == 0);
    datagram(&f, 0, data, 10);
    f.rx[7] = 100;
    CHECK(w5500_udp_receive(&d, from, &port, out, sizeof(out), &n) == -1);
    /* Every possible open transaction failure propagates, rather than
       claiming an opened socket. */
    init(&f, &d);
    unsigned calls = f.calls;
    for (unsigned i = 1; i <= calls; ++i) {
        memset(&f, 0, sizeof(f));
        f.common[0x39] = 4;
        f.fail_at = i;
        CHECK(w5500_udp_open(&d, (w5500_bus_t){io, &f}, &net) == -1);
    }
    memset(&f, 0, sizeof(f));
    f.common[0x39] = 4;
    f.stuck_command = true;
    CHECK(w5500_udp_open(&d, (w5500_bus_t){io, &f}, &net) == -1 &&
          f.calls == 10);
    puts("W5500 ring, UDP, bounded polling and bus-failure checks passed");
}
