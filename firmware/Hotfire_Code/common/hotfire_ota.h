#pragma once

/**
 * Ethernet OTA for hotfire boards — thin compatibility layer.
 *
 * The implementation now lives in the shared library
 * ``firmware/libraries/STAR_EthernetOTA``, so every STAR board with a W5500
 * runs the same code. This header keeps the older names working; new code
 * should include <STAR_EthernetOTA.h> and use StarOTA::Server directly.
 *
 * Wire protocol is unchanged:
 *   client -> board : [4-byte big-endian size][firmware binary]
 *   board  -> client: "OK\r\n", then reboot
 */

#include <STAR_EthernetOTA.h>

/** Legacy alias for the portability wrapper around EthernetServer. */
using OTAEthernetServer = StarOTA::PortableServer;

/**
 * Legacy blocking handler.
 *
 * Prefer StarOTA::Server::poll(), which owns the listening socket and the
 * accept step too, so callers no longer hand-roll available()/handle().
 */
inline void hotfire_handleOTA(EthernetClient& client) {
    // The adapter never listens (the caller owns the socket); it is here only
    // to carry the config and run the transfer.
    static StarOTA::Server adapter;
    adapter.handleClient(client);
}
