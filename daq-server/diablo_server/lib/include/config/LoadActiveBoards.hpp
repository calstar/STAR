#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "elodin/DatabaseConfig.hpp"

namespace fsw {
namespace config {

/** Board kinds from [boards.*] in config.toml (order matches prior daq_bridge enum). */
enum class ActiveBoardKind : uint8_t { PT, LC, TC, RTD, ACTUATOR, ENCODER, UNKNOWN };

/**
 * Sensor interface of a PT board, declared by `pt_type` in its [boards.*] section.
 *
 * The board hardware is identical; what differs is the sensor interface and therefore the ADC
 * reference, which is set once per board and so cannot be mixed across connectors.
 */
enum class PtInterface : uint8_t {
    RATIOMETRIC_0_5V,     ///< 0-5V ratiometric: excitation is the reference, ratio cancels in HW.
    CURRENT_LOOP_4_20MA,  ///< 4-20 mA absolute: supply-independent loop across a shunt resistor.
    ABSOLUTE_0_5V,        ///< 0-5V absolute. Not implemented in firmware; see load_pt_boards().
};

/** Per-board 4-20 mA conversion parameters, keyed by Elodin slot (board_number). */
struct PtBoardConfig {
    uint8_t board_id = 0;
    uint8_t board_number = 0;  ///< Elodin slot: board_id % 10, with 0 mapping to 10.
    PtInterface interface = PtInterface::RATIOMETRIC_0_5V;
    double full_scale_psi = 5000.0;
    double sense_resistor_ohms = 120.0;
    double adc_ref_voltage = 2.5;
};

/** True when this board's channels convert through the 4-20 mA current-loop path. */
inline bool is_current_loop(const PtBoardConfig& b) {
    return b.interface == PtInterface::CURRENT_LOOP_4_20MA;
}

/**
 * Parse [boards.*] sections: enabled boards, board_id, channels / num_sensors / active_connectors.
 * Used by daq_bridge (full table registration) and sequencer_service (ACT_CMD registration).
 *
 * Also validates Elodin slot assignment (see check_board_slots) and logs to stderr on conflict.
 */
std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> load_active_boards(
    const std::string& config_path);

/**
 * Parse the PT boards' sensor interface and 4-20 mA conversion parameters, keyed by Elodin slot.
 *
 * `pt_type` is authoritative. A board that predates it is treated as 4-20 mA if it carries the
 * legacy hp_pt_* keys, so a deployed config keeps working; that fallback logs a deprecation once.
 */
std::map<uint8_t, PtBoardConfig> load_pt_boards(const std::string& config_path);

}  // namespace config
}  // namespace fsw
