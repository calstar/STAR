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
#include <sstream>
#include <thread>

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

static std::string getTomlValue(const std::string& content, const std::string& section,
                                const std::string& key, const std::string& fallback = "") {
    const std::string header = "[" + section + "]";
    auto sec_pos = content.find(header);
    if (sec_pos == std::string::npos)
        return fallback;

    auto start = sec_pos + header.size();
    auto next_sec = content.find("\n[", start);
    const std::string sec = (next_sec == std::string::npos)
                                ? content.substr(start)
                                : content.substr(start, next_sec - start);
    std::istringstream iss(sec);
    std::string line;
    while (std::getline(iss, line)) {
        auto c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
        auto eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        if (trimVal(line.substr(0, eq)) == key)
            return trimVal(line.substr(eq + 1));
    }
    return fallback;
}

/**
 * Parse [type, channel, board_id] from a TOML array value.
 * type may be "NC", "NO", or "PWM".
 */
static bool parseActuatorRole(const std::string& val, ActuatorRole& out,
                              const std::map<int, std::string>& board_id_to_ip) {
    size_t bracket = val.find('[');
    if (bracket == std::string::npos)
        return false;

    size_t c1 = val.find(',', bracket + 1);
    if (c1 == std::string::npos)
        return false;
    size_t c2 = val.find(',', c1 + 1);

    std::string type_str = trimVal(val.substr(bracket + 1, c1 - bracket - 1));
    std::string type_lower = toLower(type_str);
    out.is_no = (type_lower == "no");
    out.is_pwm = (type_lower == "pwm");

    try {
        std::string ch_str = trimVal(
            val.substr(c1 + 1, (c2 != std::string::npos) ? c2 - c1 - 1 : std::string::npos));
        out.channel = std::stoi(ch_str);

        if (c2 != std::string::npos) {
            int bid = std::stoi(trimVal(val.substr(c2 + 1)));
            out.board_id = bid;
            auto it = board_id_to_ip.find(bid);
            out.board_ip =
                (it != board_id_to_ip.end()) ? it->second : "192.168.2." + std::to_string(bid);
        } else {
            out.board_id = 11;              // fallback
            out.board_ip = "192.168.2.11";  // fallback
        }
    } catch (...) {
        return false;
    }
    return out.channel >= 1 && out.channel <= 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// load()
// ─────────────────────────────────────────────────────────────────────────────
bool ActuatorCommander::load(const std::string& config_content, const std::string& csv_path) {
    roles_.clear();
    state_actuators_.clear();

    // -- Config: bind address and actuator port --
    bind_addr_ = getTomlValue(config_content, "actuator_service", "bind_address", "0.0.0.0");
    if (bind_addr_.empty())
        bind_addr_ = "0.0.0.0";

    const std::string port_str =
        getTomlValue(config_content, "network", "actuator_cmd_port", "5005");
    try {
        actuator_port_ = static_cast<uint16_t>(std::stoi(port_str));
    } catch (...) {
    }

    // -- Board IP map: board_id → IP (from [boards.xxx] sections) --
    std::map<int, std::string> board_id_to_ip;
    {
        size_t pos = 0;
        while (pos < config_content.size()) {
            size_t next = config_content.find("[boards.", pos);
            if (next == std::string::npos)
                break;
            size_t end = config_content.find(']', next);
            if (end == std::string::npos)
                break;
            std::string sec = config_content.substr(next + 1, end - next - 1);
            std::string ip = getTomlValue(config_content, sec, "ip", "");
            std::string id_str = getTomlValue(config_content, sec, "id",
                                              getTomlValue(config_content, sec, "board_id", ""));
            if (!ip.empty() && !id_str.empty()) {
                try {
                    int id = std::stoi(id_str);
                    if (id > 0)
                        board_id_to_ip[id] = ip;
                } catch (...) {
                }
            }
            pos = end + 1;
        }
    }
    if (board_id_to_ip.empty()) {
        // Minimal fallback: canonical 192.168.2.N scheme
        for (int i = 11; i <= 14; ++i)
            board_id_to_ip[i] = "192.168.2." + std::to_string(i);
    }

    // -- Actuator roles from [actuator_roles] section --
    {
        std::string current_section;
        std::istringstream cfg(config_content);
        std::string line;
        while (std::getline(cfg, line)) {
            auto c = line.find('#');
            if (c != std::string::npos)
                line = line.substr(0, c);
            if (line.size() >= 2 && line[0] == '[') {
                size_t end = line.find(']');
                current_section = (end != std::string::npos) ? line.substr(1, end - 1) : "";
                continue;
            }
            if (current_section != "actuator_roles")
                continue;
            auto eq = line.find('=');
            if (eq == std::string::npos)
                continue;

            std::string role_name = trimVal(line.substr(0, eq));
            ActuatorRole role;
            if (!parseActuatorRole(trimVal(line.substr(eq + 1)), role, board_id_to_ip))
                continue;
            roles_[role_name] = role;
        }
    }
    std::cout << "[ActuatorCommander] Loaded " << roles_.size() << " actuator roles from config"
              << std::endl;

    // -- State→actuator CSV --
    const char* fallbacks[] = {
        "external/DiabloAvionics/test_guis/state_machine_actuators.csv",
        "../external/DiabloAvionics/test_guis/state_machine_actuators.csv",
        "../../external/DiabloAvionics/test_guis/state_machine_actuators.csv",
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
    if (id_state_pairs.empty())
        return true;

    std::vector<Diablo::ActuatorCommand> cmds;
    cmds.reserve(id_state_pairs.size());
    for (const auto& [id, st] : id_state_pairs)
        cmds.push_back({id, st});

    uint8_t buf[512];
    size_t len = Diablo::create_actuator_command_packet(cmds, buf, sizeof(buf));
    if (len == 0) {
        std::cerr << "[ActuatorCommander] create_actuator_command_packet returned 0" << std::endl;
        return false;
    }

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0)
        return false;

    struct sockaddr_in local {};
    local.sin_family = AF_INET;
    inet_pton(AF_INET, bind_addr_.c_str(), &local.sin_addr);
    if (bind(sock, reinterpret_cast<struct sockaddr*>(&local), sizeof(local)) < 0) {
        close(sock);
        return false;
    }

    struct sockaddr_in dest {};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(actuator_port_);
    if (inet_pton(AF_INET, board_ip.c_str(), &dest.sin_addr) != 1) {
        close(sock);
        return false;
    }

    // Send 3× in rapid succession (1 ms apart) so the command lands in the
    // board's UDP receive window regardless of its loop() polling rate.
    ssize_t sent = -1;
    for (int i = 0; i < 3; ++i) {
        sent = sendto(sock, buf, len, 0, reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));
        if (i < 2)
            usleep(1000);  // 1 ms between retries
    }
    close(sock);
    return sent == static_cast<ssize_t>(len);
}

// ─────────────────────────────────────────────────────────────────────────────
// applyForState — send all actuator commands for a state (one shot, batched by board)
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::applyForState(State state) {
    const std::string state_name = StateMachine::name(state);
    auto it = findStateActuators(state_name);
    if (it == state_actuators_.end()) {
        std::cerr << "[ActuatorCommander] No CSV entry for state: " << state_name << std::endl;
        return;
    }

    const bool is_fire = (state == State::FIRE);

    // Group commands by board IP and collect logical positions for DB publishing
    std::map<std::string, std::vector<std::pair<uint8_t, uint8_t>>> by_board;
    std::vector<std::pair<uint8_t, uint8_t>> logical_commands;  // channel, logical_pos
    std::unique_lock lock(overrides_mutex_);
    for (const auto& [act_name, logical_pos] : it->second) {
        auto role_it = roles_.find(act_name);
        if (role_it == roles_.end())
            continue;
        const ActuatorRole& role = role_it->second;
        if (is_fire && role.is_pwm)
            continue;  // skipped: controlled by controller_service

        // Manual override takes precedence
        int pos = logical_pos;
        auto ov = manual_overrides_.find(act_name);
        if (ov != manual_overrides_.end())
            pos = ov->second;

        uint8_t hw_state = static_cast<uint8_t>(role.is_no ? (1 - pos) : pos);
        by_board[role.board_ip].emplace_back(static_cast<uint8_t>(role.channel), hw_state);
        // Global channel: (board_id - 11) * 10 + channel → unique across all actuator boards
        uint8_t global_ch =
            actuator_elodin_low_byte(role.board_id, static_cast<uint8_t>(role.channel));
        logical_commands.emplace_back(global_ch, static_cast<uint8_t>(pos));
    }
    lock.unlock();

    for (const auto& [ip, cmds] : by_board) {
        if (sendUDP(ip, cmds))
            std::cout << "[ActuatorCommander] Sent " << cmds.size() << " commands to " << ip
                      << " for state " << state_name << std::endl;
        else
            std::cerr << "[ActuatorCommander] UDP send failed to " << ip << std::endl;
    }

    // Publish commanded state to Elodin DB [0x32, ch]
    for (const auto& [ch, pos] : logical_commands) {
        publishCommandedState(ch, pos);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Continuous loop
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::startContinuousLoop(State state) {
    stopContinuousLoop();

    loop_running_ = true;
    loop_state_ = state;
    loop_thread_ = std::thread([this, state]() {
        std::cout << "[ActuatorCommander] Continuous loop started for state "
                  << StateMachine::name(state) << std::endl;
        while (loop_running_) {
            applyForState(loop_state_);
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
// Manual overrides
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::setManualOverride(const std::string& name, int pos) {
    std::lock_guard lock(overrides_mutex_);
    manual_overrides_[name] = pos;
}

void ActuatorCommander::clearManualOverride(const std::string& name) {
    std::lock_guard lock(overrides_mutex_);
    manual_overrides_.erase(name);
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
