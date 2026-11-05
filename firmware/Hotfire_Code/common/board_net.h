/**
 * Board networking — the ground station decides addresses, not the board.
 *
 * Enabled per board with -DSENSOR_ETH_USE_DHCP (every hotfire board today).
 *
 *   1. boot: DHCP DISCOVER. The DAQ server / Test-GUI answers from its
 *      MAC -> IP reservation table, so the address a board gets is decided in
 *      one place, by people, and is the same every boot. The board takes its
 *      ID from that address (192.168.2.31 -> board 31), so every board of a
 *      type runs the same image: which board is which is the reservation
 *      table's `mac =` lines, not a build flag.
 *   2. renew the lease as it expires (suppressed during an OTA — see
 *      beginOtaHold()).
 *   3. the board announces itself by broadcasting BOARD_HEARTBEAT until some
 *      server talks to it, and learns the server's address from that packet.
 *
 * When no DHCP server answers, the board takes its RECOVERY address,
 * 169.254.<1 + mac[4] % 254>.<mac[5]>/16, and keeps asking for a lease every
 * SENSOR_ETH_DHCP_RETRY_INTERVAL_MS. The recovery address exists so a board
 * whose DHCP failed (server down, booted before the switch) can still be
 * reflashed over Ethernet: `ota_upload.py --mac <mac>` computes the same
 * address. It is never a working address — the DAQ does not talk to a board
 * there, and the board's ID is 0 until a lease arrives.
 *
 * Why not the old static 192.168.2.<BOARD_ID> fallback: it needed a per-board
 * build, and a board that missed DHCP looked exactly like one that got it, so
 * DHCP could be broken for weeks unnoticed. Why derive from the MAC: it is
 * burned into the ESP32, unique, and survives any flash erase; two bytes of
 * it give 64k addresses, so collisions are checkable in advance (the config
 * editor refuses two boards whose recovery addresses match).
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
    None,     ///< not yet brought up
    Dhcp,     ///< assigned by the ground station — the normal case
    Recovery  ///< no DHCP answer: 169.254.x.y from the MAC, reflash-only
};

inline const char* sourceName(AddressSource s) {
    switch (s) {
        case AddressSource::None:
            return "none";
        case AddressSource::Dhcp:
            return "DHCP (assigned by the server)";
        case AddressSource::Recovery:
            return "recovery (no DHCP server answered; reflash only)";
    }
    return "unknown";
}

/** Subnet of the recovery address: link-local, 169.254.0.0/16. */
inline IPAddress recoverySubnet() {
    return IPAddress(255, 255, 0, 0);
}

/**
 * The board's recovery address, from its MAC: 169.254.<1 + mac[4] %
 * 254>.<mac[5]>.
 *
 * The third octet stays in 1..254, the range RFC 3927 lets a host use.
 * firmware/tools/ota_upload.py and daq-server's config validation compute the
 * same thing; test_board_net pins the formula with the vectors they test.
 */
inline IPAddress recoveryAddress(const byte mac[6]) {
    return IPAddress(169, 254, 1 + (mac[4] % 254), mac[5]);
}

struct State {
    // --- set once by configure(), at setup() ---
    byte mac[6] = {0, 0, 0, 0, 0, 0};

    // --- runtime ---
    AddressSource source = AddressSource::None;
    bool serverLearned = false;  ///< server IP adopted from an inbound packet
    bool otaHold = false;        ///< suppress lease renewal during a flash
    unsigned long lastServerPacketMillis = 0;
    unsigned long lastDhcpAttemptMillis = 0;
};

inline void configure(State& s, const byte mac[6]) {
    memcpy(s.mac, mac, 6);
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
 * The board's ID: the last octet of the address the server assigned
 * (192.168.2.31 -> 31). 0 while on the recovery address, where the board has
 * no identity the server gave it.
 */
inline uint8_t boardId(const State& s) {
    return usingDhcp(s) ? Ethernet.localIP()[3] : 0;
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

inline void useRecoveryAddress(State& s, IPAddress dns, IPAddress gateway) {
    s.source = AddressSource::Recovery;
    Ethernet.begin(s.mac, recoveryAddress(s.mac), dns, gateway,
                   recoverySubnet());
}

/**
 * Bring the interface up: ask the ground station for an address, and take the
 * recovery address only if nothing answers. Returns how we ended up addressed.
 */
inline AddressSource begin(State& s, IPAddress dns, IPAddress gateway) {
    Serial.println("[NET] requesting an address by DHCP...");
    Serial.flush();
    s.lastDhcpAttemptMillis = millis();
    if (Ethernet.begin(s.mac, SENSOR_ETH_DHCP_TIMEOUT_MS,
                       SENSOR_ETH_DHCP_RESPONSE_TIMEOUT_MS) == 1) {
        s.source = AddressSource::Dhcp;
        Serial.print("[NET] server assigned us ");
        Serial.println(Ethernet.localIP());
        Serial.flush();
        return s.source;
    }

    useRecoveryAddress(s, dns, gateway);
    Serial.print("[NET] no DHCP server answered -- on the recovery address ");
    Serial.print(recoveryAddress(s.mac));
    Serial.println(" (reflash only); asking again every few seconds.");
    Serial.flush();
    return s.source;
}

/**
 * On the recovery address, ask for a lease again every
 * SENSOR_ETH_DHCP_RETRY_INTERVAL_MS. Call every loop(); a no-op on a lease and
 * during an OTA. Returns true when a lease arrived: the address and boardId()
 * changed, so the caller should re-announce itself.
 *
 * Each attempt blocks for up to SENSOR_ETH_DHCP_RETRY_TIMEOUT_MS. That is only
 * ever spent on the recovery address, where the DAQ cannot reach the board, so
 * it can never stall a session. Open sockets survive: a new address does not
 * close them, and the W5500 is not reset.
 */
inline bool retryDhcp(State& s, IPAddress dns, IPAddress gateway) {
    if (s.source != AddressSource::Recovery || s.otaHold)
        return false;
    if (millis() - s.lastDhcpAttemptMillis < SENSOR_ETH_DHCP_RETRY_INTERVAL_MS)
        return false;
    s.lastDhcpAttemptMillis = millis();
    if (Ethernet.begin(s.mac, SENSOR_ETH_DHCP_RETRY_TIMEOUT_MS,
                       SENSOR_ETH_DHCP_RESPONSE_TIMEOUT_MS) == 1) {
        s.source = AddressSource::Dhcp;
        Serial.print("[NET] DHCP answered at last -- server assigned us ");
        Serial.println(Ethernet.localIP());
        Serial.flush();
        return true;
    }
    // A failed attempt leaves the chip at 0.0.0.0; put the recovery address
    // back so the board stays reflashable.
    useRecoveryAddress(s, dns, gateway);
    return false;
}

}  // namespace BoardNet
