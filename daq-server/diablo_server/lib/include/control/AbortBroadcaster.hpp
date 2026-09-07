#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>

namespace sequencer {

/**
 * Sends ABORT / ABORT_DONE / CLEAR_ABORT UDP broadcast packets
 * (PacketHeader only — 6 bytes) to 255.255.255.255 on the configured port.
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

    /** Send ABORT broadcast and schedule ABORT_DONE after abort_done_delay_ms. */
    void triggerAbort();

    /** Send CLEAR_ABORT broadcast (called when leaving abort states). */
    void sendClearAbort();

private:
    uint16_t port_;
    uint32_t abort_done_delay_ms_;
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
