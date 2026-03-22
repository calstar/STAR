#include "control/AbortBroadcaster.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>

// daqv2comms — PacketHeader + PacketType + millis()
#include "DiabloPackets.h"
#include "DiabloEnums.h"
#include "Arduino.h"

namespace sequencer {

AbortBroadcaster::AbortBroadcaster(uint16_t port, uint32_t abort_done_delay_ms)
    : port_(port), abort_done_delay_ms_(abort_done_delay_ms) {}

AbortBroadcaster::~AbortBroadcaster() {
    done_thread_running_ = false;
    if (done_thread_.joinable()) done_thread_.join();
}

// ─────────────────────────────────────────────────────────────────────────────
void AbortBroadcaster::sendPacket(uint8_t packet_type_byte) {
    Diablo::PacketHeader hdr{};
    hdr.packet_type = static_cast<Diablo::PacketType>(packet_type_byte);
    hdr.version     = 0; // DIABLO_COMMS_VERSION
    hdr.timestamp   = millis();

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "[AbortBroadcaster] socket() failed" << std::endl;
        return;
    }

    int broadcast = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast));

    struct sockaddr_in dest{};
    dest.sin_family      = AF_INET;
    dest.sin_port        = htons(port_);
    dest.sin_addr.s_addr = INADDR_BROADCAST;

    ssize_t sent = sendto(sock, &hdr, sizeof(hdr), 0,
                          reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
    close(sock);

    const char* type_name =
        (packet_type_byte == 7) ? "ABORT" :
        (packet_type_byte == 8) ? "ABORT_DONE" :
        (packet_type_byte == 9) ? "CLEAR_ABORT" : "UNKNOWN";

    if (sent == static_cast<ssize_t>(sizeof(hdr)))
        std::cout << "[AbortBroadcaster] Sent " << type_name
                  << " broadcast (port " << port_ << ")" << std::endl;
    else
        std::cerr << "[AbortBroadcaster] sendto(" << type_name << ") failed" << std::endl;
}

// ─────────────────────────────────────────────────────────────────────────────
void AbortBroadcaster::triggerAbort() {
    // Immediate ABORT
    sendPacket(static_cast<uint8_t>(Diablo::PacketType::ABORT));

    // Cancel any previously scheduled ABORT_DONE thread
    done_thread_running_ = false;
    if (done_thread_.joinable()) done_thread_.join();

    // Schedule ABORT_DONE
    done_thread_running_ = true;
    done_thread_ = std::thread([this]() { waitAndSendAbortDone(); });
}

void AbortBroadcaster::waitAndSendAbortDone() {
    const auto delay = std::chrono::milliseconds(abort_done_delay_ms_);
    const auto step  = std::chrono::milliseconds(50);
    auto elapsed     = std::chrono::milliseconds(0);

    while (done_thread_running_ && elapsed < delay) {
        std::this_thread::sleep_for(step);
        elapsed += step;
    }
    if (done_thread_running_)
        sendPacket(static_cast<uint8_t>(Diablo::PacketType::ABORT_DONE));
}

void AbortBroadcaster::sendClearAbort() {
    sendPacket(static_cast<uint8_t>(Diablo::PacketType::CLEAR_ABORT));
}

} // namespace sequencer
