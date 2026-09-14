#include "control/PressureFeed.hpp"

#include <iostream>

#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "config/SensorTables.hpp"
#include "elodin/ElodinClient.hpp"

namespace sequencer {

namespace {
/** Long enough that the loop is not spinning, short enough that stop() is prompt. */
constexpr int kRecvTimeoutMs = 200;
constexpr int kReconnectBackoffMs = 200;
}  // namespace

PressureFeed::~PressureFeed() {
    stop();
}

void PressureFeed::start(const fsw::config::Config& cfg, const std::vector<std::string>& roles,
                         const std::string& host, uint16_t port) {
    stop();
    if (roles.empty())
        return;  // nothing reads a pressure — do not open a socket at all

    {
        std::lock_guard<std::mutex> lk(mtx_);
        role_by_table_lo_.clear();
        readings_.clear();
        for (const auto& role : roles) {
            const auto ref = fsw::config::find_pt_role(cfg, role);
            if (!ref) {
                // A script naming this was already refused at load, so this is belt and braces.
                std::cerr << "[PressureFeed] \"" << role
                          << "\" is not declared by any enabled PT board — not subscribed"
                          << std::endl;
                continue;
            }
            role_by_table_lo_[ref->table_lo] = role;
            std::cout << "[PressureFeed] \"" << role << "\" -> board " << int(ref->board_number)
                      << " ch " << ref->channel << " (table 0x20,0x" << std::hex
                      << int(ref->table_lo) << std::dec << ")" << std::endl;
        }
        if (role_by_table_lo_.empty())
            return;
    }

    running_ = true;
    thread_ = std::thread(&PressureFeed::runLoop, this, host, port);
}

void PressureFeed::stop() {
    running_ = false;
    if (thread_.joinable())
        thread_.join();
}

void PressureFeed::runLoop(std::string host, uint16_t port) {
    fsw::elodin::ElodinClient client;

    // A separate client from the sequencer's publisher, on purpose: ElodinClient's publish_mutex_
    // does not guard the read path, so reading and publishing through one object from two threads
    // is unprotected. ControllerService splits them for the same reason.
    while (running_) {
        if (!client.is_connected()) {
            if (!client.connect(host, port)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(kReconnectBackoffMs));
                continue;
            }
            std::vector<std::pair<uint8_t, uint8_t>> tables;
            {
                std::lock_guard<std::mutex> lk(mtx_);
                for (const auto& [lo, role] : role_by_table_lo_)
                    tables.push_back({0x20, lo});
            }
            // Re-subscribed on EVERY reconnect. The VTables live in the db process, so a
            // reconnection that skips this comes back permanently silent — connected, reading
            // nothing, with no error to show for it.
            if (!client.subscribe_tables(tables)) {
                std::cerr << "[PressureFeed] subscribe failed — dropping the socket to retry"
                          << std::endl;
                client.disconnect();
                std::this_thread::sleep_for(std::chrono::milliseconds(kReconnectBackoffMs));
                continue;
            }
            // Without a receive timeout read_packet() blocks forever, and this thread could never
            // be shut down or re-subscribed.
            client.set_recv_timeout_ms(kRecvTimeoutMs);
            std::cout << "[PressureFeed] subscribed to " << tables.size()
                      << " calibrated PT table(s)" << std::endl;
        }

        uint8_t buf[4096];
        const ssize_t n = client.read_packet(buf, sizeof(buf));
        if (n < 0) {
            client.disconnect();
            continue;
        }
        if (n < 8)
            continue;  // receive timeout

        // Header: len(4) ty(1) id_hi(1) id_lo(1) req_id(1) — EIGHT bytes. The dead
        // PressureStateMachine uses twelve and reads a float four bytes past the one it wants.
        const uint8_t type_hi = buf[5];
        const uint8_t type_lo = buf[6];
        if (type_hi != 0x20)
            continue;

        std::string role;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            auto it = role_by_table_lo_.find(type_lo);
            if (it == role_by_table_lo_.end())
                continue;  // a table we did not ask for
            role = it->second;
        }

        const size_t payload_len = static_cast<size_t>(n) - 8;
        if (payload_len < comms::messages::sensor::CalibratedPTMessage::nbytes())
            continue;

        comms::messages::sensor::CalibratedPTMessage msg;
        msg.deserialize(buf + 8);

        Reading r;
        r.psi = static_cast<double>(msg.getField<3>());
        r.cal_status = msg.getField<5>();
        r.at = std::chrono::steady_clock::now();

        // Keyed by the table the packet arrived on, never by the message's own channel_id field —
        // that field is not always populated, and ControllerService carries a fallback for exactly
        // that. The table id came from the role, so it cannot name a different sensor.
        std::lock_guard<std::mutex> lk(mtx_);
        readings_[role] = r;
    }

    client.disconnect();
}

PressureFeed::Status PressureFeed::read(const std::string& role, double& psi) const {
    std::lock_guard<std::mutex> lk(mtx_);

    bool subscribed = false;
    for (const auto& [lo, r] : role_by_table_lo_) {
        if (r == role) {
            subscribed = true;
            break;
        }
    }
    if (!subscribed)
        return Status::NotSubscribed;

    auto it = readings_.find(role);
    if (it == readings_.end())
        return Status::NoReading;

    const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::steady_clock::now() - it->second.at)
                         .count();
    if (age > kMaxAgeMs)
        return Status::Stale;
    if (it->second.cal_status != 1)
        return Status::Uncalibrated;

    psi = it->second.psi;
    return Status::Ok;
}

std::string PressureFeed::explain(const std::string& role, Status s) {
    switch (s) {
        case Status::Ok:
            return role + " is readable";
        case Status::NotSubscribed:
            return role + " is not subscribed (no script reads it, or config does not declare it)";
        case Status::NoReading:
            return role + " has produced no reading yet";
        case Status::Stale:
            return role + "'s last reading is older than " + std::to_string(kMaxAgeMs) + " ms";
        case Status::Uncalibrated:
            return role +
                   " is publishing UNCALIBRATED values (a cubic model with no captured "
                   "points streams a plausible 0.0 PSI)";
    }
    return role + " cannot be read";
}

std::vector<std::string> PressureFeed::subscribedRoles() const {
    std::lock_guard<std::mutex> lk(mtx_);
    std::vector<std::string> out;
    for (const auto& [lo, role] : role_by_table_lo_)
        out.push_back(role);
    return out;
}

}  // namespace sequencer
