#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "comms/CommsMessage.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "control/SequencerService.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "net/DaqInterface.hpp"

namespace sequencer {

// ─────────────────────────────────────────────────────────────────────────────
// Elodin VTable IDs
//   [0x50, 0x00] = 0x5000 — SequencerState (new: state + allowed transitions + debug_mode)
//   [0x43, 0x00] = 0x4300 — StateTransition (legacy: matches Node.js backend publication)
// ─────────────────────────────────────────────────────────────────────────────
static constexpr uint16_t VTABLE_SEQUENCER_STATE = 0x5000;
static constexpr uint16_t VTABLE_STATE_TRANSITION = 0x4300;

// SequencerState: u64 @0 | u8 @8 | pad[3] @9 (align u32) | allowed_bitmask u32 @12 | debug_mode u8
// @16 — 17 bytes
using SequencerStateMsg =
    comms::CommsMessage<uint64_t, uint8_t, std::array<uint8_t, 3>, uint32_t, uint8_t>;

// StateTransition message: timestamp_ns(u64) | from_state(u8) | to_state(u8) | reason(u8)
using StateTransitionMsg = comms::CommsMessage<uint64_t, uint8_t, uint8_t, uint8_t>;

static uint64_t now_ns() {
    using namespace std::chrono;
    return static_cast<uint64_t>(
        duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count());
}

void SequencerService::publishState() {
    if (!elodin_.is_connected())
        return;

    const State s = current_state_.load();
    uint32_t mask = state_machine_.allowedBitmask(s);

    // Clear every refused state out of the advertised set. A state whose script did not load can
    // never be entered for the life of this run, so nothing should ever offer it as reachable —
    // the refusal is carried in data the GUI already receives rather than by a UI check that can
    // be forgotten. The reason text reaches the panel separately, over the SCRIPTS command, so an
    // operator can tell "broken" from "not reachable from here".
    std::vector<std::pair<State, std::vector<std::string>>> sensor_states;
    {
        std::lock_guard<std::mutex> lk(config_mutex_);
        for (const auto& [st, why] : refused_states_) {
            const uint8_t id = static_cast<uint8_t>(st);
            if (id < 32)
                mask &= ~(1u << id);
        }
        for (const auto& [st, ds] : dynamic_states_)
            if (!ds.pressure_roles.empty())
                sensor_states.emplace_back(st, ds.pressure_roles);
    }

    // Also clear any state the sensor gate would refuse RIGHT NOW. Unlike a load refusal this is
    // not fixed for the run — a feed can arrive late or go stale — so the mask has to be
    // recomputed on every publish, which is what makes the button grey out and come back on its
    // own. Without this the one refusal an operator actually hits was invisible until they
    // pressed it: the gate is evaluated per press, so nothing advertised it in advance.
    //
    // Same check doTransitionTo runs, deliberately: two different notions of "enterable" would
    // give a button that is grey and works, or lit and refuses.
    for (const auto& [st, roles] : sensor_states) {
        const uint8_t id = static_cast<uint8_t>(st);
        if (id >= 32)
            continue;
        for (const auto& role : roles) {
            double psi = 0.0;
            if (pressure_feed_.read(role, psi) != PressureFeed::Status::Ok) {
                mask &= ~(1u << id);
                break;
            }
        }
    }

    const uint8_t dbg = debug_mode_ ? 1u : 0u;

    SequencerStateMsg msg(now_ns(), static_cast<uint8_t>(s), std::array<uint8_t, 3>{0, 0, 0}, mask,
                          dbg);
    if (!elodin_.publish(VTABLE_SEQUENCER_STATE, msg))
        std::cerr << "[SequencerService] Failed to publish sequencer state to Elodin" << std::endl;
}

void SequencerService::publishStateTransition(State from, State to) {
    if (!elodin_.is_connected())
        return;

    StateTransitionMsg msg(now_ns(), static_cast<uint8_t>(from), static_cast<uint8_t>(to), 0);
    elodin_.publish(VTABLE_STATE_TRANSITION, msg);
}

bool SequencerService::tryConnectElodin() {
    if (!elodin_.connect(elodin_host_, elodin_port_))
        return false;
    std::cout << "[SequencerService] Connected to Elodin at " << elodin_host_ << ":" << elodin_port_
              << std::endl;
    // Every one of these must run on a RECONNECT too, not just the first connect — the VTables
    // live in the db process, so a db restart loses them.
    //
    // The board list comes from the snapshot taken at init(), NOT from a fresh read of
    // config_path_. This used to re-parse config.toml on every reconnect, and the retry thread
    // reconnects on any db restart — so a db blip mid-run would rebuild the actuator tables from
    // whatever happened to be on disk at that moment. Config is applied once, at session start;
    // a process that has already booted keeps the config it booted with.
    fsw::elodin::DatabaseConfig::register_non_sensor_tables(elodin_, actuator_boards_);
    if (!ball_valve_boards_.empty())
        fsw::elodin::DatabaseConfig::register_ball_valve_cmd_tables(elodin_, ball_valve_boards_);
    actuator_commander_.setElodinClient(&elodin_);
    actuator_commander_.publishInitialState();
    return true;
}

void SequencerService::startElodinRetry() {
    if (elodin_retry_thread_.joinable())
        return;
    elodin_retry_stop_ = false;
    elodin_retry_thread_ = std::thread([this]() {
        while (!elodin_retry_stop_) {
            for (int i = 0; i < kElodinRetrySeconds * 10 && !elodin_retry_stop_; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (elodin_retry_stop_ || elodin_.is_connected())
                continue;
            tryConnectElodin();
        }
    });
}

void SequencerService::stopElodinRetry() {
    elodin_retry_stop_ = true;
    if (elodin_retry_thread_.joinable())
        elodin_retry_thread_.join();
}

}  // namespace sequencer
