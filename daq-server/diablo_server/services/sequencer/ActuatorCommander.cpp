#include "control/ActuatorCommander.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>

#include "config/Config.hpp"

// daqv2comms — all packet construction goes through here
#include "DiabloPacketUtils.h"
#include "comms/CommsMessage.hpp"

namespace sequencer {

// ── Actuator commanded state [0x32, ch] — published to Elodin DB ─────────────
// Layout: u64 timestamp_ns | u8 channel_id | u8 actuator_state = 10 bytes
// No alignment issue: all post-u64 fields are u8.
using ActuatorCommandedMsg = comms::CommsMessage<uint64_t, uint8_t, uint8_t>;
static constexpr uint8_t VTABLE_ACT_CMD_HI = 0x32;

/** Elodin low byte for [0x32, lo]: (board_slot - 1) * 0x20 + local_channel; slot = board_id % 10, 0
 * → 10. */
static uint8_t actuator_elodin_low_byte(uint32_t board_id, uint8_t local_channel) {
    int bn = static_cast<int>(board_id % 10);
    if (bn == 0)
        bn = 10;
    return static_cast<uint8_t>((bn - 1) * 0x20 + local_channel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
static std::string trimVal(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

static std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), ::tolower);
    return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// load()
// ─────────────────────────────────────────────────────────────────────────────
bool ActuatorCommander::load(const std::string& config_content, const std::string& csv_path) {
    roles_.clear();
    state_actuators_.clear();

    const fsw::config::Config cfg = fsw::config::load_from_string(config_content);

    // -- Config: bind address and actuator port --
    bind_addr_ = cfg.actuator_service.bind_address;
    if (bind_addr_.empty())
        bind_addr_ = "0.0.0.0";
    actuator_port_ = cfg.network.actuator_cmd_port;

    // -- Board IP map: board_id → IP (from [boards.*]); canonical 192.168.2.N fallback --
    std::map<int, std::string> board_id_to_ip;
    for (const auto& b : cfg.boards)
        if (!b.ip.empty() && b.board_id > 0)
            board_id_to_ip[b.board_id] = b.ip;
    if (board_id_to_ip.empty())
        for (int i = 11; i <= 14; ++i)
            board_id_to_ip[i] = "192.168.2." + std::to_string(i);

    // -- Actuator roles from [actuator_roles] (channels 1..10 only) --
    for (const auto& [name, r] : cfg.actuator_roles) {
        if (r.channel < 1 || r.channel > 10)
            continue;
        ActuatorRole role;
        role.is_no = r.is_no;
        role.is_pwm = (r.kind == "PWM" || r.kind == "pwm");
        role.channel = r.channel;
        role.board_id = r.board_id;
        auto it = board_id_to_ip.find(r.board_id);
        role.board_ip =
            (it != board_id_to_ip.end()) ? it->second : "192.168.2." + std::to_string(r.board_id);
        roles_[name] = role;
    }
    std::cout << "[ActuatorCommander] Loaded " << roles_.size() << " actuator roles from config"
              << std::endl;

    // -- State→actuator CSV -- canonical source: daq-server/config/.
    // The deployed config/*.csv are generated artifacts (gitignored), written when a profile
    // is deployed. On a fresh checkout — CI, or a clone that has never started the backend —
    // they do not exist yet, so fall back to the profile that owns them. Mirrors what
    // readConfig() does for config.toml on the TypeScript side.
    const char* fallbacks[] = {
        "config/state_machine_actuators.csv",
        "../config/state_machine_actuators.csv",
        "../../config/state_machine_actuators.csv",
        "config/profiles/default/state_machine_actuators.csv",
        "../config/profiles/default/state_machine_actuators.csv",
        "../../config/profiles/default/state_machine_actuators.csv",
    };

    std::ifstream f(csv_path);
    std::string used_csv = csv_path;
    if (!f.is_open()) {
        for (const char* fb : fallbacks) {
            if (std::string(fb) == csv_path)
                continue;
            f.open(fb);
            if (f.is_open()) {
                used_csv = fb;
                break;
            }
        }
    }
    if (!f.is_open()) {
        std::cerr << "[ActuatorCommander] Cannot open state_machine_actuators.csv" << std::endl;
        return false;
    }

    std::string line;
    if (!std::getline(f, line))
        return false;

    // Header: actuator_name, State1, State2, ...
    std::vector<std::string> headers;
    {
        std::istringstream iss(line);
        std::string cell;
        while (std::getline(iss, cell, ','))
            headers.push_back(trimVal(cell));
    }

    while (std::getline(f, line)) {
        std::vector<std::string> cells;
        std::istringstream iss(line);
        std::string cell;
        while (std::getline(iss, cell, ','))
            cells.push_back(trimVal(cell));
        if (cells.empty() || cells[0].empty())
            continue;

        const std::string& act_name = cells[0];
        for (size_t col = 1; col < headers.size() && col < cells.size(); ++col) {
            if (headers[col].empty())
                continue;
            std::string val = cells[col];
            std::transform(val.begin(), val.end(), val.begin(), ::toupper);
            int pos = -1;
            if (val == "OPEN")
                pos = 1;
            else if (val == "CLOSE" || val == "CLOSED")
                pos = 0;
            if (pos < 0)
                continue;
            state_actuators_[headers[col]][act_name] = pos;
        }
    }

    // ── Per-actuator delays (same rows x columns as the positions table) ────────
    // Optional: a stand with no delays configured simply has every cell 0, and a missing file
    // leaves the map empty, which means "everything at t=0" — the behaviour before delays existed.
    state_actuator_delays_.clear();
    {
        std::string delay_csv = used_csv;
        const std::string suffix = "state_machine_actuators.csv";
        if (delay_csv.size() >= suffix.size() &&
            delay_csv.compare(delay_csv.size() - suffix.size(), suffix.size(), suffix) == 0) {
            delay_csv.replace(delay_csv.size() - suffix.size(), suffix.size(),
                              "state_machine_actuator_delays.csv");
        }
        std::ifstream df(delay_csv);
        if (df.is_open()) {
            std::string dline;
            std::vector<std::string> dheaders;
            if (std::getline(df, dline)) {
                std::istringstream iss(dline);
                std::string cell;
                while (std::getline(iss, cell, ','))
                    dheaders.push_back(trimVal(cell));
            }
            size_t nonzero = 0;
            while (std::getline(df, dline)) {
                std::vector<std::string> cells;
                std::istringstream iss(dline);
                std::string cell;
                while (std::getline(iss, cell, ','))
                    cells.push_back(trimVal(cell));
                if (cells.empty() || cells[0].empty())
                    continue;
                for (size_t col = 1; col < dheaders.size() && col < cells.size(); ++col) {
                    if (dheaders[col].empty() || cells[col].empty())
                        continue;
                    try {
                        double d = std::stod(cells[col]);
                        if (d > 0.0) {
                            state_actuator_delays_[dheaders[col]][cells[0]] = d;
                            nonzero++;
                        }
                    } catch (...) {
                        // A non-numeric cell means "no delay" rather than an error — same
                        // tolerance the positions table gives a cell that is not OPEN/CLOSE.
                    }
                }
            }
            if (nonzero)
                std::cout << "[ActuatorCommander] Loaded " << nonzero
                          << " non-zero actuator delay(s) from " << delay_csv << std::endl;
        }
    }

    loaded_ = true;
    std::cout << "[ActuatorCommander] Loaded " << state_actuators_.size() << " states from "
              << used_csv << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// findStateActuators (case-insensitive)
// ─────────────────────────────────────────────────────────────────────────────
std::map<std::string, std::map<std::string, int>>::const_iterator
ActuatorCommander::findStateActuators(const std::string& state_name) const {
    auto it = state_actuators_.find(state_name);
    if (it != state_actuators_.end())
        return it;

    const std::string lower = toLower(state_name);
    for (auto jt = state_actuators_.cbegin(); jt != state_actuators_.cend(); ++jt) {
        if (toLower(jt->first) == lower)
            return jt;
    }
    return state_actuators_.cend();
}

// ─────────────────────────────────────────────────────────────────────────────
// sendUDP — build an ActuatorCommand packet and send to board_ip:actuator_port_
// ─────────────────────────────────────────────────────────────────────────────
bool ActuatorCommander::sendUDP(const std::string& board_ip,
                                const std::vector<std::pair<uint8_t, uint8_t>>& id_state_pairs) {
    return sendBatch({{board_ip, id_state_pairs}});
}

/**
 * Send one command batch to every board, interleaving the retransmits.
 *
 * Each packet still goes out 3x ~1 ms apart so it lands in the board's UDP receive window whatever
 * its loop() rate. What changed is the ordering: round 1 to ALL boards, then round 2, then round 3,
 * instead of finishing all three rounds for board A before starting board B. The old order meant
 * every extra board added ~2 ms of skew to a state change -- with two actuator boards, board 2's
 * first packet left ~2 ms after board 1's, on every transition. Now the boards are within
 * microseconds of each other and the batch takes ~2 ms total instead of ~2 ms per board.
 *
 * One socket for the whole batch rather than one per board, since we now revisit each board 3x.
 */
bool ActuatorCommander::sendBatch(
    const std::map<std::string, std::vector<std::pair<uint8_t, uint8_t>>>& by_board) {
    if (by_board.empty())
        return true;

    // Serialize every board's packet up front so the timed rounds below do nothing but sendto().
    struct Outgoing {
        struct sockaddr_in dest;
        std::vector<uint8_t> buf;
    };
    std::vector<Outgoing> outgoing;
    outgoing.reserve(by_board.size());

    const uint32_t ts_ms =
        static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::steady_clock::now().time_since_epoch())
                                  .count() &
                              0xFFFFFFFFu);

    for (const auto& [board_ip, id_state_pairs] : by_board) {
        if (id_state_pairs.empty())
            continue;
        std::vector<daq::ActuatorCommand> cmds;
        cmds.reserve(id_state_pairs.size());
        for (const auto& [id, st] : id_state_pairs)
            cmds.push_back({id, st});

        uint8_t buf[512];
        size_t len = daq::create_actuator_command_packet(cmds, ts_ms, buf, sizeof(buf));
        if (len == 0) {
            std::cerr << "[ActuatorCommander] create_actuator_command_packet returned 0 for "
                      << board_ip << std::endl;
            continue;
        }
        Outgoing o{};
        o.dest.sin_family = AF_INET;
        o.dest.sin_port = htons(actuator_port_);
        if (inet_pton(AF_INET, board_ip.c_str(), &o.dest.sin_addr) != 1) {
            std::cerr << "[ActuatorCommander] bad board IP " << board_ip << std::endl;
            continue;
        }
        o.buf.assign(buf, buf + len);
        outgoing.push_back(std::move(o));
    }
    if (outgoing.empty())
        return false;

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0)
        return false;

    struct sockaddr_in local{};
    local.sin_family = AF_INET;
    inet_pton(AF_INET, bind_addr_.c_str(), &local.sin_addr);
    if (bind(sock, reinterpret_cast<struct sockaddr*>(&local), sizeof(local)) < 0) {
        close(sock);
        return false;
    }

    bool all_ok = true;
    for (int round = 0; round < 3; ++round) {
        for (const auto& o : outgoing) {
            ssize_t sent =
                sendto(sock, o.buf.data(), o.buf.size(), 0,
                       reinterpret_cast<const struct sockaddr*>(&o.dest), sizeof(o.dest));
            if (sent != static_cast<ssize_t>(o.buf.size()))
                all_ok = false;
        }
        if (round < 2)
            usleep(1000);
    }
    close(sock);
    return all_ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyForState — send all actuator commands for a state (one shot, batched by board)
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::applyForState(State state, bool is_transition) {
    const std::string state_name = StateMachine::name(state);
    auto it = findStateActuators(state_name);
    if (it == state_actuators_.end()) {
        std::cerr << "[ActuatorCommander] No CSV entry for state: " << state_name << std::endl;
        return;
    }

    const bool is_fire = (state == fire_state_);

    // Collected first, then split into delay stages below — a command needs its role name to look
    // up its delay, which the by-board packing throws away.
    struct PendingCmd {
        std::string role_name;
        std::string board_ip;
        uint8_t channel;
        uint8_t hw_state;
        uint8_t global_ch;
        uint8_t logical_pos;
    };
    std::vector<PendingCmd> pending;
    std::unique_lock lock(overrides_mutex_);
    for (const auto& [act_name, logical_pos] : it->second) {
        auto role_it = roles_.find(act_name);
        if (role_it == roles_.end())
            continue;
        const ActuatorRole& role = role_it->second;
        if (is_fire && role.is_pwm)
            continue;

        int pos = logical_pos;
        auto ov = manual_overrides_.find(act_name);
        if (ov != manual_overrides_.end())
            pos = ov->second;

        uint8_t hw_state = static_cast<uint8_t>(role.is_no ? (1 - pos) : pos);
        uint8_t global_ch =
            actuator_elodin_low_byte(role.board_id, static_cast<uint8_t>(role.channel));
        pending.push_back({act_name, role.board_ip, static_cast<uint8_t>(role.channel), hw_state,
                           global_ch, static_cast<uint8_t>(pos)});
    }
    lock.unlock();

    // Only an actual entry supersedes a pending schedule — the 1 Hz republish must not, or it
    // would cancel the very stages it is meant to leave alone.
    const uint64_t gen = is_transition ? ++schedule_gen_ : schedule_gen_.load();
    if (is_transition) {
        std::lock_guard<std::mutex> lk(pending_roles_mutex_);
        pending_roles_.clear();
    }

    // Split into stages by delay. On a republish (is_transition false) everything is stage 0, so
    // the settled positions go out together.
    std::map<double, std::map<std::string, std::vector<std::pair<uint8_t, uint8_t>>>> staged;
    std::map<double, std::vector<std::pair<uint8_t, uint8_t>>> staged_logical;
    for (size_t i = 0; i < pending.size(); ++i) {
        const auto& pc = pending[i];
        double d = 0.0;
        if (is_transition) {
            auto ds = state_actuator_delays_.find(state_name);
            if (ds != state_actuator_delays_.end()) {
                auto it = ds->second.find(pc.role_name);
                if (it != ds->second.end() && it->second > 0.0)
                    d = it->second;
            }
        }
        if (!is_transition) {
            std::lock_guard<std::mutex> lk(pending_roles_mutex_);
            if (pending_roles_.count(pc.role_name))
                continue;  // still waiting on its delay — leave the board holding its last position
        }
        staged[d][pc.board_ip].emplace_back(pc.channel, pc.hw_state);
        staged_logical[d].emplace_back(pc.global_ch, pc.logical_pos);
        if (d > 0.0) {
            std::lock_guard<std::mutex> lk(pending_roles_mutex_);
            pending_roles_.insert(pc.role_name);
        }
    }

    auto emit = [this, state_name](
                    const std::map<std::string, std::vector<std::pair<uint8_t, uint8_t>>>& by_ip,
                    const std::vector<std::pair<uint8_t, uint8_t>>& logical, double delay_s) {
        if (sendBatch(by_ip)) {
            size_t n = 0;
            for (const auto& [ip, c] : by_ip)
                n += c.size();
            std::cout << "[ActuatorCommander] Sent " << n << " commands for state " << state_name;
            if (delay_s > 0.0)
                std::cout << " (+" << delay_s << "s)";
            std::cout << std::endl;
        } else {
            std::cerr << "[ActuatorCommander] UDP send failed for state " << state_name
                      << std::endl;
        }
        for (const auto& [ch, pos] : logical)
            publishCommandedState(ch, pos);
    };

    // Stage 0 goes out on this thread, immediately.
    auto zero = staged.find(0.0);
    if (zero != staged.end())
        emit(zero->second, staged_logical[0.0], 0.0);

    if (staged.size() <= (zero != staged.end() ? 1u : 0u))
        return;

    // Later stages run on their own thread: a send blocks ~2 ms for the retransmits, so a pending
    // delay must not queue behind another stage's send. Detached + generation-checked, so a new
    // transition abandons it rather than landing a stale command seconds later.
    std::vector<std::pair<double, size_t>> order;
    for (const auto& [d, _] : staged)
        if (d > 0.0)
            order.emplace_back(d, 0);

    std::map<double, std::vector<std::string>> roles_by_delay;
    for (const auto& pc : pending) {
        auto ds = state_actuator_delays_.find(state_name);
        if (ds == state_actuator_delays_.end())
            continue;
        auto it = ds->second.find(pc.role_name);
        if (it != ds->second.end() && it->second > 0.0)
            roles_by_delay[it->second].push_back(pc.role_name);
    }

    std::thread([this, gen, staged, staged_logical, order, emit, roles_by_delay]() mutable {
        auto t0 = std::chrono::steady_clock::now();
        for (const auto& [delay_s, _] : order) {
            const auto due = t0 + std::chrono::microseconds(static_cast<long long>(delay_s * 1e6));
            while (std::chrono::steady_clock::now() < due) {
                if (schedule_gen_.load() != gen)
                    return;  // superseded by a newer transition
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            if (schedule_gen_.load() != gen)
                return;
            emit(staged[delay_s], staged_logical[delay_s], delay_s);
            {
                std::lock_guard<std::mutex> lk(pending_roles_mutex_);
                for (const auto& r : roles_by_delay[delay_s])
                    pending_roles_.erase(r);
            }
        }
    }).detach();
}

// ─────────────────────────────────────────────────────────────────────────────
// Continuous loop
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::startContinuousLoop(State state, bool allow_delays) {
    stopContinuousLoop();

    loop_running_ = true;
    loop_state_ = state;
    loop_thread_ = std::thread([this, state, allow_delays]() {
        std::cout << "[ActuatorCommander] Continuous loop started for state "
                  << StateMachine::name(state) << std::endl;
        // Only the FIRST pass is the state entry — that one runs the delay schedule. Every pass
        // after it is the 1 Hz republish and must send settled positions, or each tick would
        // re-arm the pending delays and nothing would ever settle.
        bool entry = allow_delays;
        while (loop_running_) {
            applyForState(loop_state_, entry);
            entry = false;
            for (int i = 0; i < 10 && loop_running_; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        std::cout << "[ActuatorCommander] Continuous loop stopped" << std::endl;
    });
}

void ActuatorCommander::stopContinuousLoop() {
    loop_running_ = false;
    if (loop_thread_.joinable())
        loop_thread_.join();
}

// ─────────────────────────────────────────────────────────────────────────────
// sendSingleActuator
// ─────────────────────────────────────────────────────────────────────────────
bool ActuatorCommander::sendSingleActuator(const std::string& name, int pos) {
    // Case-insensitive lookup
    auto it = roles_.find(name);
    if (it == roles_.end()) {
        const std::string lower = toLower(name);
        for (auto jt = roles_.begin(); jt != roles_.end(); ++jt) {
            if (toLower(jt->first) == lower) {
                it = jt;
                break;
            }
        }
    }
    if (it == roles_.end()) {
        std::cerr << "[ActuatorCommander] Unknown actuator role: " << name << std::endl;
        return false;
    }

    const ActuatorRole& role = it->second;
    uint8_t hw_state = static_cast<uint8_t>(role.is_no ? (1 - pos) : pos);
    bool ok = sendUDP(role.board_ip, {{static_cast<uint8_t>(role.channel), hw_state}});
    if (ok) {
        std::cout << "[ActuatorCommander] Manual: " << name << " -> "
                  << (pos == 1 ? "OPEN" : "CLOSED") << std::endl;
        uint8_t global_ch =
            actuator_elodin_low_byte(role.board_id, static_cast<uint8_t>(role.channel));
        publishCommandedState(global_ch, static_cast<uint8_t>(pos));
    }
    return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual overrides (debug)
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::setManualOverride(const std::string& name, int pos) {
    // Use canonical role key from config (CSV / applyForState use the same spelling).
    std::string key = name;
    auto it = roles_.find(name);
    if (it == roles_.end()) {
        const std::string lower = toLower(name);
        for (auto jt = roles_.begin(); jt != roles_.end(); ++jt) {
            if (toLower(jt->first) == lower) {
                key = jt->first;
                break;
            }
        }
    }
    std::lock_guard lock(overrides_mutex_);
    manual_overrides_[key] = pos;
}

void ActuatorCommander::clearAllManualOverrides() {
    std::lock_guard lock(overrides_mutex_);
    manual_overrides_.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// publishCommandedState — write [0x32, channel_id] to Elodin DB
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::publishCommandedState(uint8_t channel_id, uint8_t logical_pos) {
    if (!elodin_ || !elodin_->is_connected())
        return;

    auto ts_ns = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                           std::chrono::steady_clock::now().time_since_epoch())
                                           .count());

    ActuatorCommandedMsg msg(ts_ns, channel_id, logical_pos);
    std::array<uint8_t, 2> table_id = {VTABLE_ACT_CMD_HI, channel_id};
    elodin_->publish(table_id, msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// publishInitialState — seed Elodin DB with de-energized positions for all actuators
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::publishInitialState() {
    if (!elodin_ || !elodin_->is_connected())
        return;

    for (const auto& [name, role] : roles_) {
        // De-energized: NC → closed (0), NO → open (1)
        uint8_t logical_pos = role.is_no ? 1 : 0;
        uint8_t global_ch =
            actuator_elodin_low_byte(role.board_id, static_cast<uint8_t>(role.channel));
        publishCommandedState(global_ch, logical_pos);
    }
    std::cout << "[ActuatorCommander] Published initial state for " << roles_.size()
              << " actuators to Elodin DB" << std::endl;
}

}  // namespace sequencer
