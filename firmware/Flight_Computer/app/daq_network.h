#ifndef STAR_DAQ_NETWORK_H
#define STAR_DAQ_NETWORK_H
#include "daq_wire.h"

/* Address pinning lasts until the peer expires. Discovery is not
 * authentication. */
bool daq_server_receive(daq_peer_t* peer, uint8_t server[4],
                        const uint8_t source[4], bool discover,
                        uint16_t supported, const uint8_t* bytes, size_t length,
                        uint32_t now_ms);
const uint8_t* daq_server_destination(const daq_peer_t* peer,
                                      const uint8_t server[4], bool discover);
/* Deterministic locally administered unicast address; register and check for
 * collisions before deployment. uid words are serialized least byte first. */
void daq_mac_from_uid(const uint32_t uid[3], uint8_t mac[6]);
#endif
