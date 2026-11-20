#pragma once

#include <netinet/in.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

namespace sequencer {

/**
 * Sends ABORT / ABORT_DONE / CLEAR_ABORT UDP broadcast packets
 * (PacketHeader only — 6 bytes) to the configured broadcast address and port.
 *
 * On abort entry:
 *   1. sendAbort()     — fires immediately
 *   2. scheduleAbortDone() — fires ABORT_DONE after abort_done_delay_ms
 *
 * Thread-safe.
 */
class AbortBroadcaster {
public:
    explicit AbortBroadcaster(uint16_t port = 5005, uint32_t abort_done_delay_ms = 3000);
    ~AbortBroadcaster();

    /**
     * Adopt the destination and source NIC from config. Call once, before anything can abort.
     *
     * This class used to be default-constructed and never told anything: port 5005 by ctor
     * default, destination hardcoded to the limited broadcast 255.255.255.255, source interface
     * left to the kernel. Every other sender in the system takes its destination from config, and
     * a limited broadcast is the one destination that does not resolve to a single route — so on
     * a host with more than one NIC all four repeats could leave on the wrong wire together.
     *
     * @param broadcast_ip   Subnet-directed broadcast for the board LAN, e.g. 192.168.2.255.
     * @param port           Board listen port.
     * @param done_delay_ms  Delay before ABORT_DONE.
     * @param bind_address   Local address to send from, or "0.0.0.0" to leave unpinned.
     * @return false if broadcast_ip is not a valid IPv4 address (caller should fail startup).
     */
    bool configure(const std::string& broadcast_ip, uint16_t port, uint32_t done_delay_ms,
                   const std::string& bind_address);

    /** Send ABORT broadcast and schedule ABORT_DONE after abort_done_delay_ms. */
    void triggerAbort();

    /** Send CLEAR_ABORT broadcast (called when leaving abort states). */
    void sendClearAbort();

private:
    uint16_t port_;
    uint32_t abort_done_delay_ms_;
    // Resolved once in configure(), not per send: the abort path is the wrong place to discover
    // that an address does not parse.
    struct in_addr dest_addr_{};
    std::string dest_ip_{"255.255.255.255"};
    std::string bind_address_{"0.0.0.0"};
    std::atomic<bool> done_thread_running_{false};
    std::thread done_thread_;
    // triggerAbort() joins done_thread_ and then move-assigns a new thread onto it. Two callers
    // doing that concurrently is either a double join (UB) or a move onto a joinable thread,
    // which is a std::terminate — the same hazard FireManager::stop() documents. Abort is
    // reachable from any TCP client thread and from the fire-expiry thread, so it needs its own
    // lock regardless of what serializes the state machine above it.
    std::mutex done_thread_mutex_;

    /** How many times each broadcast is repeated, and the gap between repeats. A single UDP
     *  datagram is not a delivery guarantee: one dropped frame on a congested field network and
     *  no board hears the abort. ActuatorCommander::sendBatch already sends ordinary state
     *  changes 3x for exactly this reason — the abort path must not be weaker than the routine
     *  one. */
    static constexpr int kBroadcastRepeats = 4;
    static constexpr int kBroadcastGapUs = 2000;

    void sendPacket(uint8_t packet_type);
    void waitAndSendAbortDone();
};

}  // namespace sequencer
