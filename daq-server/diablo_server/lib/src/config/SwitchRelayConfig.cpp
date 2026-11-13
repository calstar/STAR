#include "config/SwitchRelayConfig.hpp"

#include <algorithm>
#include <cstdio>
#include <set>
#include <toml++/toml.hpp>

#include "config/Config.hpp"

namespace fsw {
namespace config {

bool parse_mac(const std::string& text, std::array<uint8_t, 6>& out) {
    if (text.size() != 17)
        return false;
    for (int i = 0; i < 6; ++i) {
        if (i > 0 && text[i * 3 - 1] != ':' && text[i * 3 - 1] != '-')
            return false;
        unsigned v = 0;
        for (int k = 0; k < 2; ++k) {
            char c = text[i * 3 + k];
            v <<= 4;
            if (c >= '0' && c <= '9')
                v |= c - '0';
            else if (c >= 'a' && c <= 'f')
                v |= c - 'a' + 10;
            else if (c >= 'A' && c <= 'F')
                v |= c - 'A' + 10;
            else
                return false;
        }
        out[i] = static_cast<uint8_t>(v);
    }
    return true;
}

daq::SwitchConfig switch_config_for(const SwitchRelayConfig& relay) {
    daq::SwitchConfig wire;
    for (const auto& r : relay.roles) {
        if (wire.count >= daq::MAX_SWITCHES)
            break;
        daq::SwitchConfigEntry& e = wire.entries[wire.count++];
        e.role = r.role;
        std::copy(r.mac.begin(), r.mac.end(), e.mac);
    }
    return wire;
}

const BoardConfig* switch_relay_board(const Config& cfg) {
    for (const auto& b : cfg.boards)
        if (b.section == "boards." + cfg.switch_relay.env_board && b.type == "ENVIRONMENTAL" &&
            b.enabled)
            return &b;
    return nullptr;
}

namespace detail {

SwitchRelayConfig parse_switch_relay(const toml::table& root) {
    SwitchRelayConfig c;
    auto svc = root["switch_service"];
    c.enabled = svc["enabled"].value<bool>().value_or(false);
    c.interval_ms = static_cast<uint32_t>(
        std::max<int64_t>(100, svc["interval_ms"].value<int64_t>().value_or(1000)));
    c.env_board = svc["env_board"].value<std::string>().value_or("environmental_board");

    std::set<int64_t> roles;
    std::set<std::array<uint8_t, 6>> macs;
    if (const toml::table* t = root["switch_roles"].as_table()) {
        for (const auto& [k, v] : *t) {
            const std::string key(k.str());
            const std::string where = "[switch_roles." + key + "]";
            const toml::table* r = v.as_table();
            if (!r) {
                c.errors.push_back(where + " is not a table");
                continue;
            }
            SwitchRole sr;
            sr.key = key;
            auto role = (*r)["role"].value<int64_t>();
            if (!role || *role < 0 || *role >= daq::MAX_SWITCHES) {
                c.errors.push_back(where + " role must be an integer from 0 to " +
                                   std::to_string(daq::MAX_SWITCHES - 1));
                continue;
            }
            if (!roles.insert(*role).second) {
                c.errors.push_back(where + " role " + std::to_string(*role) +
                                   " is used by another switch");
                continue;
            }
            sr.role = static_cast<uint8_t>(*role);
            sr.name = (*r)["name"].value<std::string>().value_or(key);
            const std::string mac = (*r)["mac"].value<std::string>().value_or("");
            if (!parse_mac(mac, sr.mac)) {
                c.errors.push_back(where + " mac \"" + mac +
                                   "\" is not a MAC like 58:cf:79:01:3f:2a");
                continue;
            }
            if (!macs.insert(sr.mac).second) {
                c.errors.push_back(where + " mac " + mac + " is listed twice");
                continue;
            }
            c.roles.push_back(sr);
        }
    }
    std::sort(c.roles.begin(), c.roles.end(),
              [](const SwitchRole& a, const SwitchRole& b) { return a.role < b.role; });
    return c;
}

}  // namespace detail
}  // namespace config
}  // namespace fsw
