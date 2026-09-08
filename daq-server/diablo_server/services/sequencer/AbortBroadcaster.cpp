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
#include "net/DaqInterface.hpp"

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
    dest_addr_.s_addr = INADDR_BROADCAST;
}

bool AbortBroadcaster::configure(const std::string& broadcast_ip, uint16_t port,
                                 uint32_t done_delay_ms, const std::string& bind_address) {
    struct in_addr parsed{};
    if (inet_pton(AF_INET, broadcast_ip.c_str(), &parsed) != 1) {
        std::cerr << "[AbortBroadcaster] invalid broadcast address '" << broadcast_ip << "'"
                  << std::endl;
        return false;
    }
    dest_addr_ = parsed;
    dest_ip_ = broadcast_ip;
    port_ = port;
    abort_done_delay_ms_ = done_delay_ms;
    bind_address_ = bind_address;
    // The limited broadcast is the one destination that does not resolve to a single route, so a
    // config that omits the key keeps the defect this class was fixed for. Do not silently
    // upgrade it to a subnet-directed guess — [server_heartbeat].broadcast_ip is also what
    // daq_bridge sends SERVER_HEARTBEAT to, and inventing a subnet here would move that too.
    if (dest_addr_.s_addr == INADDR_BROADCAST)
        std::cerr << "[AbortBroadcaster] WARNING: aborting to the limited broadcast "
                     "255.255.255.255 — set [server_heartbeat].broadcast_ip to the board subnet "
                     "(e.g. 192.168.2.255) or the kernel picks the egress interface"
                  << std::endl;

    std::cout << "[AbortBroadcaster] ABORT/ABORT_DONE/CLEAR_ABORT -> " << dest_ip_ << ":" << port_
              << " (from "
              << (bind_address_ == "0.0.0.0" ? std::string("any interface") : bind_address_)
              << ", ABORT_DONE after " << abort_done_delay_ms_ << " ms)" << std::endl;
    return true;
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

    // Pin the egress NIC. A failure here is not fatal — an abort that leaves on an unknown
    // interface still beats no abort at all — but it must be visible.
    if (!fsw::net::bindToDaqInterface(sock, bind_address_, "AbortBroadcaster"))
        std::cerr << "[AbortBroadcaster] continuing unpinned — the broadcast may leave on the "
                     "wrong interface"
                  << std::endl;

    // A blocked sendto here would stall the abort itself. Bound it: a broadcast that cannot be
    // queued within 100 ms is a lost repeat, not a reason to stop sending the others.
    struct timeval tv{.tv_sec = 0, .tv_usec = 100000};
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port_);
    dest.sin_addr = dest_addr_;

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
        std::cout << "[AbortBroadcaster] Sent " << type_name << " broadcast (" << dest_ip_ << ":"
                  << port_ << ", " << delivered << "/" << kBroadcastRepeats << " repeats)"
                  << std::endl;
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
