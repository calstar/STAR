#include "daq_network.h"

#include <string.h>

static bool unicast(const uint8_t ip[4]) {
    return ip[0] != 0 && ip[0] < 224 && ip[0] != 127 && ip[3] != 0 &&
           ip[3] != 255;
}
bool daq_server_receive(daq_peer_t* peer, uint8_t server[4],
                        const uint8_t source[4], bool discover,
                        uint16_t supported, const uint8_t* bytes, size_t length,
                        uint32_t now_ms) {
    if (!unicast(source) ||
        ((!discover || peer->heard_server) && memcmp(source, server, 4)))
        return false;
    daq_peer_t next = *peer;
    if (!daq_peer_receive(&next, bytes, length, now_ms) ||
        (next.channels & (uint16_t)~supported))
        return false;
    *peer = next;
    memcpy(server, source, 4);
    return true;
}
const uint8_t* daq_server_destination(const daq_peer_t* peer,
                                      const uint8_t server[4], bool discover) {
    static const uint8_t broadcast[4] = {255, 255, 255, 255};
    return discover && !peer->heard_server ? broadcast : server;
}
void daq_mac_from_uid(const uint32_t uid[3], uint8_t mac[6]) {
    uint64_t hash = UINT64_C(14695981039346656037);
    for (unsigned word = 0; word < 3; ++word)
        for (unsigned byte = 0; byte < 4; ++byte) {
            hash ^= (uint8_t)(uid[word] >> (8U * byte));
            hash *= UINT64_C(1099511628211);
        }
    for (unsigned i = 0; i < 6; ++i)
        mac[i] = (uint8_t)(hash >> (8U * i));
    mac[0] = (uint8_t)((mac[0] & 0xFCU) | 0x02U);
}
