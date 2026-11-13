/**
 * A fake actuator board: binds the actuator command UDP port on loopback and records what was
 * actually sent, and when.
 *
 * This is the only thing that can answer "did the valve move when we said it would". Every other
 * way of testing the delay feature measures a clock somewhere in the sequencer, which is how a
 * staggered send could be shadowed by an unstaged one for as long as it was: the arithmetic was
 * right and the commands still went out together. Assert on the wire.
 *
 * Shared by test_actuator_delays (the mechanism) and test_hold_rules (the caller).
 */
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

#include "DiabloPacketUtils.h"

namespace daqtest {

using Clock = std::chrono::steady_clock;

/** One received command burst: when it arrived (ms since the listener started) and what it said. */
struct Burst {
    long long at_ms;
    /** Channels the batch carried. */
    std::set<uint8_t> channels;
    /** channel -> commanded hardware state (1 = energised; for an NC valve that is OPEN). */
    std::map<uint8_t, uint8_t> state;
};

/** Collects UDP actuator packets, folding the 3x retransmit of one batch into a single burst. */
class BoardListener {
public:
    explicit BoardListener(uint16_t port) : port_(port) {
    }
    ~BoardListener() {
        stop();
    }

    bool start() {
        sock_ = socket(AF_INET, SOCK_DGRAM, 0);
        if (sock_ < 0)
            return false;
        int reuse = 1;
        setsockopt(sock_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        struct sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port_);
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
        if (bind(sock_, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
            close(sock_);
            sock_ = -1;
            return false;
        }
        struct timeval tv{.tv_sec = 0, .tv_usec = 20000};
        setsockopt(sock_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        running_ = true;
        t0_ = Clock::now();
        thread_ = std::thread([this]() {
            run();
        });
        return true;
    }

    void stop() {
        if (!running_.exchange(false))
            return;
        if (thread_.joinable())
            thread_.join();
        if (sock_ >= 0) {
            close(sock_);
            sock_ = -1;
        }
    }

    std::vector<Burst> bursts() const {
        std::lock_guard<std::mutex> lk(mutex_);
        return bursts_;
    }

private:
    void run() {
        uint8_t buf[1024];
        while (running_) {
            ssize_t n = recv(sock_, buf, sizeof(buf), 0);
            if (n <= 0)
                continue;
            daq::PacketHeader header;
            std::vector<daq::ActuatorCommand> cmds;
            if (!daq::parse_actuator_command_packet(buf, static_cast<size_t>(n), header, cmds))
                continue;
            Burst b{};
            for (const auto& c : cmds) {
                b.channels.insert(c.actuator_id);
                b.state[c.actuator_id] = c.actuator_state;
            }
            b.at_ms =
                std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0_).count();

            std::lock_guard<std::mutex> lk(mutex_);
            // The same batch is retransmitted 3x ~1 ms apart; fold identical content arriving
            // within 50 ms into one burst so assertions talk about batches, not packets. Compared
            // on the full channel->state map, not just the channel set: two bursts carrying the
            // same channels with opposite commands are two events, not a retransmit.
            if (!bursts_.empty() && bursts_.back().state == b.state &&
                b.at_ms - bursts_.back().at_ms < 50)
                continue;
            bursts_.push_back(std::move(b));
        }
    }

    uint16_t port_;
    int sock_ = -1;
    std::atomic<bool> running_{false};
    std::thread thread_;
    mutable std::mutex mutex_;
    std::vector<Burst> bursts_;
    Clock::time_point t0_;
};

/** When `ch` was first commanded to `hw` at or after `after_ms`. -1 if it never was. */
inline long long firstCommand(const std::vector<Burst>& bursts, uint8_t ch, uint8_t hw,
                              long long after_ms = -1) {
    for (const auto& b : bursts) {
        if (b.at_ms < after_ms)
            continue;
        auto it = b.state.find(ch);
        if (it != b.state.end() && it->second == hw)
            return b.at_ms;
    }
    return -1;
}

}  // namespace daqtest
