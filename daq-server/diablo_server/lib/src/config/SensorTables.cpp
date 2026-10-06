#include "config/SensorTables.hpp"

namespace fsw {
namespace config {

std::string board_key_of(const BoardConfig& b) {
    return b.section.rfind("boards.", 0) == 0 ? b.section.substr(7) : b.section;
}

namespace {

/** Fill in the derived half of a ref once board/role/channel are known. */
PtRoleRef makeRef(const BoardConfig& b, std::string board_key, std::string role, int channel) {
    PtRoleRef r;
    r.board = &b;
    r.board_key = std::move(board_key);
    r.role = std::move(role);
    r.channel = channel;
    r.board_number = b.slot();
    r.table_hi = 0x20;
    r.table_lo = static_cast<uint8_t>((r.board_number - 1) * 0x20 + 0x10 + channel);
    return r;
}

/** The boards a PT role can live on. Mirrors the abort-threshold walk's filter exactly. */
bool usablePtBoard(const BoardConfig& b) {
    return b.type == "PT" && b.enabled && b.board_id > 0;
}

}  // namespace

std::vector<PtRoleRef> pt_role_tables(const Config& cfg) {
    std::vector<PtRoleRef> out;
    for (const auto& b : cfg.boards) {
        if (!usablePtBoard(b))
            continue;
        const std::string board_key = board_key_of(b);
        const auto* roles = cfg.sensor_roles_for("sensor_roles_" + board_key);
        if (roles == nullptr)
            continue;
        for (const auto& [role, channel] : *roles)
            out.push_back(makeRef(b, board_key, role, channel));
    }
    return out;
}

std::optional<PtRoleRef> find_pt_role(const Config& cfg, const std::string& role) {
    for (const auto& b : cfg.boards) {
        if (!usablePtBoard(b))
            continue;
        const std::string board_key = board_key_of(b);
        const auto* roles = cfg.sensor_roles_for("sensor_roles_" + board_key);
        if (roles == nullptr)
            continue;
        auto it = roles->find(role);
        if (it == roles->end())
            continue;  // not on this board — keep looking
        return makeRef(b, board_key, role, it->second);
    }
    return std::nullopt;
}

}  // namespace config
}  // namespace fsw
