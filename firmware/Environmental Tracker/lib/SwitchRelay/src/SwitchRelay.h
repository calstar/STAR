#pragma once

#include <stddef.h>
#include <stdint.h>

#include "DiabloPackets.h"

// What the environmental board knows about the Bluetooth switches, with no BLE
// or network in it, so it can be tested on the host.
//
// The board relays; it never decides. It holds the switch list the server last
// sent (in memory only), says which switches to connect to and when to scan,
// and turns what the switches report into SWITCH_STATUS reports. Nothing here
// produces a write to a switch.
class SwitchRelay {
public:
    using Mac = uint8_t[6];  // most significant byte first, as printed

    // A SWITCH_CONFIG arrived. Applied only when `hash` differs from the held
    // one (the server resends every second). Switches that stay listed keep
    // their link and last status even if their role index changes. Returns
    // how many MACs were dropped from the list; their links must be closed
    // (dropped(i) lists them until the next applyConfig).
    size_t applyConfig(const daq::SwitchConfig &config, uint32_t hash);
    bool hasConfig() const { return hasConfig_; }
    uint32_t configHash() const { return hash_; }
    const uint8_t *dropped(size_t i) const { return dropped_[i]; }

    // Role a MAC is listed under, or -1.
    int roleFor(const uint8_t mac[6]) const;
    // Listed and not connected: worth connecting to when heard in a scan.
    bool shouldConnect(const uint8_t mac[6]) const;
    // Scan only while some listed switch is not connected.
    bool wantsScan() const;
    const uint8_t *macFor(uint8_t role) const;  // nullptr if the role is unlisted

    void onConnected(const uint8_t mac[6]);
    void onDisconnected(const uint8_t mac[6]);
    void onRssi(const uint8_t mac[6], int8_t rssi);
    // A status notification (or read). Kept untouched; too long is cut to fit.
    void onStatus(const uint8_t mac[6], const uint8_t *bytes, size_t len, uint32_t nowMs);
    bool connected(uint8_t role) const;

    // Reports due now: each listed role whose switch sent something new since
    // its last report, or whose last report is REPORT_PERIOD_MS old. Writes at
    // most `max` and marks them sent.
    static constexpr uint32_t REPORT_PERIOD_MS = 1000;
    size_t collectReports(uint32_t nowMs, daq::SwitchStatusReport *out, size_t max);

    // Commands. The only way anything is ever written to a switch: the BLE task
    // writes exactly what takeCommand() hands it, and nothing else in the board
    // produces a write.
    //
    // A command from the DAQ: rejected at once (no config, unknown role, link
    // down, relay busy) or queued for the BLE task. Either way exactly one result
    // follows. Nothing waits for a link to come back.
    void submitCommand(const daq::SwitchCommandPacket &cmd);
    // Next command to write, with its switch's MAC. A command whose link went
    // down since it was queued is answered NO_LINK here and skipped.
    bool takeCommand(daq::SwitchCommandPacket &cmd, uint8_t mac[6]);
    // The BLE task's outcome for a command takeCommand() gave it.
    void finishCommand(const daq::SwitchCommandPacket &cmd, bool written);
    // Results waiting to go to the DAQ.
    size_t collectResults(daq::SwitchCommandResultPacket *out, size_t max);
    static constexpr size_t MAX_QUEUED = daq::MAX_SWITCHES;

private:
    struct Slot {
        bool listed = false;
        uint8_t mac[6] = {};
        bool up = false;
        int8_t rssi = 0;
        bool haveStatus = false;
        uint32_t statusAtMs = 0;
        uint8_t statusLen = 0;
        uint8_t status[daq::MAX_SWITCH_STATUS_BYTES] = {};
        bool fresh = false;  // new status or link change since the last report
        bool everReported = false;
        uint32_t reportedAtMs = 0;
    };
    Slot *find(const uint8_t mac[6]);
    const Slot *find(const uint8_t mac[6]) const;

    void result(const daq::SwitchCommandPacket &cmd, daq::SwitchCommandResult r);

    Slot slots_[daq::MAX_SWITCHES];  // indexed by role
    struct Queued {
        daq::SwitchCommandPacket cmd;
        uint8_t mac[6];  // the switch it was accepted for; a new list can't redirect it
    };
    Queued queue_[MAX_QUEUED];
    size_t queued_ = 0;
    daq::SwitchCommandResultPacket results_[MAX_QUEUED * 2];
    size_t nResults_ = 0;
    bool hasConfig_ = false;
    uint32_t hash_ = 0;
    uint8_t dropped_[daq::MAX_SWITCHES][6] = {};
};
