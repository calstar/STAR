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
#include <tuple>

#include "config/Config.hpp"
#include "control/ActuatorCommander.hpp"
#include "elodin/DatabaseConfig.hpp"

// daqv2comms — all packet construction goes through here
#include "DiabloPacketUtils.h"
#include "comms/CommsMessage.hpp"

namespace sequencer {

static std::string trimVal(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// load()
// ─────────────────────────────────────────────────────────────────────────────
void ActuatorCommander::setDefaultBindAddress(const std::string& address) {
    if (bind_addr_explicit_)
        return;
    bind_addr_ = address.empty() ? "0.0.0.0" : address;
}

bool ActuatorCommander::load(const std::string& config_content, const std::string& csv_path,
                             const std::string& delay_csv_path) {
    roles_.clear();
    state_actuators_.clear();

    const fsw::config::Config cfg = fsw::config::load_from_string(config_content);

    // -- Config: bind address and actuator port --
    // An explicit [actuator_service].bind_address wins; 0.0.0.0 (the shipped value everywhere)
    // means "not specified", and setDefaultBindAddress() fills it from the resolved DAQ NIC.
    bind_addr_ = cfg.actuator_service.bind_address;
    if (bind_addr_.empty())
        bind_addr_ = "0.0.0.0";
    bind_addr_explicit_ = bind_addr_ != "0.0.0.0";
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
        // Assigned to controller_service via the 4th element of the [actuator_roles] entry.
        // This used to read `kind == "PWM"`, but kind is also where NC/NO polarity lives, so
        // an actuator could not be both PWM-driven and normally open — and since the shipped
        // configs needed NC/NO, nothing was ever marked "PWM" and this handoff never engaged
        // on a real rig. Same field the controller resolves its targets from (PWMTargets.hpp).
        role.is_pwm = !r.controller_role.empty();
        role.channel = r.channel;
        role.board_id = r.board_id;
        // A ball valve role is already pass-through (Config forces is_no off); it only differs in
        // where its commanded state is recorded.
        if (r.ball_valve)
            role.cmd_table_hi = fsw::elodin::kBallValveCmdHi;
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
        // Config first; the suffix swap is only the fallback for a caller that passes nothing.
        std::string delay_csv = delay_csv_path;
        if (delay_csv.empty()) {
            delay_csv = used_csv;
            const std::string suffix = "state_machine_actuators.csv";
            if (delay_csv.size() >= suffix.size() &&
                delay_csv.compare(delay_csv.size() - suffix.size(), suffix.size(), suffix) == 0) {
                delay_csv.replace(delay_csv.size() - suffix.size(), suffix.size(),
                                  "state_machine_actuator_delays.csv");
            } else {
                // The swap did not fire, so `delay_csv` is still the POSITIONS file. Opening that
                // as a delays table parses OPEN/CLOSE as numbers, finds none, and leaves every
                // stagger at zero — silently. Say so instead.
                std::cerr << "[ActuatorCommander] No delay CSV given and \"" << used_csv
                          << "\" is not named state_machine_actuators.csv — running with NO "
                             "actuator delays. Set [state_machine].actuator_delay_csv."
                          << std::endl;
                delay_csv.clear();
            }
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

}  // namespace sequencer
