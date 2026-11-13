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
    uint16_t command_port = 8094; // loopback UDP the backend sends operator commands to
    std::vector<SwitchRole> roles;  // sorted by role
    std::vector<std::string> errors;
};

/** "58:cf:79:01:3f:2a" (or with '-') -> bytes. */
bool parse_mac(const std::string& text, std::array<uint8_t, 6>& out);

/** The list as the env board receives it. */
daq::SwitchConfig switch_config_for(const SwitchRelayConfig& relay);

/** An operator command from the backend, as it arrives on command_port: one line,
 *  "<command_id> <role> <output>", output 1 = arm, 0 = disarm. Returns false (with why) for
 *  anything else, a role not in the list, or an id outside 0..65535. */
bool parse_switch_command(const std::string& line, const SwitchRelayConfig& relay,
                          daq::SwitchCommandPacket& out, std::string& why);

/** The enabled ENVIRONMENTAL board named by env_board, or nullptr. */
const BoardConfig* switch_relay_board(const Config& cfg);

}  // namespace config
}  // namespace fsw
