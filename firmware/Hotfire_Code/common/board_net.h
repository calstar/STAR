/**
 * Board networking — the ground station decides addresses, not the board.
 *
 * Enabled per board with -DSENSOR_ETH_USE_DHCP (every hotfire board today).
 * The board asks for an address and uses whatever it is given:
 *
 *   1. boot: DHCP DISCOVER. The DAQ server / Test-GUI answers from its
 *      MAC -> IP reservation table, so the address a board gets is decided in
 *      one place, by people, and is the same every boot.
 *   2. renew the lease as it expires (suppressed during an OTA — see
 *      beginOtaHold()).
 *   3. the board announces itself by broadcasting BOARD_HEARTBEAT until some
 *      server talks to it, and learns the server's address from that packet.
 *
 * The board never invents an address for itself. Earlier revisions had it fall
 * back to a self-assigned link-local 169.254.x.y when DHCP went unanswered;
 * that is gone, because it meant the board — not the ground station — was
 * choosing. What remains is a LAST-RESORT static 192.168.2.<BOARD_ID>, used
 * only when no DHCP server answers at all, so a board is never mute on the
 * wire and `daq-server`'s per-board static IPs still work if the DHCP server
 * is down. Build with -DSTAR_NET_DHCP_ONLY to remove even that, and the board
 * will have no address unless the ground station gives it one.
 *
 * No ESP32 dependencies beyond Arduino/Ethernet, so it is unit-testable
 * off-target — see Hotfire_Tests/test/test_board_net.
 */

#pragma once

#include <Arduino.h>
#include <Ethernet.h>

#include "hotfire_config.h"

namespace BoardNet {

/** How the board ended up with the address it is using. */
enum class AddressSource : uint8_t {
    None,     ///< no address (DHCP-only build, and no server answered)
    Dhcp,     ///< assigned by the ground station — the normal case
    Fallback  ///< last-resort static 192.168.2.<BOARD_ID>
};

inline const char* sourceName(AddressSource s) {
    switch (s) {
        case AddressSource::None:
            return "none";
        case AddressSource::Dhcp:
            return "DHCP (assigned by the server)";
        case AddressSource::Fallback:
            return "static fallback (no DHCP server answered)";
    }
    return "unknown";
}

struct State {
    // --- set once by configure(), at setup() ---
    byte mac[6] = {0, 0, 0, 0, 0, 0};
    IPAddress staticIP;      // last-resort 192.168.2.<BOARD_ID>
    IPAddress staticSubnet;

    // --- runtime ---
    AddressSource source = AddressSource::None;
    bool serverLearned = false;  ///< server IP adopted from an inbound packet
    bool otaHold = false;        ///< suppress lease renewal during a flash
    unsigned long lastServerPacketMillis = 0;
};

inline void configure(State& s, const byte mac[6], IPAddress staticIP,
                      IPAddress staticSubnet) {
    memcpy(s.mac, mac, 6);
    s.staticIP = staticIP;
    s.staticSubnet = staticSubnet;
}

/** Print the MAC as aa:bb:cc:dd:ee:ff.
 *
 * The ground station keys its reservation table on this, so it has to be
 * readable off the serial log — otherwise registering a new board means
 * guessing, or sniffing its DHCP request.
 */
inline void printMac(const State& s) {
    Serial.print("MAC: ");
    for (int i = 0; i < 6; i++) {
        if (s.mac[i] < 0x10)
            Serial.print("0");
        Serial.print(s.mac[i], HEX);
        if (i < 5)
            Serial.print(":");
    }
    Serial.println();
    Serial.flush();
}

inline bool usingDhcp(const State& s) {
    return s.source == AddressSource::Dhcp;
}

inline bool hasAddress(const State& s) {
    return s.source != AddressSource::None;
}

/**
 * Renew the lease as it expires. No-op when we are not on a lease, and
 * deliberately a no-op during an OTA: a renewal that moved our address
 * mid-flash would drop the transfer.
 */
inline void maintainLease(State& s) {
    if (usingDhcp(s) && !s.otaHold)
        Ethernet.maintain();
}

/** Called when an OTA transfer starts, so the address cannot move under it. */
inline void beginOtaHold(State& s) {
    s.otaHold = true;
}

/**
 * A server packet arrived from `remote_ip`; adopt it as the server address.
 * Returns true if `serverIP` changed.
 */
inline bool onServerPacket(State& s, IPAddress remote_ip, IPAddress& serverIP) {
    s.lastServerPacketMillis = millis();
    if (!s.serverLearned || !(remote_ip == serverIP)) {
        serverIP = remote_ip;
        s.serverLearned = true;
        Serial.print("[NET] server learned: ");
        Serial.println(remote_ip);
        Serial.flush();
        return true;
    }
    return false;
}

/** Server has stopped talking — forget it and resume discovery broadcasts. */
inline bool serverWentSilent(const State& s) {
    return s.serverLearned && millis() - s.lastServerPacketMillis >=
                                  SENSOR_ZEROCONF_SERVER_SILENCE_MS;
}

/**
 * Bring the interface up: ask the ground station for an address, and fall
 * back to the static one only if nothing answers.
 *
 * Returns how we ended up addressed.
 */
inline AddressSource begin(State& s, IPAddress dns, IPAddress gateway) {
    Serial.println("[NET] requesting an address by DHCP...");
    Serial.flush();
    if (Ethernet.begin(s.mac, SENSOR_ETH_DHCP_TIMEOUT_MS,
                       SENSOR_ETH_DHCP_RESPONSE_TIMEOUT_MS) == 1) {
        s.source = AddressSource::Dhcp;
        Serial.print("[NET] server assigned us ");
        Serial.println(Ethernet.localIP());
        Serial.flush();
        return s.source;
    }

#ifdef STAR_NET_DHCP_ONLY
    (void)dns;
    (void)gateway;
    s.source = AddressSource::None;
    Serial.println(
        "[NET] no DHCP server answered and this is a DHCP-only build -- "
        "the board has no address. Start the ground station's DHCP server.");
    Serial.flush();
#else
    s.source = AddressSource::Fallback;
    Serial.print(
        "[NET] no DHCP server answered -- falling back to the static ");
    Serial.println(s.staticIP);
    Serial.println(
        "[NET] WARNING: this address was NOT assigned by the server. Start "
        "the ground station's DHCP server and reboot to get the assigned one.");
    Serial.flush();
    Ethernet.begin(s.mac, s.staticIP, dns, gateway, s.staticSubnet);
#endif
    return s.source;
}

}  // namespace BoardNet
