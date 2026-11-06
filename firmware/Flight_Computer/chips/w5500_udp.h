#ifndef STAR_W5500_UDP_H
#define STAR_W5500_UDP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* W5500 datasheet v1.1.0: VDM SPI, socket 0, 2 KiB TX/RX rings.
 * Single owner. Each register/buffer callback must respect the owner's
 * absolute deadline. No allocation, HAL calls, or unbounded polling. */
typedef struct {
    bool (*io)(void* ctx, uint16_t address, uint8_t block, bool write,
               uint8_t* bytes, uint16_t length);
    void* ctx;
} w5500_bus_t;

typedef struct {
    uint8_t mac[6], ip[4], subnet[4], gateway[4];
    uint16_t port;
} w5500_net_t;

typedef struct {
    w5500_bus_t bus;
    bool sending;
} w5500_udp_t;

enum { W5500_MAX_DATAGRAM = 512 };
/* 1: success, 0: not ready/busy/empty, -1: bus/chip error. On error the
 * owner closes/reopens the interface before using it again. */
int w5500_udp_open(w5500_udp_t* dev, w5500_bus_t bus, const w5500_net_t* net);
int w5500_udp_link(w5500_udp_t* dev);
int w5500_udp_send(w5500_udp_t* dev, const uint8_t ip[4], uint16_t port,
                   const uint8_t* data, size_t length);
int w5500_udp_sent(w5500_udp_t* dev);
/* Oversize datagrams are consumed and return 0; never deliver truncation. */
int w5500_udp_receive(w5500_udp_t* dev, uint8_t ip[4], uint16_t* port,
                      uint8_t* data, size_t capacity, size_t* length);
#endif
