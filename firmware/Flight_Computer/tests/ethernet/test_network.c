#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "daq_network.h"
#define CHECK(x)                                       \
    do {                                               \
        if (!(x)) {                                    \
            fprintf(stderr, "%d: %s\n", __LINE__, #x); \
            abort();                                   \
        }                                              \
    } while (0)
int main(void) {
    const uint8_t first[4] = {192, 168, 2, 20}, second[4] = {192, 168, 2, 30};
    const uint8_t broadcast[4] = {255, 255, 255, 255};
    uint8_t server[4] = {192, 168, 2, 20};
    uint8_t heartbeat[] = {2, 0, 0, 0, 0, 0, 0};
    uint8_t config[] = {5, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0};
    daq_peer_t peer = {0};
    CHECK(!memcmp(daq_server_destination(&peer, server, true), broadcast, 4));
    CHECK(!memcmp(daq_server_destination(&peer, server, false), first, 4));
    /* Invalid and unmapped packets must not claim the discovery slot. */
    CHECK(!daq_server_receive(&peer, server, second, true, 0, config,
                              sizeof(config), 0));
    CHECK(!peer.heard_server && !memcmp(server, first, 4));
    heartbeat[0] = 4; /* actuator command */
    CHECK(!daq_server_receive(&peer, server, second, true, 1, heartbeat,
                              sizeof(heartbeat), 0));
    heartbeat[0] = 2;
    CHECK(!daq_server_receive(&peer, server, broadcast, true, 1, heartbeat,
                              sizeof(heartbeat), 0));
    CHECK(!daq_server_receive(&peer, server, second, false, 1, heartbeat,
                              sizeof(heartbeat), 0));
    CHECK(daq_server_receive(&peer, server, first, true, 1, heartbeat,
                             sizeof(heartbeat), UINT32_MAX - 1000));
    CHECK(peer.heard_server && !peer.configured);
    CHECK(!memcmp(daq_server_destination(&peer, server, true), first, 4));
    CHECK(!daq_server_receive(&peer, server, second, true, 1, config,
                              sizeof(config), 100));
    CHECK(peer.last_server_ms == UINT32_MAX - 1000);
    daq_peer_expire(&peer, 8998);
    CHECK(peer.heard_server);
    daq_peer_expire(&peer, 8999);
    CHECK(!peer.heard_server && !peer.configured);
    CHECK(!memcmp(daq_server_destination(&peer, server, true), broadcast, 4));
    /* A replacement server can configure directly after expiry. */
    CHECK(daq_server_receive(&peer, server, second, true, 1, config,
                             sizeof(config), 9000));
    CHECK(peer.configured && peer.channels == 1 && !memcmp(server, second, 4));
    CHECK(!memcmp(daq_server_destination(&peer, server, true), second, 4));
    heartbeat[1] = 1;
    CHECK(!daq_server_receive(&peer, server, second, true, 1, heartbeat,
                              sizeof(heartbeat), 9500));
    CHECK(peer.last_server_ms == 9000);
    daq_peer_expire(&peer, 19000);
    CHECK(!peer.heard_server && !peer.channels);
    const uint32_t uid[3] = {1, 2, 3};
    uint8_t mac[6], again[6], other[6];
    daq_mac_from_uid(uid, mac);
    daq_mac_from_uid(uid, again);
    CHECK(!memcmp(mac, again, 6) && (mac[0] & 3) == 2);
    for (unsigned word = 0; word < 3; ++word) {
        uint32_t changed[3] = {1, 2, 3};
        changed[word] ^= 0x01000000;
        daq_mac_from_uid(changed, other);
        CHECK(memcmp(mac, other, 6));
    }
    puts("Discovery, pinning, rollover expiry and UID identity passed");
}
