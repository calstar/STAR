#include "config/SensorTables.hpp"

#include "t7/T7Stream.hpp"

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

/** A PT input on a LabJack T7: calibration_service publishes it on the T7 calibrated table in the
 *  same CalibratedPTMessage layout as an ESP32 PT, so a reader cannot tell them apart. */
PtRoleRef makeT7Ref(const T7Board& b, const T7Channel& c) {
    PtRoleRef r;
    r.t7 = &b;
    r.board_key = b.section.rfind("boards.", 0) == 0 ? b.section.substr(7) : b.section;
    r.role = c.role;
    r.channel = c.ain;
    r.board_number = b.slot();
    const auto id = fsw::t7::calibrated_table_id(r.board_number, static_cast<uint8_t>(c.ain));
    r.table_hi = id[0];
    r.table_lo = id[1];
    return r;
}

/** Every PT input t7_bridge will actually stream. It refuses to start on any T7 config error, so
 *  then there are none: a script naming one is refused at load rather than waiting on silence. */
std::vector<PtRoleRef> t7PtRefs(const Config& cfg) {
    std::vector<PtRoleRef> out;
    if (!cfg.t7_errors.empty())
        return out;
    for (const auto& b : cfg.t7_boards) {
        if (!b.enabled || b.board_id <= 0)
            continue;
        for (const auto& c : b.channels)
            if (c.kind == "PT" && !c.role.empty())
                out.push_back(makeT7Ref(b, c));
    }
    return out;
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
    for (auto& r : t7PtRefs(cfg))
        out.push_back(std::move(r));
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
    for (auto& r : t7PtRefs(cfg))
        if (r.role == role)
            return r;
    return std::nullopt;
}

}  // namespace config
}  // namespace fsw
