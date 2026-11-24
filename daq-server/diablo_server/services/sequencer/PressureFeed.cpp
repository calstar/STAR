#include "control/PressureFeed.hpp"

#include <iostream>
#include <set>

#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "config/SensorTables.hpp"
#include "elodin/ElodinClient.hpp"
#include "elodin/SubscriptionTracker.hpp"

namespace sequencer {

namespace {
/** Long enough that the loop is not spinning, short enough that stop() is prompt. */
constexpr int kRecvTimeoutMs = 200;
constexpr int kReconnectBackoffMs = 200;

/**
 * How long a refused subscription waits before it is asked for again.
 *
 * On a cold start a subscription is refused routinely: the sequencer and the calibration service
 * come up together, and whichever loses the race subscribes to a calibrated PT table before
 * calibration_service has registered its VTable. Measured on the stand 2026-09-16: PressureFeed
 * subscribed at 16:45:08.348, the calibrated VTables were registered at 16:45:08.494 — 146 ms
 * later. The DB answered "invalid msg id" and, before any retry existed, the feed stayed blind
 * for the life of the process.
 *
 * Only a REFUSED subscription is asked for again, and the refusal names it: every subscription
 * goes out under its own request id, which the DB echoes in its ErrorResponse
 * (SubscriptionTracker, as calibration_service does). The previous rule — re-subscribe, every
 * second, any table that has delivered nothing — rested on "a table that has delivered nothing
 * cannot be duplicated", which is false for a table the DB ACCEPTED whose board is off: each
 * re-send spawned one more stream task inside elodin-db (~3,600 an hour per silent table, D-PF),
 * and once the board came up the feed received every row that many times.
 */
constexpr int kRefusedRetryMs = 1000;
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
        role_by_table_.clear();
        readings_.clear();
        for (const auto& role : roles) {
            const auto ref = fsw::config::find_pt_role(cfg, role);
            if (!ref) {
                // A script naming this was already refused at load, so this is belt and braces.
                std::cerr
                    << "[PressureFeed] \"" << role
                    << "\" is not declared by any enabled PT board or T7 PT input — not subscribed"
                    << std::endl;
                continue;
            }
            role_by_table_[ref->table()] = role;
            std::cout << "[PressureFeed] \"" << role << "\" -> "
                      << (ref->t7 ? "LabJack T7 " : "board ") << int(ref->board_number)
                      << (ref->t7 ? " AIN " : " ch ") << ref->channel << " (table 0x" << std::hex
                      << int(ref->table_hi) << ",0x" << int(ref->table_lo) << std::dec << ")"
                      << std::endl;
        }
        if (role_by_table_.empty())
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
    fsw::elodin::SubscriptionTracker tracker{std::chrono::milliseconds(kRefusedRetryMs)};
    /** Say "refused" once per table, not once a second while its publisher is away. */
    std::set<std::pair<uint8_t, uint8_t>> refusal_logged;

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
                for (const auto& [id, role] : role_by_table_)
                    tables.push_back(id);
            }
            // Re-subscribed on EVERY reconnect. The VTables live in the db process, so a
            // reconnection that skips this comes back permanently silent — connected, reading
            // nothing, with no error to show for it. A new connection starts with no stream
            // tasks, so every table is sent afresh under a fresh request id.
            tracker.reset();
            refusal_logged.clear();
            bool ok = true;
            for (const auto& t : tables)
                ok = client.subscribe_table(t.first, t.second, tracker.assign(t)) && ok;
            if (!ok) {
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

        // Ask again for exactly the tables the DB refused, once their wait is over. An accepted
        // table is never re-sent, however quiet: its stream task already exists in the db.
        for (const auto& t : tracker.due(std::chrono::steady_clock::now()))
            client.subscribe_table(t.first, t.second, tracker.assign(t));

        uint8_t buf[4096];
        const ssize_t n = client.read_packet(buf, sizeof(buf));
        if (n < 0) {
            client.disconnect();
            continue;
        }
        if (n < 8)
            continue;  // receive timeout

        if (fsw::elodin::is_error_response(buf, static_cast<size_t>(n))) {
            const auto t = tracker.rejected(buf[7], std::chrono::steady_clock::now());
            if ((t.first != 0 || t.second != 0) && refusal_logged.insert(t).second)
                std::cout << "[PressureFeed] DB refused the subscription to [0x" << std::hex
                          << int(t.first) << ",0x" << int(t.second) << std::dec
                          << "] (not registered yet) — asking again every " << kRefusedRetryMs
                          << " ms until its publisher registers it" << std::endl;
            continue;
        }

        // Header: len(4) ty(1) id_hi(1) id_lo(1) req_id(1) — EIGHT bytes. The dead
        // PressureStateMachine uses twelve and reads a float four bytes past the one it wants.
        const uint8_t type_hi = buf[5];
        const uint8_t type_lo = buf[6];

        std::string role;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            auto it = role_by_table_.find({type_hi, type_lo});
            if (it == role_by_table_.end())
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
    for (const auto& [id, r] : role_by_table_) {
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
    for (const auto& [id, role] : role_by_table_)
        out.push_back(role);
    return out;
}

}  // namespace sequencer
