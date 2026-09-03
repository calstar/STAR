#include "config/LoadActiveBoards.hpp"

#include <fstream>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>

namespace fsw {
namespace config {

namespace {

/** Strip comments, CR and surrounding whitespace. Returns the bare line (may be empty). */
std::string clean_line(std::string line) {
    size_t c = line.find('#');
    if (c != std::string::npos)
        line = line.substr(0, c);
    while (!line.empty() && (line.back() == ' ' || line.back() == '\t' || line.back() == '\r'))
        line.pop_back();
    size_t start = line.find_first_not_of(" \t");
    if (start == std::string::npos)
        return "";
    return line.substr(start);
}

std::string unquote(std::string v) {
    if (v.size() >= 2 && v.front() == '"' && v.back() == '"')
        return v.substr(1, v.size() - 2);
    return v;
}

using KeyValues = std::map<std::string, std::string>;

/**
 * Walk every [boards.*] section, invoking `fn(section_name, key_values)` once per section.
 *
 * Collecting each section into a map before dispatching makes key order within a section
 * irrelevant, which the previous single-pass readers were sensitive to.
 */
void for_each_board_section(const std::string& config_path,
                            const std::function<void(const std::string&, const KeyValues&)>& fn) {
    std::ifstream f(config_path);
    if (!f.is_open())
        return;

    std::string line, section;
    KeyValues kv;

    auto flush = [&]() {
        if (section.rfind("boards.", 0) == 0 && !kv.empty())
            fn(section, kv);
        kv.clear();
    };

    while (std::getline(f, line)) {
        line = clean_line(std::move(line));
        if (line.empty())
            continue;

        if (line.size() >= 2 && line[0] == '[' && line.back() == ']') {
            flush();
            section = line.substr(1, line.size() - 2);
            continue;
        }
        if (section.rfind("boards.", 0) != 0)
            continue;

        size_t eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
            key.pop_back();
        while (!val.empty() && (val[0] == ' ' || val[0] == '\t'))
            val.erase(0, 1);
        kv[key] = val;
    }
    flush();
}

const std::string* find(const KeyValues& kv, const std::string& key) {
    auto it = kv.find(key);
    return it == kv.end() ? nullptr : &it->second;
}

bool board_enabled(const KeyValues& kv) {
    const std::string* v = find(kv, "enabled");
    return !(v && *v == "false");
}

int board_id_of(const KeyValues& kv) {
    const std::string* v = find(kv, "board_id");
    if (!v)
        return -1;
    try {
        return std::stoi(*v);
    } catch (...) {
        return -1;
    }
}

/** Elodin slot for a board id: board_id % 10, with 0 mapping to 10. */
uint8_t slot_of(int board_id) {
    int m = board_id % 10;
    return static_cast<uint8_t>(m == 0 ? 10 : m);
}

double double_or(const KeyValues& kv, const std::string& key, double fallback) {
    const std::string* v = find(kv, key);
    if (!v)
        return fallback;
    try {
        return std::stod(*v);
    } catch (...) {
        return fallback;
    }
}

std::vector<uint8_t> parse_int_list(const std::string& val) {
    std::vector<uint8_t> out;
    size_t b = val.find('['), e = val.find(']');
    if (b == std::string::npos || e == std::string::npos)
        return out;
    std::istringstream iss(val.substr(b + 1, e - b - 1));
    std::string tok;
    while (std::getline(iss, tok, ',')) {
        try {
            out.push_back(static_cast<uint8_t>(std::stoi(tok)));
        } catch (...) {
        }
    }
    return out;
}

ActiveBoardKind kind_of(const std::string& type_str) {
    if (type_str == "PT")
        return ActiveBoardKind::PT;
    if (type_str == "TC")
        return ActiveBoardKind::TC;
    if (type_str == "RTD")
        return ActiveBoardKind::RTD;
    if (type_str == "LC")
        return ActiveBoardKind::LC;
    if (type_str == "ENCODER")
        return ActiveBoardKind::ENCODER;
    if (type_str == "ACTUATOR")
        return ActiveBoardKind::ACTUATOR;
    return ActiveBoardKind::UNKNOWN;
}

/**
 * Every layer maps a board to an Elodin slot as board_id % 10, and the packet id low byte is
 * (slot-1) * 0x20 + 0x10 + channel — so only 8 slots fit in a byte, and two boards of the same
 * kind sharing a slot merge into one entity silently.
 *
 * Scoped per kind on purpose: the packet id's high byte already separates the kinds (0x20 PT,
 * 0x21 TC, 0x22 RTD, 0x23 LC, 0x24 ENCODER, 0x30 ACT — see DatabaseConfig.cpp), so a PT and an
 * actuator board on the same slot are fine and must not be reported.
 *
 * Neither condition is recoverable here; log loudly and let startup continue so the operator
 * sees which boards collided rather than an unexplained exit.
 */
void check_board_slots(std::map<ActiveBoardKind, std::map<uint8_t, std::string>>& slot_owner,
                       ActiveBoardKind kind, uint8_t slot, const std::string& section,
                       int board_id) {
    auto& owners = slot_owner[kind];
    auto prev = owners.find(slot);
    if (prev != owners.end()) {
        std::cerr << "[Config] ERROR: board slot " << static_cast<int>(slot) << " claimed by both ["
                  << prev->second << "] and [" << section
                  << "] - their channels will merge into one Elodin entity. Give them board_ids "
                     "that differ mod 10."
                  << std::endl;
    } else {
        owners.emplace(slot, section);
    }
    if (slot > 8) {
        std::cerr << "[Config] ERROR: [" << section << "] board_id " << board_id << " maps to slot "
                  << static_cast<int>(slot)
                  << ", but the packet id low byte only encodes slots 1-8. Its channels will "
                     "collide with another board."
                  << std::endl;
    }
}

}  // namespace

std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> load_active_boards(
    const std::string& config_path) {
    using BoardChannels = elodin::BoardChannels;
    std::map<ActiveBoardKind, std::vector<BoardChannels>> result;
    std::map<ActiveBoardKind, std::map<uint8_t, std::string>> slot_owner;

    for_each_board_section(config_path, [&](const std::string& section, const KeyValues& kv) {
        const std::string* type_str = find(kv, "type");
        int board_id = board_id_of(kv);
        if (!type_str || !board_enabled(kv) || board_id < 0)
            return;
        ActiveBoardKind bt = kind_of(unquote(*type_str));
        if (bt == ActiveBoardKind::UNKNOWN)
            return;

        uint8_t slot = slot_of(board_id);
        check_board_slots(slot_owner, bt, slot, section, board_id);

        BoardChannels bc;
        bc.board_id = static_cast<uint8_t>(board_id);
        bc.board_number = slot;

        if (const std::string* conns = find(kv, "active_connectors"))
            bc.channels = parse_int_list(*conns);
        if (bc.channels.empty()) {
            int num_sensors = 10;
            if (const std::string* n = find(kv, "num_sensors")) {
                try {
                    num_sensors = std::stoi(*n);
                } catch (...) {
                }
            }
            for (int i = 1; i <= num_sensors; i++)
                bc.channels.push_back(static_cast<uint8_t>(i));
        }
        result[bt].push_back(std::move(bc));
    });

    return result;
}

std::map<uint8_t, PtBoardConfig> load_pt_boards(const std::string& config_path) {
    std::map<uint8_t, PtBoardConfig> result;
    bool warned_legacy = false;

    for_each_board_section(config_path, [&](const std::string& section, const KeyValues& kv) {
        const std::string* type_str = find(kv, "type");
        int board_id = board_id_of(kv);
        if (!type_str || unquote(*type_str) != "PT" || !board_enabled(kv) || board_id < 0)
            return;

        PtBoardConfig b;
        b.board_id = static_cast<uint8_t>(board_id);
        b.board_number = slot_of(board_id);

        if (const std::string* pt_type = find(kv, "pt_type")) {
            std::string v = unquote(*pt_type);
            if (v == "4-20 mA absolute") {
                b.interface = PtInterface::CURRENT_LOOP_4_20MA;
            } else if (v == "0-5V ratiometric") {
                b.interface = PtInterface::RATIOMETRIC_0_5V;
            } else if (v == "0-5V absolute") {
                // voltage_reference = 2 is not implemented in the PT firmware: it falls back to
                // the internal 2.5 V reference, which would silently halve the usable range.
                std::cerr << "[Config] ERROR: [" << section << "] pt_type \"" << v
                          << "\" is not supported by the PT firmware." << std::endl;
                b.interface = PtInterface::ABSOLUTE_0_5V;
            } else {
                std::cerr << "[Config] ERROR: [" << section << "] unknown pt_type \"" << v
                          << "\"; treating as 0-5V ratiometric." << std::endl;
            }
        } else if (find(kv, "hp_pt_connectors") || find(kv, "hp_pt_full_scale_psi")) {
            // Legacy config: the interface was inferred from the presence of the hp_pt_* keys.
            b.interface = PtInterface::CURRENT_LOOP_4_20MA;
            if (!warned_legacy) {
                warned_legacy = true;
                std::cerr << "[Config] DEPRECATED: [" << section
                          << "] has no pt_type; inferring \"4-20 mA absolute\" from its hp_pt_* "
                             "keys. Add pt_type to the board."
                          << std::endl;
            }
        }

        b.full_scale_psi = double_or(kv, "hp_pt_full_scale_psi", b.full_scale_psi);
        b.sense_resistor_ohms = double_or(kv, "hp_pt_sense_resistor_ohms", b.sense_resistor_ohms);
        b.adc_ref_voltage = double_or(kv, "adc_ref_voltage", b.adc_ref_voltage);

        result[b.board_number] = b;
    });

    return result;
}

}  // namespace config
}  // namespace fsw
