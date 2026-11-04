#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "config/Config.hpp"

namespace fsw {
namespace config {

/**
 * Where a named PT sensor role lives: which board, which channel, and which Elodin table its
 * calibrated pressure is published on.
 *
 * This walk — a name -> [sensor_roles_<board_key>] -> board -> table id — used to exist inline in
 * exactly one place (config_broadcast_service_main.cpp) and nowhere else, so every other consumer
 * that wanted a live pressure by name reached for a hardcoded channel number instead. That is how
 * ControllerService ended up assigning `P_copv` from channel 6, which is "GN2 Regulated" on this
 * rig and not the COPV at all, and how its subscriber filter came to drop every sensor on PT board
 * 2 — "GN2 High" included. Resolving by role through config makes both unrepresentable.
 */
struct PtRoleRef {
    /** The board declaring this role. Points into the Config that was passed in, so it is valid
     *  exactly as long as that Config is. Never null on a successful lookup. */
    const BoardConfig* board = nullptr;
    /** The board's section name with the "boards." prefix stripped, e.g. "pt_board_2". This is the
     *  suffix every per-board section is keyed by: sensor_roles_<key>, calibration_model_<key>,
     *  calibration_full_scale_<key>. Resolved here so callers do not each re-derive it. */
    std::string board_key;
    /** Canonical role name as config spells it, e.g. "GN2 High" — not a slug. */
    std::string role;
    /** Connector channel on that board, 1-based, straight from [sensor_roles_<key>]. */
    int channel = 0;
    /** Elodin slot, BoardConfig::slot() — board_id % 10, with 0 meaning 10. */
    uint8_t board_number = 0;

    /**
     * The calibrated-PT table this sensor publishes on: {0x20, (slot-1)*0x20 + 0x10 + channel}.
     *
     * The encoding is DatabaseConfig.cpp's, which is what actually registers the VTables — not
     * [routing.pt_calibrated]'s description string, which claims board 2 lives at 0x1B-0x1E, has
     * no consumer anywhere in the tree, and is wrong.
     */
    uint8_t table_hi = 0x20;
    uint8_t table_lo = 0;

    std::pair<uint8_t, uint8_t> table() const {
        return {table_hi, table_lo};
    }
};

/**
 * Every PT sensor role declared by an enabled PT board, in board-declaration order.
 *
 * Boards that are disabled, not of type "PT", or carry no usable board_id are skipped, matching
 * what the config-broadcast abort-threshold path has always done. A role declared on more than one
 * board appears once per board; callers wanting a single answer should use find_pt_role.
 */
std::vector<PtRoleRef> pt_role_tables(const Config& cfg);

/**
 * Resolve one role by its canonical config name.
 *
 * First enabled PT board that declares the name wins, in config order — the same "not on this
 * board, keep looking" rule the inline walk used. Returns nullopt when no enabled PT board
 * declares it, which callers must treat as a refusal rather than a default: a sensor that cannot
 * be located has no safe stand-in value.
 */
std::optional<PtRoleRef> find_pt_role(const Config& cfg, const std::string& role);

/** The board's section name minus a leading "boards.", e.g. "boards.pt_board_2" -> "pt_board_2". */
std::string board_key_of(const BoardConfig& b);

}  // namespace config
}  // namespace fsw
