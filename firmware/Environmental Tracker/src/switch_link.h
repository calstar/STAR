#pragma once

#include <stddef.h>
#include <stdint.h>

#include "DiabloPackets.h"

// BLE central for the Bluetooth switches. Holds a persistent connection to
// every switch on the list the server sent, scans only while one of them is
// missing, and relays their status. Runs in its own task, because NimBLE's
// connect blocks and the Ethernet loop must not.
//
// It never writes to a switch on its own: not on losing the server, not on an
// abort, not after a reboot (the operator decides; see the env board README).
namespace switch_link {

// Starts NimBLE and the BLE task. Returns false if BLE would not start; the
// rest of the board carries on without it.
bool begin();
bool running();

// A SWITCH_CONFIG from the server. Ignored when its hash is the one held.
void applyConfig(const daq::SwitchConfig &config, uint32_t hash);

// An operator's command from the DAQ. Answered by a result, never queued for a
// link that is down (see SwitchRelay::submitCommand).
void submitCommand(const daq::SwitchCommandPacket &cmd);
size_t collectResults(daq::SwitchCommandResultPacket *out, size_t max);

// "Find switches": scan for durationMs and report unlisted switches heard.
void startDiscovery(uint32_t durationMs);
size_t collectSeen(uint32_t nowMs, daq::SwitchSeenPacket *out, size_t max);

// Reports due now (see SwitchRelay::collectReports).
size_t collectReports(uint32_t nowMs, daq::SwitchStatusReport *out, size_t max);

}  // namespace switch_link
