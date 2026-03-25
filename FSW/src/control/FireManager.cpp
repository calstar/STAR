#include "control/FireManager.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <iostream>

namespace sequencer {

FireManager::FireManager(uint32_t fire_duration_ms, uint32_t fire_extended_ms)
    : fire_duration_ms_(fire_duration_ms),
      fire_extended_ms_(fire_extended_ms),
      current_duration_ms_(fire_duration_ms) {}

FireManager::~FireManager() {
    stop();
}

void FireManager::setControllerEndpoint(const std::string& host, uint16_t port) {
    controller_host_ = host;
    controller_port_ = port;
}

// ─────────────────────────────────────────────────────────────────────────────
void FireManager::start(std::function<void()> on_expire) {
    stop(); // ensure any previous timer is cleaned up

    on_expire_            = std::move(on_expire);
    cancel_               = false;
    current_duration_ms_  = fire_duration_ms_;
    active_               = true;

    notifyController("FIRE_START\n");
    std::cout << "[FireManager] FIRE started (" << fire_duration_ms_ << " ms)" << std::endl;

    timer_thread_ = std::thread([this]() { runTimer(); });
}

void FireManager::stop() {
    if (!active_) return;
    cancel_ = true;
    active_ = false;
    if (timer_thread_.joinable()) timer_thread_.join();
    notifyController("FIRE_STOP\n");
    std::cout << "[FireManager] FIRE stopped" << std::endl;
}

void FireManager::extend() {
    if (!active_) return;
    current_duration_ms_ = fire_extended_ms_;
    cancel_              = true; // signal the timer to restart
    // Timer thread re-reads current_duration_ms_ after the cancel signal
    std::cout << "[FireManager] FIRE extended to " << fire_extended_ms_ << " ms" << std::endl;
}

// ─────────────────────────────────────────────────────────────────────────────
void FireManager::runTimer() {
    while (active_) {
        cancel_                   = false;
        const uint32_t duration   = current_duration_ms_.load();
        const auto step           = std::chrono::milliseconds(50);
        uint32_t elapsed_ms       = 0;

        while (active_ && !cancel_ && elapsed_ms < duration) {
            std::this_thread::sleep_for(step);
            elapsed_ms += 50;
        }

        if (!active_) return;      // stop() was called

        if (cancel_) {
            // extend() was called — restart with the new duration
            std::cout << "[FireManager] Timer restarted (extended)" << std::endl;
            continue;
        }

        // Timer expired naturally
        std::cout << "[FireManager] Fire timer expired — transitioning to ARMED" << std::endl;
        active_ = false;
        notifyController("FIRE_STOP\n");
        if (on_expire_) on_expire_();
        return;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
void FireManager::notifyController(const std::string& msg) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) return;

    struct timeval tv{ .tv_sec = 1, .tv_usec = 0 };
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    struct sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port   = htons(controller_port_);
    if (inet_pton(AF_INET, controller_host_.c_str(), &dest.sin_addr) != 1) {
        close(sock);
        return;
    }

    if (connect(sock, reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest)) == 0)
        send(sock, msg.c_str(), msg.size(), 0);
    else
        std::cerr << "[FireManager] Cannot connect to controller_service at "
                  << controller_host_ << ":" << controller_port_ << std::endl;

    close(sock);
}

} // namespace sequencer
