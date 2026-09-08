#pragma once

/**
 * @file PWMTargets.hpp
 * @brief Resolve which hardware the controller PWMs, from config alone.
 *
 * An [actuator_roles] entry whose optional 4th element is "pwm_fuel" or "pwm_ox" is assigned to
 * controller_service. That entry carries (channel, board_id), and [boards.*] maps board_id to an
 * IP. This is the *only* statement of what the controller drives — the process has no independent
 * notion of a "fuel board" — and it is the same fact ActuatorCommander reads to stop commanding
 * those actuators during a burn, so the two cannot disagree about who owns a valve.
 *
 * Every step here used to have a fallback in controller_main.cpp: a missing role became CH3/CH8 on
 * board 12, an undeclared board became "192.168.2.<board_id>", an empty board table became a
 * synthesized 11-14, and two roles on two boards silently shared the first one's IP. All of them
 * were this process asserting a rig layout only config knows, and all of them failed
 * silent-wrong — PWM onto whatever hardware happened to sit on the guessed channel, behind a
 * warning nobody reads. There are deliberately no fallbacks here: an unresolved target is
 * reported, and the caller disables the fire gate.
 *
 * Split out of controller_main.cpp so it can be tested without standing up a service.
 */

#include <map>
#include <string>
#include <vector>

#include "config/Config.hpp"
#include "control/ControllerService.hpp"

namespace fsw {
namespace control {

struct PWMResolution {
    ControllerService::PWMTarget fuel;
    ControllerService::PWMTarget ox;
    /** One human-readable line per problem. Empty means both targets are usable. */
    std::vector<std::string> issues;

    bool ok() const { return issues.empty(); }
};

/** board_id → IP from [boards.*] (non-empty ip, first wins). No synthesized entries: a board this
 *  map does not hold is a board config did not declare. */
inline std::map<int, std::string> boardIpMap(const fsw::config::Config& cfg) {
    std::map<int, std::string> out;
    for (const auto& b : cfg.boards)
        if (!b.ip.empty() && b.board_id > 0 && !out.count(b.board_id))
            out[b.board_id] = b.ip;
    return out;
}

inline PWMResolution resolvePWMTargets(const fsw::config::Config& cfg) {
    const std::map<int, std::string> ips = boardIpMap(cfg);
    PWMResolution res;

    auto resolve = [&](const char* assignment) -> ControllerService::PWMTarget {
        ControllerService::PWMTarget target;

        // Collect every actuator claiming this assignment. More than one is a config error worth
        // naming: silently taking the first would put PWM on a valve the operator did not intend,
        // which is the same class of failure as the old name-matching fallbacks.
        std::vector<std::string> claimants;
        for (const auto& [name, role] : cfg.actuator_roles)
            if (role.controller_role == assignment)
                claimants.push_back(name);

        if (claimants.empty()) {
            res.issues.push_back(std::string("no [actuator_roles] entry is assigned \"") +
                                 assignment + "\" — no actuator serves this PWM output");
            return target;
        }
        if (claimants.size() > 1) {
            std::string joined;
            for (size_t i = 0; i < claimants.size(); ++i)
                joined += (i ? ", " : "") + ("\"" + claimants[i] + "\"");
            res.issues.push_back(std::string("more than one [actuator_roles] entry is assigned \"") +
                                 assignment + "\": " + joined);
            return target;
        }

        const auto& name = claimants.front();
        const auto& role = cfg.actuator_roles.at(name);
        if (role.channel < 1) {
            res.issues.push_back("\"" + name + "\" is assigned \"" + assignment +
                                 "\" but declares no valid channel");
            return target;
        }
        const auto ip_it = ips.find(role.board_id);
        if (ip_it == ips.end()) {
            res.issues.push_back("\"" + name + "\" is assigned \"" + assignment +
                                 "\" but is on board_id " + std::to_string(role.board_id) +
                                 ", which no [boards.*] section declares an ip for");
            return target;
        }
        target.channel = static_cast<uint8_t>(role.channel);
        target.board_ip = ip_it->second;
        target.actuator_name = name;
        return target;
    };

    res.fuel = resolve("pwm_fuel");
    res.ox = resolve("pwm_ox");
    return res;
}

}  // namespace control
}  // namespace fsw
