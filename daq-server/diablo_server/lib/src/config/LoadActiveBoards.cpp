#include "config/LoadActiveBoards.hpp"

#include "config/Config.hpp"

// The board parsing + slot-collision validation now lives in Config.cpp (active_boards/pt_boards),
// fed by the single toml++ parser. These free functions remain as thin wrappers so their existing
// callers (daq_bridge, calibration_service, sequencer_service) need no change.

namespace fsw {
namespace config {

std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> load_active_boards(
    const std::string& config_path) {
    return active_boards(load(config_path));
}

std::map<uint8_t, PtBoardConfig> load_pt_boards(const std::string& config_path) {
    return pt_boards(load(config_path));
}

}  // namespace config
}  // namespace fsw
