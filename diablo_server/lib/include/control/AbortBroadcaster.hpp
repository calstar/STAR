#pragma once

#include <atomic>
#include <cstdint>
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

    void sendPacket(uint8_t packet_type);
    void waitAndSendAbortDone();
};

}  // namespace sequencer
