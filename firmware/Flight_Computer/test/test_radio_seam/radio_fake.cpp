#include "radio_fake.h"

#include <string.h>

namespace radio_link {
namespace {

constexpr unsigned kQueueDepth = 8;   // packets the fake can hold at once
constexpr unsigned kMaxPacket = 255;  // the biggest a uint8_t length can say

struct Packet {
    uint8_t data[kMaxPacket];
    uint8_t len;
};

Packet g_rx[kQueueDepth];
unsigned g_head = 0;  // next packet to hand out
unsigned g_count = 0;
bool g_chip_present = true;
uint8_t g_tx[kMaxPacket];
uint8_t g_tx_len = 0;
unsigned g_tx_count = 0;
RadioStatus g_send_result = RadioStatus::Ok;

}  // namespace

namespace fake {

void reset(bool chip_present) {
    g_head = 0;
    g_count = 0;
    g_chip_present = chip_present;
    g_tx_len = 0;
    g_tx_count = 0;
    g_send_result = RadioStatus::Ok;
}

void set_send_result(RadioStatus result) {
    g_send_result = result;
}

bool inject(const uint8_t* bytes, uint8_t len) {
    if (g_count >= kQueueDepth || len == 0) {
        return false;
    }
    const unsigned slot = (g_head + g_count) % kQueueDepth;
    memcpy(g_rx[slot].data, bytes, len);
    g_rx[slot].len = len;
    g_count++;
    return true;
}

uint8_t last_sent(uint8_t* out, uint8_t out_cap) {
    const uint8_t n = g_tx_len < out_cap ? g_tx_len : out_cap;
    memcpy(out, g_tx, n);
    return n;
}

unsigned sent_count() {
    return g_tx_count;
}

}  // namespace fake

RadioStatus radio_probe() {
    return g_chip_present ? RadioStatus::Ok : RadioStatus::ErrNotFound;
}

RadioStatus radio_send(const uint8_t* bytes, uint8_t len) {
    if (!g_chip_present) {
        return RadioStatus::ErrNotFound;
    }
    if (g_send_result != RadioStatus::Ok) {
        return g_send_result;
    }
    memcpy(g_tx, bytes, len);
    g_tx_len = len;
    g_tx_count++;
    return RadioStatus::Ok;
}

RadioStatus radio_receive(uint8_t* buf, uint8_t max_len, uint8_t& len) {
    if (g_count == 0) {
        return RadioStatus::NoData;
    }
    const unsigned slot = g_head;
    g_head = (g_head + 1) % kQueueDepth;
    g_count--;
    if (g_rx[slot].len > max_len) {
        return RadioStatus::ErrTooLong;  // packet thrown away, as radio.h says
    }
    memcpy(buf, g_rx[slot].data, g_rx[slot].len);
    len = g_rx[slot].len;
    return RadioStatus::Ok;
}

}  // namespace radio_link
