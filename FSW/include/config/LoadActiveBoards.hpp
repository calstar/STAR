#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "elodin/DatabaseConfig.hpp"

namespace fsw {
namespace config {

/** Board kinds from [boards.*] in config.toml (order matches prior daq_bridge enum). */
enum class ActiveBoardKind : uint8_t {
    PT,
    LC,
    TC,
    RTD,
    ACTUATOR,
    ENCODER,
    UNKNOWN
};

/**
 * Parse [boards.*] sections: enabled boards, board_id, channels / num_sensors / active_connectors.
 * Used by daq_bridge (full table registration) and sequencer_service (ACT_CMD registration).
 */
std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> load_active_boards(
    const std::string& config_path);

}  // namespace config
}  // namespace fsw
