#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "comms/messages/control/ControllerMessages.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"
#include "control/ControllerService.hpp"
#include "control/RobustDDPController.hpp"
#include "daq-protocol.h"
#include "db.hpp"
#include "elodin/ElodinClient.hpp"
#include "elodin/SendMsg.hpp"
#include "net/DaqInterface.hpp"

using namespace vtable;
using namespace vtable::builder;

namespace fsw {
namespace control {

// ═══════════════════════════════════════════════════════════════════════
//  PWM Packet Format (matches combined_gui.py EXACTLY)
//
//  Header:  packet_type (u8) = 10
//           version     (u8) = DIABLO_COMMS_VERSION
//           timestamp   (u32 LE) = ms since epoch & 0xFFFFFFFF
//  Body:    num_commands (u8)
//  Per-cmd: actuator_id  (u8)
//           duration_ms  (u32 LE)
//           duty_cycle   (float32 LE)
//           frequency    (float32 LE)
//
//  Total for 1 command: 6 + 1 + 13 = 20 bytes
// ═══════════════════════════════════════════════════════════════════════

static constexpr uint8_t PACKET_TYPE_PWM = 10;
static constexpr size_t HEADER_SIZE = 6;  // <BBI>
static constexpr size_t BODY_SIZE = 1;    // <B> num_commands
static constexpr size_t CMD_SIZE = 13;    // <BIff>
static constexpr size_t SINGLE_CMD_PACKET_SIZE = HEADER_SIZE + BODY_SIZE + CMD_SIZE;    // 20
static constexpr size_t DUAL_CMD_PACKET_SIZE = HEADER_SIZE + BODY_SIZE + CMD_SIZE * 2;  // 33

// ═══════════════════════════════════════════════════════════════════════
//  PWM COMMAND SENDING  (matches combined_gui.py EXACTLY)
// ═══════════════════════════════════════════════════════════════════════

bool ControllerService::sendPWMCommand(const PWMTarget& target, float duty_cycle, float frequency,
                                       uint32_t duration_ms) {
    if (udp_socket_fd_ < 0)
        return false;
    if (!target.resolved())
        return false;
    const uint8_t channel = target.channel;

    // Build packet — total 20 bytes for single command
    uint8_t packet[SINGLE_CMD_PACKET_SIZE];
    size_t offset = 0;

    // ── Header: <BBI> ──────────────────────────────────────────────────
    packet[offset++] = PACKET_TYPE_PWM;  // packet_type = 10
    packet[offset++] = DIABLO_COMMS_VERSION;

    // Timestamp: milliseconds since epoch, truncated to uint32
    auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::system_clock::now().time_since_epoch())
                      .count();
    uint32_t ts = static_cast<uint32_t>(now_ms & 0xFFFFFFFF);
    std::memcpy(&packet[offset], &ts, 4);  // LE on x86
    offset += 4;

    // ── Body: <B> num_commands ──────────────────────────────────────────
    packet[offset++] = 1;  // Single command

    // ── Command: <BIff> ────────────────────────────────────────────────
    packet[offset++] = channel;                     // actuator_id
    std::memcpy(&packet[offset], &duration_ms, 4);  // duration_ms (LE)
    offset += 4;
    std::memcpy(&packet[offset], &duty_cycle, 4);  // duty_cycle (float LE)
    offset += 4;
    std::memcpy(&packet[offset], &frequency, 4);  // frequency (float LE)
    offset += 4;

    // Sanity check
    if (offset != SINGLE_CMD_PACKET_SIZE) {
        std::cerr << "[ControllerService] ❌ Packet build error: wrote " << offset
                  << " bytes, expected " << SINGLE_CMD_PACKET_SIZE << std::endl;
        return false;
    }

    // ── Send via UDP ───────────────────────────────────────────────────
    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(pwm_config_.actuator_port);
    if (inet_pton(AF_INET, target.board_ip.c_str(), &dest.sin_addr) != 1) {
        std::cerr << "[ControllerService] ❌ Invalid actuator IP: " << target.board_ip << std::endl;
        return false;
    }

    ssize_t sent = sendto(udp_socket_fd_, packet, SINGLE_CMD_PACKET_SIZE, 0,
                          reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));

    if (sent != static_cast<ssize_t>(SINGLE_CMD_PACKET_SIZE)) {
        std::cerr << "[ControllerService] ❌ sendto failed: " << strerror(errno) << " (sent "
                  << sent << "/" << SINGLE_CMD_PACKET_SIZE << ")" << std::endl;
        return false;
    }

    return true;
}

bool ControllerService::sendPWMCommands(const PWMTarget& t1, float duty1, const PWMTarget& t2,
                                        float duty2, float frequency, uint32_t duration_ms) {
    if (udp_socket_fd_ < 0)
        return false;
    // One packet, one destination — the caller must have checked both targets share a board.
    if (!t1.resolved() || !t2.resolved() || t1.board_ip != t2.board_ip)
        return false;
    const uint8_t channel1 = t1.channel;
    const uint8_t channel2 = t2.channel;

    // Actuator ids are 1-based, so 0 is the "unresolved" marker controller_main leaves behind when
    // a PWM role is missing from [actuator_roles]. Refusing here is belt and braces next to the
    // disabled fire gate: whatever else goes wrong, a packet is never addressed to channel 0 —
    // and, more to the point, never to a guessed channel that belongs to some other valve.
    if (channel1 == 0 || channel2 == 0)
        return false;

    uint8_t packet[DUAL_CMD_PACKET_SIZE];
    size_t offset = 0;

    packet[offset++] = PACKET_TYPE_PWM;
    packet[offset++] = DIABLO_COMMS_VERSION;
    auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::system_clock::now().time_since_epoch())
                      .count();
    uint32_t ts = static_cast<uint32_t>(now_ms & 0xFFFFFFFF);
    std::memcpy(&packet[offset], &ts, 4);
    offset += 4;

    packet[offset++] = 2;  // num_commands

    packet[offset++] = channel1;
    std::memcpy(&packet[offset], &duration_ms, 4);
    offset += 4;
    std::memcpy(&packet[offset], &duty1, 4);
    offset += 4;
    std::memcpy(&packet[offset], &frequency, 4);
    offset += 4;

    packet[offset++] = channel2;
    std::memcpy(&packet[offset], &duration_ms, 4);
    offset += 4;
    std::memcpy(&packet[offset], &duty2, 4);
    offset += 4;
    std::memcpy(&packet[offset], &frequency, 4);
    offset += 4;

    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(pwm_config_.actuator_port);
    if (inet_pton(AF_INET, t1.board_ip.c_str(), &dest.sin_addr) != 1)
        return false;

    ssize_t sent = sendto(udp_socket_fd_, packet, DUAL_CMD_PACKET_SIZE, 0,
                          reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
    return sent == static_cast<ssize_t>(DUAL_CMD_PACKET_SIZE);
}

void ControllerService::sendActuationPWM(const RobustDDPController::ActuationCommand& act) {
    if (!act.valid)
        return;

    float duty_F = static_cast<float>(std::max(0.0, std::min(1.0, act.duty_F)));
    float duty_O = static_cast<float>(std::max(0.0, std::min(1.0, act.duty_O)));

    // Same board → one packet, so both valves are commanded by a single datagram exactly as
    // before. Different boards → two, because a datagram has one destination; the two commands
    // are then no longer simultaneous, which is a property of the rig's wiring rather than a
    // choice this code gets to make. Neither branch can address an unresolved target: the send
    // helpers reject those, and the gate is disabled at startup anyway.
    const bool same_board = pwm_config_.fuel.resolved() && pwm_config_.ox.resolved() &&
                            pwm_config_.fuel.board_ip == pwm_config_.ox.board_ip;
    if (same_board) {
        sendPWMCommands(pwm_config_.fuel, duty_F, pwm_config_.ox, duty_O, pwm_config_.frequency_hz,
                        pwm_config_.duration_ms);
    } else {
        sendPWMCommand(pwm_config_.fuel, duty_F, pwm_config_.frequency_hz, pwm_config_.duration_ms);
        sendPWMCommand(pwm_config_.ox, duty_O, pwm_config_.frequency_hz, pwm_config_.duration_ms);
    }
}

}  // namespace control
}  // namespace fsw
