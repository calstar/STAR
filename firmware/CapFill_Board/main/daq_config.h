// Diablo DAQ network settings for CapFill.
// Values match calstar/DiabloAvionics Hotfire_Code/common/hotfire_config.h so CapFill behaves like
// the PT / TC / LC / RTD boards on the same network.
#pragma once

// =====================================================================================
//  !!!  TODO(BOARD_ID): CHANGE THIS BEFORE CONNECTING TO THE REAL DAQ NETWORK  !!!
// =====================================================================================
//
//  BOARD_ID below is a PLACEHOLDER. It is not an ID the club assigned to CapFill.
//
//  - BOARD_ID is also the last number of this board's IP address: 192.168.2.<BOARD_ID>.
//    Two boards with the same ID will fight over the same IP and the server will mix
//    their data up.
//  - Ask the DAQ / avionics lead which ID CapFill should use, and check it isn't taken
//    (21 = PT board default in hotfire_config.h, 20 = the server).
//  - When you have the real ID:
//      1. Change the number on the `#define BOARD_ID` line below.
//      2. Change CAPFILL_BOARD_ID_IS_PLACEHOLDER from 1 to 0 to silence the reminders.
//      3. Rebuild and reflash. Check the boot log line "CapFill board, BOARD_ID NN -> IP ...".
//
//  While the placeholder is in use, the build prints a warning and the board logs a
//  warning at boot, so this is hard to forget.
// =====================================================================================
#ifndef BOARD_ID
#define BOARD_ID 99   // TODO(BOARD_ID): placeholder - replace with CapFill's assigned ID
#define CAPFILL_BOARD_ID_IS_PLACEHOLDER 1   // TODO(BOARD_ID): set to 0 once BOARD_ID is real
#endif

#ifndef CAPFILL_BOARD_ID_IS_PLACEHOLDER
#define CAPFILL_BOARD_ID_IS_PLACEHOLDER 0
#endif

#if BOARD_ID < 1 || BOARD_ID > 254
#error "BOARD_ID must be 1..254 (it is the last octet of the board's IP)"
#endif
#if BOARD_ID == 20
#error "BOARD_ID 20 is the DAQ server's address (192.168.2.20)"
#endif
// =====================================================================================

// Network: static IP 192.168.2.<BOARD_ID>/24, no gateway (same as SensorHotfireCore)
#define DAQ_NET_OCTET_1          192
#define DAQ_NET_OCTET_2          168
#define DAQ_NET_OCTET_3          2
#define DAQ_NETMASK              "255.255.255.0"

// Server (hardcoded; not learned from packets, same as the club boards)
#define DAQ_SERVER_IP_OCTET_4    20      // 192.168.2.20
#define DAQ_SERVER_PORT          5006    // server listens here for heartbeats / data / self test
#define DAQ_BOARD_LISTEN_PORT    5005    // this board listens here for server packets
#define DAQ_OTA_PORT             3232    // TCP, firmware updates (same protocol as hotfire_ota.h)

// Timing
#define DAQ_HEARTBEAT_INTERVAL_MS  1000  // board heartbeat once per second
#define DAQ_CHUNKS_PER_PACKET      9     // HOTFIRE_CHUNKS_PER_PACKET

// Self test: a channel passes if it is producing valid, unsaturated readings and reads at
// least this many pF. 0 disables the threshold.
// TODO: measure an empty connector vs. a connected probe on the bench and set this between them.
#define SELFTEST_MIN_PF            0.0f
