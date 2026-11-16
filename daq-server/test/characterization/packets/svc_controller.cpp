// Test-only window into ControllerService's hand-rolled PWM packet builders, which are private
// members that build and send in one step. Every header ControllerService.hpp depends on is
// included first, so the access override below applies to that one class declaration only; the
// object layout is unchanged. The packets are captured on a loopback UDP socket the test owns.
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "control/ControllerLUT.hpp"
#include "control/RobustDDPController.hpp"
#include "elodin/ElodinClient.hpp"

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wkeyword-macro"
#endif
#define private public
#include "control/ControllerService.hpp"
#undef private
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

namespace charsvc {

/** Sends one single-command and one dual-command PWM packet to 127.0.0.1:port from `fd`. */
std::vector<bool> controller_send_pwm(int fd, uint16_t port) {
    fsw::control::ControllerService svc;
    svc.pwm_config_.actuator_port = port;
    svc.udp_socket_fd_ = fd;
    fsw::control::ControllerService::PWMTarget fuel{"127.0.0.1", 3, "Fuel Press"};
    fsw::control::ControllerService::PWMTarget ox{"127.0.0.1", 8, "LOX Press"};
    fsw::control::ControllerService::PWMTarget unresolved{"127.0.0.1", 0, "nothing"};
    std::vector<bool> r;
    r.push_back(svc.sendPWMCommand(fuel, 0.25f, 10.0f, 500u));
    r.push_back(svc.sendPWMCommands(fuel, 0.25f, ox, 0.75f, 20.0f, 1000u));
    r.push_back(svc.sendPWMCommands(fuel, 0.5f, unresolved, 0.5f, 20.0f, 1000u));
    svc.udp_socket_fd_ = -1;  // the test owns the socket
    return r;
}

}  // namespace charsvc
