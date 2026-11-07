#include "w5500_udp.h"

#include <string.h>

enum { COMMON = 0, SOCK = 1, TX = 2, RX = 3, RING = 2048 };

static bool io(w5500_udp_t* d, uint16_t a, uint8_t b, bool w, void* p,
               uint16_t n) {
    return d->bus.io(d->bus.ctx, a, b, w, p, n);
}
static bool put8(w5500_udp_t* d, uint16_t a, uint8_t b, uint8_t v) {
    return io(d, a, b, true, &v, 1);
}
static bool get16(w5500_udp_t* d, uint16_t a, uint16_t* v) {
    uint8_t p[2];
    if (!io(d, a, SOCK, false, p, 2))
        return false;
    *v = (uint16_t)((uint16_t)p[0] << 8 | p[1]);
    return true;
}
static bool put16(w5500_udp_t* d, uint16_t a, uint16_t v) {
    uint8_t p[2] = {(uint8_t)(v >> 8), (uint8_t)v};
    return io(d, a, SOCK, true, p, 2);
}
/* Counters can change between bytes: WIZnet requires two equal reads. */
static bool stable16(w5500_udp_t* d, uint16_t a, uint16_t* v) {
    uint16_t prev;
    if (!get16(d, a, &prev))
        return false;
    for (unsigned i = 0; i < 8; ++i) {
        if (!get16(d, a, v))
            return false;
        if (prev == *v)
            return true;
        prev = *v;
    }
    return false;
}
static bool command(w5500_udp_t* d, uint8_t cmd) {
    if (!put8(d, 1, SOCK, cmd))
        return false;
    for (unsigned i = 0; i < 8; ++i) {
        uint8_t cr;
        if (!io(d, 1, SOCK, false, &cr, 1))
            return false;
        if (!cr)
            return true;
    }
    return false;
}
static bool ring(w5500_udp_t* d, uint8_t block, uint16_t pos, bool write,
                 uint8_t* p, uint16_t n) {
    pos %= RING;
    uint16_t first = n < RING - pos ? n : (uint16_t)(RING - pos);
    return io(d, pos, block, write, p, first) &&
           (first == n || io(d, 0, block, write, p + first, n - first));
}

int w5500_udp_open(w5500_udp_t* d, w5500_bus_t bus, const w5500_net_t* net) {
    if (!d || !bus.io || !net || !net->port)
        return -1;
    *d = (w5500_udp_t){.bus = bus};
    uint8_t version, status;
    if (!io(d, 0x39, COMMON, false, &version, 1) || version != 4 ||
        !command(d, 0x10))
        return -1; /* CLOSE */
    /* Bring-up has already released ETH_RST. Own socket 0 only; retain the
     * reset-default 2 KiB allocation for the other sockets. */
    if (!io(d, 1, COMMON, true, (void*)net->gateway, 4) ||
        !io(d, 5, COMMON, true, (void*)net->subnet, 4) ||
        !io(d, 9, COMMON, true, (void*)net->mac, 6) ||
        !io(d, 15, COMMON, true, (void*)net->ip, 4) ||
        !put8(d, 0x1e, SOCK, 2) || !put8(d, 0x1f, SOCK, 2) ||
        !put8(d, 0, SOCK, 2) || !put16(d, 4, net->port) ||
        !put8(d, 2, SOCK, 0xff) || !command(d, 1) ||
        !io(d, 3, SOCK, false, &status, 1) || status != 0x22)
        return -1;
    return 1;
}

int w5500_udp_link(w5500_udp_t* d) {
    uint8_t phy;
    return io(d, 0x2e, COMMON, false, &phy, 1) ? (phy & 1) : -1;
}

int w5500_udp_send(w5500_udp_t* d, const uint8_t ip[4], uint16_t port,
                   const uint8_t* data, size_t n) {
    if (!data || !ip || !port || !n || n > W5500_MAX_DATAGRAM)
        return -1;
    if (d->sending)
        return 0;
    uint16_t free_bytes, wr;
    if (!stable16(d, 0x20, &free_bytes))
        return -1;
    if (free_bytes < n)
        return 0;
    if (!get16(d, 0x24, &wr) || !io(d, 0x0c, SOCK, true, (void*)ip, 4) ||
        !put16(d, 0x10, port) ||
        !ring(d, TX, wr, true, (uint8_t*)data, (uint16_t)n) ||
        !put16(d, 0x24, (uint16_t)(wr + n)) || !put8(d, 2, SOCK, 0x18) ||
        !command(d, 0x20))
        return -1;
    d->sending = true;
    return 1;
}

int w5500_udp_sent(w5500_udp_t* d) {
    if (!d->sending)
        return 1;
    uint8_t ir;
    if (!io(d, 2, SOCK, false, &ir, 1))
        return -1;
    if (!(ir & 0x18))
        return 0;
    if (!put8(d, 2, SOCK, ir & 0x18))
        return -1;
    d->sending = false;
    return ir & 8 ? -1 : 1; /* TIMEOUT wins over SEND_OK */
}

int w5500_udp_receive(w5500_udp_t* d, uint8_t ip[4], uint16_t* port,
                      uint8_t* data, size_t capacity, size_t* length) {
    if (!ip || !port || !data || !length)
        return -1;
    *length = 0;
    uint16_t available, rd;
    uint8_t hdr[8];
    if (!stable16(d, 0x26, &available))
        return -1;
    if (!available)
        return 0;
    if (available < 8 || available > RING || !get16(d, 0x28, &rd) ||
        !ring(d, RX, rd, false, hdr, 8))
        return -1;
    uint16_t n = (uint16_t)((uint16_t)hdr[6] << 8 | hdr[7]);
    if (n > available - 8)
        return -1;
    bool fits = n <= capacity && n <= W5500_MAX_DATAGRAM;
    if (fits && n && !ring(d, RX, (uint16_t)(rd + 8), false, data, n))
        return -1;
    if (!put16(d, 0x28, (uint16_t)(rd + 8 + n)) || !command(d, 0x40))
        return -1;
    if (!fits)
        return 0;
    memcpy(ip, hdr, 4);
    *port = (uint16_t)((uint16_t)hdr[4] << 8 | hdr[5]);
    *length = n;
    return 1;
}
