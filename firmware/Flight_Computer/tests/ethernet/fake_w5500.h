#ifndef TEST_FAKE_W5500_H
#define TEST_FAKE_W5500_H
typedef struct {
    uint8_t common[64], socket[64], tx[2048], rx[2048];
    unsigned calls, fail_at;
    bool stuck_command, unstable;
    uint16_t committed_rd;
} fake_t;
static void be16(uint8_t* p, unsigned v) {
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}
static unsigned read16(const uint8_t* p) {
    return ((unsigned)p[0] << 8) | p[1];
}
static bool io(void* ctx, uint16_t a, uint8_t block, bool write, uint8_t* bytes,
               uint16_t n) {
    fake_t* f = ctx;
    if (++f->calls == f->fail_at)
        return false;
    CHECK(block < 4);
    uint8_t* mem = block == 0   ? f->common
                   : block == 1 ? f->socket
                   : block == 2 ? f->tx
                                : f->rx;
    CHECK((unsigned)a + n <= (block < 2 ? 64U : 2048U));
    if (!write) {
        if (block == 1 && a == 0x20 && f->unstable)
            be16(mem + a, f->calls);
        memcpy(bytes, mem + a, n);
        return true;
    }
    if (block == 1 && a == 2) {
        f->socket[2] &= (uint8_t)~bytes[0];
        return true;
    }
    memcpy(mem + a, bytes, n);
    if (block == 1 && a == 1 && !f->stuck_command) {
        switch (bytes[0]) {
            case 1:
                f->socket[3] = 0x22;
                break;
            case 0x10:
                f->socket[3] = 0;
                break;
            case 0x40: {
                uint16_t rd = (uint16_t)read16(f->socket + 0x28);
                unsigned used = (uint16_t)(rd - f->committed_rd);
                CHECK(used <= read16(f->socket + 0x26));
                be16(f->socket + 0x26, read16(f->socket + 0x26) - used);
                f->committed_rd = rd;
                break;
            }
            case 0x20:
                break;
            default:
                CHECK(false);
        }
        f->socket[1] = 0;
    }
    return true;
}
static w5500_net_t net = {.mac = {2, 1, 2, 3, 4, 5},
                          .ip = {192, 0, 2, 10},
                          .subnet = {255, 255, 255, 0},
                          .gateway = {192, 0, 2, 1},
                          .port = 5005};
static void init(fake_t* f, w5500_udp_t* d) {
    memset(f, 0, sizeof(*f));
    f->common[0x39] = 4;
    f->common[0x2e] = 1;
    be16(f->socket + 0x20, 2048);
    CHECK(w5500_udp_open(d, (w5500_bus_t){io, f}, &net) == 1);
}
static void datagram(fake_t* f, uint16_t pos, const uint8_t* data, unsigned n) {
    uint8_t hdr[8] = {192, 0, 2, 20, 0x13, 0x8e, 0, 0};
    be16(hdr + 6, n);
    for (unsigned i = 0; i < 8; ++i)
        f->rx[(pos + i) % 2048] = hdr[i];
    for (unsigned i = 0; i < n; ++i)
        f->rx[(pos + 8 + i) % 2048] = data[i];
    be16(f->socket + 0x28, pos);
    be16(f->socket + 0x26, n + 8);
    f->committed_rd = pos;
}

#endif
