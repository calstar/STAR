#include "control/AbortBroadcaster.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <iostream>
#include <mutex>
#include <thread>

// daqv2comms — PacketHeader + PacketType
#include "DiabloEnums.h"
#include "DiabloPackets.h"

namespace sequencer {

namespace {
uint32_t host_timestamp_ms() {
    return static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                     std::chrono::steady_clock::now().time_since_epoch())
                                     .count() &
                                 0xFFFFFFFF);
}
}  // namespace

AbortBroadcaster::AbortBroadcaster(uint16_t port, uint32_t abort_done_delay_ms)
    : port_(port), abort_done_delay_ms_(abort_done_delay_ms) {
}

AbortBroadcaster::~AbortBroadcaster() {
    std::lock_guard<std::mutex> lk(done_thread_mutex_);
    done_thread_running_ = false;
    if (done_thread_.joinable())
        done_thread_.join();
}

// ─────────────────────────────────────────────────────────────────────────────
void AbortBroadcaster::sendPacket(uint8_t packet_type_byte) {
    daq::PacketHeader hdr{};
    hdr.packet_type = static_cast<daq::PacketType>(packet_type_byte);
    hdr.version = 0;  // DIABLO_COMMS_VERSION
    hdr.timestamp = host_timestamp_ms();

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "[AbortBroadcaster] socket() failed" << std::endl;
        return;
    }

    int broadcast = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast));

    // A blocked sendto here would stall the abort itself. Bound it: a broadcast that cannot be
    // queued within 100 ms is a lost repeat, not a reason to stop sending the others.
    struct timeval tv{.tv_sec = 0, .tv_usec = 100000};
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port_);
    dest.sin_addr.s_addr = INADDR_BROADCAST;

    const char* type_name = (packet_type_byte == 7)   ? "ABORT"
                            : (packet_type_byte == 8) ? "ABORT_DONE"
                            : (packet_type_byte == 9) ? "CLEAR_ABORT"
                                                      : "UNKNOWN";

    // Repeat on one socket rather than sending once. Each repeat is independent: a failure is
    // logged with errno and the remaining repeats still go out.
    int delivered = 0;
    for (int i = 0; i < kBroadcastRepeats; ++i) {
        ssize_t sent = sendto(sock, &hdr, sizeof(hdr), 0, reinterpret_cast<struct sockaddr*>(&dest),
                              sizeof(dest));
        if (sent == static_cast<ssize_t>(sizeof(hdr)))
            ++delivered;
        else
            std::cerr << "[AbortBroadcaster] sendto(" << type_name << ") repeat " << (i + 1)
                      << " failed: " << strerror(errno) << std::endl;
        if (i + 1 < kBroadcastRepeats)
            usleep(kBroadcastGapUs);
    }
    close(sock);

    if (delivered > 0)
        std::cout << "[AbortBroadcaster] Sent " << type_name << " broadcast (port " << port_ << ", "
                  << delivered << "/" << kBroadcastRepeats << " repeats)" << std::endl;
    else
        std::cerr << "[AbortBroadcaster] " << type_name << " broadcast FAILED — no repeat left the "
                  << "host" << std::endl;
}

// ─────────────────────────────────────────────────────────────────────────────
void AbortBroadcaster::triggerAbort() {
    // Immediate ABORT — before taking any lock. This is the boards' last line of defence and it
    // must not queue behind a previous abort's bookkeeping.
    sendPacket(static_cast<uint8_t>(daq::PacketType::ABORT));

    // Cancel any previously scheduled ABORT_DONE thread, then schedule a fresh one. Both halves
    // must be under the same lock: a second abort landing between the join and the assignment
    // would move onto a joinable thread and terminate the process.
    std::lock_guard<std::mutex> lk(done_thread_mutex_);

    done_thread_running_ = false;
    if (done_thread_.joinable()) {
        if (done_thread_.get_id() == std::this_thread::get_id())
            done_thread_.detach();  // cannot join self; it is returning anyway
        else
            done_thread_.join();
    }

    // Schedule ABORT_DONE
    done_thread_running_ = true;
    done_thread_ = std::thread([this]() {
        waitAndSendAbortDone();
    });
}

void AbortBroadcaster::waitAndSendAbortDone() {
    const auto delay = std::chrono::milliseconds(abort_done_delay_ms_);
    const auto step = std::chrono::milliseconds(50);
    auto elapsed = std::chrono::milliseconds(0);

    while (done_thread_running_ && elapsed < delay) {
        std::this_thread::sleep_for(step);
        elapsed += step;
    }
    if (done_thread_running_)
        sendPacket(static_cast<uint8_t>(daq::PacketType::ABORT_DONE));
}

void AbortBroadcaster::sendClearAbort() {
    sendPacket(static_cast<uint8_t>(daq::PacketType::CLEAR_ABORT));
}

}  // namespace sequencer
