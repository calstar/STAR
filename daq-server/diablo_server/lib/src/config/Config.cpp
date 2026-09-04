#include "config/Config.hpp"

#include <algorithm>
#include <iostream>
#include <toml++/toml.hpp>

namespace fsw {
namespace config {

namespace {

using CNV = toml::node_view<const toml::node>;

std::string s_or(CNV n, const std::string& d) {
    return n.value<std::string>().value_or(d);
}
int64_t i_or(CNV n, int64_t d) {
    return n.value<int64_t>().value_or(d);
}
double d_or(CNV n, double d) {
    return n.value<double>().value_or(d);
}
bool b_or(CNV n, bool d) {
    return n.value<bool>().value_or(d);
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

// Verbatim from the old LoadActiveBoards.cpp: log slot collisions (kind-scoped) and slot>8
// overflow.
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

BoardConfig parse_board(const std::string& section, const toml::table& bt) {
    BoardConfig b;
    b.section = section;
    b.type = s_or(bt["type"], "");
    b.ip = s_or(bt["ip"], "");
    b.board_id =
        static_cast<int>(i_or(bt["board_id"], i_or(bt["id"], -1)));  // legacy "id" fallback
    b.enabled = b_or(bt["enabled"], true);
    b.num_sensors = static_cast<int>(i_or(bt["num_sensors"], 10));
    b.num_actuators = static_cast<int>(i_or(bt["num_actuators"], 0));
    b.send_port = static_cast<uint16_t>(i_or(bt["send_port"], 5005));
    b.listen_port = static_cast<uint16_t>(i_or(bt["listen_port"], 5005));
    b.voltage_reference = static_cast<int>(i_or(bt["voltage_reference"], 0));
    b.necessary_for_abort = b_or(bt["necessary_for_abort"], false);
    b.designated_survivor = b_or(bt["designated_survivor"], false);

    // enable_serial_printing tolerates a bool or an int; clamp 0..3 (matches config_broadcast).
    int esp = 0;
    if (auto iv = bt["enable_serial_printing"].value<int64_t>())
        esp = static_cast<int>(*iv);
    else if (auto bv = bt["enable_serial_printing"].value<bool>())
        esp = *bv ? 1 : 0;
    b.enable_serial_printing = std::clamp(esp, 0, 3);

    if (auto arr = bt["active_connectors"].as_array())
        for (const auto& el : *arr)
            if (auto iv = el.value<int64_t>())
                b.active_connectors.push_back(static_cast<int>(*iv));

    b.pt_type = s_or(bt["pt_type"], "");
    b.adc_ref_voltage = d_or(bt["adc_ref_voltage"], 2.5);
    b.has_hp_pt_keys = bt.contains("hp_pt_connectors") || bt.contains("hp_pt_full_scale_psi");
    b.hp_pt_full_scale_psi = d_or(bt["hp_pt_full_scale_psi"], 5000.0);
    b.hp_pt_sense_resistor_ohms = d_or(bt["hp_pt_sense_resistor_ohms"], 120.0);
    return b;
}

Config from_table(const toml::table& t) {
    Config c;

    c.network.bind_ip = s_or(t["network"]["bind_ip"], c.network.bind_ip);
    c.network.sensor_port = static_cast<uint16_t>(i_or(t["network"]["sensor_port"], 5006));
    c.network.actuator_cmd_port =
        static_cast<uint16_t>(i_or(t["network"]["actuator_cmd_port"], 5005));

    c.database.host = s_or(t["database"]["host"], c.database.host);
    c.database.port = static_cast<uint16_t>(i_or(t["database"]["port"], 2240));

    c.server_heartbeat.interval_ms =
        static_cast<uint32_t>(i_or(t["server_heartbeat"]["interval_ms"], 1000));
    c.server_heartbeat.broadcast_port =
        static_cast<uint16_t>(i_or(t["server_heartbeat"]["broadcast_port"], 5005));
    c.server_heartbeat.broadcast_ip =
        s_or(t["server_heartbeat"]["broadcast_ip"], c.server_heartbeat.broadcast_ip);

    c.heartbeat_service.enabled = b_or(t["heartbeat_service"]["enabled"], false);
    c.heartbeat_service.interval_ms =
        static_cast<uint32_t>(i_or(t["heartbeat_service"]["interval_ms"], 1000));
    // broadcast_ip/port fall back to [server_heartbeat] when absent (matches the old heartbeat
    // main).
    c.heartbeat_service.broadcast_ip =
        s_or(t["heartbeat_service"]["broadcast_ip"],
             s_or(t["server_heartbeat"]["broadcast_ip"], c.heartbeat_service.broadcast_ip));
    c.heartbeat_service.broadcast_port =
        static_cast<uint16_t>(i_or(t["heartbeat_service"]["broadcast_port"],
                                   i_or(t["server_heartbeat"]["broadcast_port"], 5005)));
    c.heartbeat_service.elodin_host =
        s_or(t["heartbeat_service"]["elodin_host"], c.heartbeat_service.elodin_host);
    c.heartbeat_service.elodin_port =
        static_cast<uint16_t>(i_or(t["heartbeat_service"]["elodin_port"], 2240));

    // Default: the bridge sends the heartbeat unless the standalone service is enabled.
    c.server_heartbeat.send_from_daq_bridge =
        b_or(t["server_heartbeat"]["send_from_daq_bridge"], !c.heartbeat_service.enabled);

    c.logs.backend_udp_port = static_cast<uint16_t>(i_or(t["logs"]["backend_udp_port"], 8092));

    {
        const std::string m = s_or(t["time_sync"]["mode"], "board_clock");
        c.time_sync.mode = (m == "arrival") ? fsw::time::TimeSyncConfig::Mode::Arrival
                                            : fsw::time::TimeSyncConfig::Mode::BoardClock;
        c.time_sync.window_seconds =
            static_cast<uint32_t>(i_or(t["time_sync"]["window_seconds"], 10));
        c.time_sync.max_plausible_gap_s =
            static_cast<uint32_t>(i_or(t["time_sync"]["max_plausible_gap_s"], 60));
        c.time_sync.max_batch_age_s =
            static_cast<uint32_t>(i_or(t["time_sync"]["max_batch_age_s"], 5));
        c.time_sync.resync_threshold_ms =
            static_cast<uint32_t>(i_or(t["time_sync"]["resync_threshold_ms"], 1000));
        c.time_sync.log_interval_s =
            static_cast<uint32_t>(i_or(t["time_sync"]["log_interval_s"], 10));
    }

    c.config_broadcast_interval_ms =
        static_cast<uint32_t>(i_or(t["config_broadcast_service"]["interval_ms"], 1000));

    if (auto boards = t["boards"].as_table())
        for (auto&& [k, v] : *boards)
            if (auto bt = v.as_table())
                c.boards.push_back(parse_board("boards." + std::string(k.str()), *bt));

    if (auto ar = t["actuator_roles"].as_table())
        for (auto&& [k, v] : *ar)
            if (auto arr = v.as_array(); arr && arr->size() >= 3) {
                ActuatorRole r;
                r.kind = (*arr)[0].value<std::string>().value_or("NC");
                r.is_no = (r.kind == "NO" || r.kind == "no");
                r.channel = static_cast<int>((*arr)[1].value<int64_t>().value_or(0));
                r.board_id = static_cast<int>((*arr)[2].value<int64_t>().value_or(0));
                c.actuator_roles[std::string(k.str())] = r;
            }

    c.fire.state = s_or(t["fire"]["state"], "");
    c.fire.expiry_target = s_or(t["fire"]["expiry_target"], "");
    // Durations: [fire] is the home; fall back to the legacy [controller_service].fire_* keys.
    c.fire.duration_ms = static_cast<uint32_t>(
        i_or(t["fire"]["duration_ms"], i_or(t["controller_service"]["fire_duration_ms"], 6000)));
    c.fire.extended_ms = static_cast<uint32_t>(
        i_or(t["fire"]["extended_ms"], i_or(t["controller_service"]["fire_extended_ms"], 10000)));

    c.controller_service.port = static_cast<uint16_t>(i_or(t["controller_service"]["port"], 9999));
    c.controller_service.host = s_or(t["controller_service"]["host"], c.controller_service.host);
    c.controller_service.fire_duration_ms =
        static_cast<uint32_t>(i_or(t["controller_service"]["fire_duration_ms"], 6000));
    c.controller_service.fire_extended_ms =
        static_cast<uint32_t>(i_or(t["controller_service"]["fire_extended_ms"], 10000));

    c.controller.pwm_frequency_hz = d_or(t["controller"]["pwm_frequency_hz"], 10.0);
    c.controller.pwm_duration_ms =
        static_cast<uint32_t>(i_or(t["controller"]["pwm_duration_ms"], 10000));
    c.controller.controller_loop_hz = d_or(t["controller"]["controller_loop_hz"], 10.0);
    c.controller.P_copv_min_pa = d_or(t["controller"]["P_copv_min_pa"], 0.0);
    c.controller.fallback_fuel_duty_cycle = d_or(t["controller"]["fallback_fuel_duty_cycle"], 0.0);
    c.controller.fallback_ox_duty_cycle = d_or(t["controller"]["fallback_ox_duty_cycle"], 0.0);
    c.controller.lut_path = s_or(t["controller"]["lut_path"], "");
    c.controller.thrust_curve_path = s_or(t["controller"]["thrust_curve_path"], "");

    c.actuator_service.port = static_cast<uint16_t>(i_or(t["actuator_service"]["port"], 9998));
    c.actuator_service.bind_address =
        s_or(t["actuator_service"]["bind_address"], c.actuator_service.bind_address);

    c.calibration.tc_adc_ref_voltage = d_or(t["calibration"]["tc"]["adc_ref_voltage"], 2.5);
    c.calibration.rtd_adc_ref_voltage = d_or(t["calibration"]["rtd"]["adc_ref_voltage"], 2.5);
    c.calibration.rtd_excitation_ua = d_or(t["calibration"]["rtd"]["excitation_ua"], 1000.0);
    c.calibration.rtd_r0_ohm = d_or(t["calibration"]["rtd"]["r0_ohm"], 1000.0);
    c.calibration.lc_sensitivity_mv_per_v =
        d_or(t["calibration"]["lc"]["sensitivity_mv_per_v"], 2.0);
    c.calibration.lc_pga_gain = d_or(t["calibration"]["lc"]["pga_gain"], 32.0);
    c.calibration.lc_full_scale_value = d_or(t["calibration"]["lc"]["full_scale_value"], 300.0);

    c.state_machine.transitions_csv =
        s_or(t["state_machine"]["transitions_csv"], c.state_machine.transitions_csv);
    c.state_machine.actuator_csv =
        s_or(t["state_machine"]["actuator_csv"], c.state_machine.actuator_csv);
    c.state_machine.actuator_delay_csv =
        s_or(t["state_machine"]["actuator_delay_csv"], c.state_machine.actuator_delay_csv);

    if (auto states = t["states"].as_array())
        for (const auto& el : *states)
            if (auto st = el.as_table()) {
                StateDef s;
                s.id = static_cast<int>((*st)["id"].value<int64_t>().value_or(-1));
                s.name = (*st)["name"].value<std::string>().value_or("");
                s.is_abort = (*st)["is_abort"].value<bool>().value_or(false);
                s.is_boot = (*st)["is_boot"].value<bool>().value_or(false);
                c.states.push_back(s);
            }

    // All [sensor_roles*] top-level tables -> section -> {role name -> channel}.
    for (auto&& [k, v] : t) {
        const std::string key(k.str());
        if (key.rfind("sensor_roles", 0) == 0)
            if (auto rt = v.as_table()) {
                auto& m = c.sensor_roles[key];
                for (auto&& [rk, rv] : *rt)
                    if (auto iv = rv.value<int64_t>())
                        m[std::string(rk.str())] = static_cast<int>(*iv);
            }
    }

    if (auto ap = t["abort_pts"].as_table())
        for (auto&& [k, v] : *ap) {
            if (auto dv = v.value<double>())
                c.abort_pts[std::string(k.str())] = *dv;
            else if (auto iv = v.value<int64_t>())
                c.abort_pts[std::string(k.str())] = static_cast<double>(*iv);
        }

    // All [calibration_model*] top-level tables -> section -> {role name -> model string}.
    for (auto&& [k, v] : t) {
        const std::string key(k.str());
        if (key.rfind("calibration_model", 0) == 0)
            if (auto rt = v.as_table()) {
                auto& m = c.calibration_models[key];
                for (auto&& [rk, rv] : *rt)
                    if (auto sv = rv.value<std::string>())
                        m[std::string(rk.str())] = *sv;
            }
    }

    return c;
}

}  // namespace

const std::map<std::string, int>* Config::sensor_roles_for(const std::string& board_key) const {
    auto it = sensor_roles.find(board_key);
    if (it != sensor_roles.end() && !it->second.empty())
        return &it->second;
    it = sensor_roles.find("sensor_roles");  // legacy fallback (only if non-empty)
    if (it != sensor_roles.end() && !it->second.empty())
        return &it->second;
    return nullptr;
}

const std::map<std::string, std::string>* Config::calibration_model_for(
    const std::string& section_key) const {
    auto it = calibration_models.find(section_key);
    if (it != calibration_models.end() && !it->second.empty())
        return &it->second;
    return nullptr;
}

Config load(const std::string& path) {
    try {
        toml::table tbl = toml::parse_file(path);
        return from_table(tbl);
    } catch (const toml::parse_error& e) {
        std::cerr << "[Config] TOML parse error in " << path << ": " << e.description()
                  << std::endl;
        return Config{};
    } catch (const std::exception& e) {
        std::cerr << "[Config] Failed to read " << path << ": " << e.what() << std::endl;
        return Config{};
    }
}

Config load_from_string(const std::string& text) {
    try {
        toml::table tbl = toml::parse(text);
        return from_table(tbl);
    } catch (const toml::parse_error& e) {
        std::cerr << "[Config] TOML parse error (string): " << e.description() << std::endl;
        return Config{};
    }
}

std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> active_boards(const Config& cfg) {
    std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> result;
    std::map<ActiveBoardKind, std::map<uint8_t, std::string>> slot_owner;
    for (const auto& b : cfg.boards) {
        if (b.type.empty() || !b.enabled || b.board_id < 0)
            continue;
        ActiveBoardKind bt = kind_of(b.type);
        if (bt == ActiveBoardKind::UNKNOWN)
            continue;
        const uint8_t slot = b.slot();
        check_board_slots(slot_owner, bt, slot, b.section, b.board_id);

        elodin::BoardChannels bc;
        bc.board_id = static_cast<uint8_t>(b.board_id);
        bc.board_number = slot;
        if (!b.active_connectors.empty())
            for (int ch : b.active_connectors)
                bc.channels.push_back(static_cast<uint8_t>(ch));
        else
            for (int i = 1; i <= b.num_sensors; i++)
                bc.channels.push_back(static_cast<uint8_t>(i));
        result[bt].push_back(std::move(bc));
    }
    return result;
}

std::map<uint8_t, PtBoardConfig> pt_boards(const Config& cfg) {
    std::map<uint8_t, PtBoardConfig> result;
    bool warned_legacy = false;
    for (const auto& b : cfg.boards) {
        if (b.type != "PT" || !b.enabled || b.board_id < 0)
            continue;
        PtBoardConfig p;
        p.board_id = static_cast<uint8_t>(b.board_id);
        p.board_number = b.slot();

        if (!b.pt_type.empty()) {
            if (b.pt_type == "4-20 mA absolute") {
                p.interface = PtInterface::CURRENT_LOOP_4_20MA;
            } else if (b.pt_type == "0-5V ratiometric") {
                p.interface = PtInterface::RATIOMETRIC_0_5V;
            } else if (b.pt_type == "0-5V absolute") {
                std::cerr << "[Config] ERROR: [" << b.section << "] pt_type \"" << b.pt_type
                          << "\" is not supported by the PT firmware." << std::endl;
                p.interface = PtInterface::ABSOLUTE_0_5V;
            } else {
                std::cerr << "[Config] ERROR: [" << b.section << "] unknown pt_type \"" << b.pt_type
                          << "\"; treating as 0-5V ratiometric." << std::endl;
            }
        } else if (b.has_hp_pt_keys) {
            p.interface = PtInterface::CURRENT_LOOP_4_20MA;
            if (!warned_legacy) {
                warned_legacy = true;
                std::cerr << "[Config] DEPRECATED: [" << b.section
                          << "] has no pt_type; inferring \"4-20 mA absolute\" from its hp_pt_* "
                             "keys. Add pt_type to the board."
                          << std::endl;
            }
        }

        p.full_scale_psi = b.hp_pt_full_scale_psi;
        p.sense_resistor_ohms = b.hp_pt_sense_resistor_ohms;
        p.adc_ref_voltage = b.adc_ref_voltage;
        result[p.board_number] = p;
    }
    return result;
}

}  // namespace config
}  // namespace fsw
