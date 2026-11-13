#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include "DiabloPackets.h"

namespace fsw {
namespace config {

struct Config;
struct BoardConfig;

/** One Bluetooth switch, from [switch_roles.<key>]. The role index is what goes on the wire;
 *  the name never leaves the server. */
struct SwitchRole {
    std::string key;                 // the TOML key, e.g. "main_altimeter"
    uint8_t role = 0;                // 0..daq::MAX_SWITCHES-1
    std::string name;                // "Main altimeter"
    std::array<uint8_t, 6> mac{};    // most significant byte first, as printed
};

/** [switch_service] + [switch_roles.*]: the switches the environmental board relays.
 *  Problems land in `errors`; switch_service refuses to send a list with any. */
struct SwitchRelayConfig {
    bool enabled = false;
    uint32_t interval_ms = 1000;  // SWITCH_CONFIG resend period
    std::string env_board;        // key of the [boards.<key>] that relays them
    std::vector<SwitchRole> roles;  // sorted by role
    std::vector<std::string> errors;
};

/** "58:cf:79:01:3f:2a" (or with '-') -> bytes. */
bool parse_mac(const std::string& text, std::array<uint8_t, 6>& out);

/** The list as the env board receives it. */
daq::SwitchConfig switch_config_for(const SwitchRelayConfig& relay);

/** The enabled ENVIRONMENTAL board named by env_board, or nullptr. */
const BoardConfig* switch_relay_board(const Config& cfg);

}  // namespace config
}  // namespace fsw
