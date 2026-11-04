#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "config/Config.hpp"

namespace sequencer {

/**
 * Live calibrated pressures, by ROLE NAME, for the sequencer.
 *
 * The sequencer is otherwise pressure-blind — its only recv() is the controller's FIRE ack, and its
 * ElodinClient is publish-only. This is the one thing that reads.
 *
 * ── Why it is keyed by role and not by channel ────────────────────────────────────────────────
 *
 * ControllerService keys its measurements by channel number, and that is how its `P_copv` came to
 * be assigned from channel 6 — which on this rig is "GN2 Regulated", the regulated downstream
 * pressure, not the COPV at all. Its subscriber also filters the table id to board 1, which
 * silently drops every sensor on PT board 2, "GN2 High" included. Resolving each role through
 * fsw::config::find_pt_role makes both mistakes unrepresentable: there is no range filter to get
 * wrong, because the table id is computed from the role.
 *
 * ── Why a reading can be refused ──────────────────────────────────────────────────────────────
 *
 * A PT whose calibration model is "cubic" with no captured points publishes a smooth, plausible
 * 0.0 PSI with calibration_status = 0. A script that reads that for a COPV and takes 90% of it
 * computes a target of zero — and then does nothing at all, successfully, while an operator
 * watches the state enter and cleanly exit believing the tank came up to pressure. A stale reading
 * is the same hazard from the other direction: a press loop cycling a valve against a number that
 * stopped moving. Both are refused rather than returned.
 */
class PressureFeed {
public:
    struct Reading {
        double psi = 0.0;
        uint8_t cal_status = 0;
        std::chrono::steady_clock::time_point at{};
    };

    /** Why a role could not be read. Reported so a refusal can say which sensor and why. */
    enum class Status {
        Ok,
        NotSubscribed,  // no script asked for this role, or config does not declare it
        NoReading,      // subscribed, nothing has arrived yet
        Stale,
        Uncalibrated,
    };

    PressureFeed() = default;
    ~PressureFeed();

    PressureFeed(const PressureFeed&) = delete;
    PressureFeed& operator=(const PressureFeed&) = delete;

    /**
     * Subscribe to exactly the roles given, and nothing else.
     *
     * Elodin has no wildcard — "every subscriber must name what it consumes" — so the list comes
     * from the union of every loaded script's pressure() slugs. A role that no script reads costs
     * no traffic, and with no roles at all the thread never starts.
     *
     * Safe to call once, at config load. Roles that config cannot resolve to a board+channel are
     * reported and skipped; a script naming one was already refused at load.
     */
    void start(const fsw::config::Config& cfg, const std::vector<std::string>& roles,
               const std::string& host, uint16_t port);

    void stop();

    /** @return Ok and fills `psi` only when the reading may be acted on. */
    Status read(const std::string& role, double& psi) const;

    /** Human phrasing for a refusal, e.g. "GN2 High has no calibrated reading". */
    static std::string explain(const std::string& role, Status s);

    /** Roles this feed is subscribed to, for diagnostics. */
    std::vector<std::string> subscribedRoles() const;

    /** How old a reading may be and still be acted on. */
    static constexpr int kMaxAgeMs = 1000;

private:
    void runLoop(std::string host, uint16_t port);

    std::thread thread_;
    std::atomic<bool> running_{false};

    mutable std::mutex mtx_;
    std::map<std::string, Reading> readings_;
    /** Elodin table low byte -> canonical role name, built once from config. */
    std::map<uint8_t, std::string> role_by_table_lo_;
};

}  // namespace sequencer
