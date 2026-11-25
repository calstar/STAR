#include "config/Config.hpp"

#include <arpa/inet.h>

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <toml++/toml.hpp>

namespace fsw {
namespace config {

namespace detail {
// T7Config.cpp — kept out of T7Config.hpp so the header does not drag toml++ into every includer.
std::vector<T7Board> parse_t7_boards(const toml::table& root, std::vector<std::string>& errors);
}  // namespace detail

namespace {

using CNV = toml::node_view<const toml::node>;

std::string type_name(const toml::node& n) {
    switch (n.type()) {
        case toml::node_type::string:
            return "a string";
        case toml::node_type::integer:
            return "an integer";
        case toml::node_type::floating_point:
            return "a float";
        case toml::node_type::boolean:
            return "a boolean";
        case toml::node_type::array:
            return "an array";
        case toml::node_type::table:
            return "a table";
        default:
            return "a date/time";
    }
}

// Every typed read of the TOML goes through here, so a value that is present but unusable is an
// error instead of a silent default (C2-6), an integer that does not fit its field is an error
// instead of a wrap (C2-5), and an address that inet_pton cannot read is an error instead of
// 0.0.0.0 (C1-8). An absent key still takes its default, exactly as before. Each problem names the
// key and the line; from_table() collects them all and load() throws them together (C2-4).
class Reader {
public:
    std::vector<std::string> errors;

    void fail(CNV n, const std::string& key, const std::string& what) {
        std::string where;
        if (const auto* node = n.node(); node && node->source().begin.line > 0)
            where = "line " + std::to_string(node->source().begin.line) + ": ";
        errors.push_back(where + key + " " + what);
    }

    std::string str(CNV n, const std::string& key, const std::string& d) {
        if (!n)
            return d;
        if (!n.is_string()) {
            fail(n, key, "must be a string, got " + type_name(*n.node()));
            return d;
        }
        return *n.value<std::string>();
    }

    bool boolean(CNV n, const std::string& key, bool d) {
        if (!n)
            return d;
        if (!n.is_boolean()) {
            fail(n, key, "must be true or false, got " + type_name(*n.node()));
            return d;
        }
        return *n.value<bool>();
    }

    // An integer is a number too: adc_ref_voltage = 5 has always meant 5.0.
    double num(CNV n, const std::string& key, double d) {
        if (!n)
            return d;
        if (!n.is_integer() && !n.is_floating_point()) {
            fail(n, key, "must be a number, got " + type_name(*n.node()));
            return d;
        }
        return *n.value<double>();
    }

    int64_t integer(CNV n, const std::string& key, int64_t d, int64_t lo, int64_t hi) {
        if (!n)
            return d;
        if (!n.is_integer()) {
            fail(n, key, "must be an integer, got " + type_name(*n.node()));
            return d;
        }
        const int64_t v = *n.value<int64_t>();
        if (v < lo || v > hi) {
            fail(n, key,
                 "= " + std::to_string(v) + " is out of range (" + std::to_string(lo) + " to " +
                     std::to_string(hi) + ")");
            return d;
        }
        return v;
    }

    uint16_t port(CNV n, const std::string& key, uint16_t d) {
        return static_cast<uint16_t>(integer(n, key, d, 1, 65535));
    }

    uint32_t u32(CNV n, const std::string& key, uint32_t d) {
        return static_cast<uint32_t>(integer(n, key, d, 0, 4294967295LL));
    }

    std::string ip(CNV n, const std::string& key, const std::string& d) {
        const bool present = static_cast<bool>(n) && n.is_string();
        std::string v = str(n, key, d);
        if (present && !is_ipv4(v)) {
            fail(n, key, "= \"" + v + "\" is not an IPv4 address");
            return d;
        }
        return v;
    }

    // A section the C++ side reads must be a table if it is there at all; `network = 5` would
    // otherwise make every key under it read as absent.
    void table(CNV n, const std::string& key) {
        if (n && !n.is_table())
            fail(n, key, "must be a table, got " + type_name(*n.node()));
    }
};

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

}  // namespace

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
    if (type_str == "ENVIRONMENTAL")
        return ActiveBoardKind::ENVIRONMENTAL;
    if (type_str == "ACTUATOR")
        return ActiveBoardKind::ACTUATOR;
    if (type_str == "BALL_VALVE")
        return ActiveBoardKind::BALL_VALVE;
    return ActiveBoardKind::UNKNOWN;
}

namespace {

const char* const kEnvIdRule = "environmental board ID must be an integer from 1 to 255";

BoardConfig parse_board(Reader& r, const std::string& section, const toml::table& bt) {
    const std::string k = "[" + section + "].";
    BoardConfig b;
    b.section = section;
    b.type = r.str(bt["type"], k + "type", "");
    b.ip = r.ip(bt["ip"], k + "ip", "");
    b.enabled = r.boolean(bt["enabled"], k + "enabled", true);
    const bool has_board_id = bt.contains("board_id");
    const auto id_node = has_board_id ? bt["board_id"] : bt["id"];
    const std::string id_key = k + (has_board_id ? "board_id" : "id");
    if (b.enabled && b.type == "ENVIRONMENTAL") {
        // Reported in its own words (the GUI's validator says the same), not as a range error.
        const int64_t id = id_node.is_integer() ? *id_node.value<int64_t>() : -1;
        if (id < 1 || id > 255)
            r.errors.push_back("[" + section + "] " + kEnvIdRule);
        else
            b.board_id = static_cast<int>(id);
    } else if (b.enabled) {
        // A board id is one byte on the wire (static_cast<uint8_t> in active_boards/pt_boards).
        b.board_id = static_cast<int>(r.integer(id_node, id_key, -1, 0, 255));
    } else {
        // A disabled board is never addressed, so only its type is checked.
        b.board_id = static_cast<int>(r.integer(id_node, id_key, -1, INT_MIN, INT_MAX));
    }
    b.num_actuators =
        static_cast<int>(r.integer(bt["num_actuators"], k + "num_actuators", 0, 0, 255));
    b.send_port = r.port(bt["send_port"], k + "send_port", 5005);
    b.listen_port = r.port(bt["listen_port"], k + "listen_port", 5005);
    b.voltage_reference = static_cast<int>(
        r.integer(bt["voltage_reference"], k + "voltage_reference", 0, INT_MIN, INT_MAX));
    b.necessary_for_abort = r.boolean(bt["necessary_for_abort"], k + "necessary_for_abort", false);
    b.designated_survivor = r.boolean(bt["designated_survivor"], k + "designated_survivor", false);

    // enable_serial_printing tolerates a bool or an int; clamp 0..3 (matches config_broadcast).
    int esp = 0;
    if (const auto n = bt["enable_serial_printing"]; n.is_boolean())
        esp = *n.value<bool>() ? 1 : 0;
    else
        esp = static_cast<int>(
            r.integer(n, k + "enable_serial_printing", 0, INT_MIN, INT_MAX));
    b.enable_serial_printing = std::clamp(esp, 0, 3);

    // Connector ids go on the wire as uint8_t sensor ids; 0 is no connector (config_broadcast has
    // always dropped it), so a usable id is 1-255.
    if (const auto n = bt["active_connectors"]; n) {
        if (const auto* arr = n.as_array()) {
            for (size_t i = 0; i < arr->size(); ++i) {
                const auto id = r.integer(
                    CNV((*arr)[i]), k + "active_connectors[" + std::to_string(i) + "]", 0, 1, 255);
                if (id > 0)
                    b.active_connectors.push_back(static_cast<int>(id));
            }
        } else {
            r.fail(n, k + "active_connectors",
                   "must be an array of connector ids, got " + type_name(*n.node()));
        }
    }

    b.pt_type = r.str(bt["pt_type"], k + "pt_type", "");
    b.adc_ref_voltage = r.num(bt["adc_ref_voltage"], k + "adc_ref_voltage", 2.5);
    b.has_hp_pt_keys = bt.contains("hp_pt_connectors") || bt.contains("hp_pt_full_scale_psi");
    b.hp_pt_full_scale_psi = r.num(bt["hp_pt_full_scale_psi"], k + "hp_pt_full_scale_psi", 5000.0);
    b.hp_pt_sense_resistor_ohms =
        r.num(bt["hp_pt_sense_resistor_ohms"], k + "hp_pt_sense_resistor_ohms", 120.0);
    return b;
}

// The environmental identity rules, as messages. Empty means the boards are fine.
std::vector<std::string> environmental_board_errors(const Config& cfg) {
    std::vector<std::string> out;
    std::map<int, std::string> owners;
    for (const auto& b : cfg.boards) {
        if (!b.enabled || b.type != "ENVIRONMENTAL")
            continue;
        if (b.board_id < 1 || b.board_id > 255) {
            out.push_back("[" + b.section + "] " + kEnvIdRule);
            continue;
        }
        const auto [owner, inserted] = owners.emplace(b.board_id, b.section);
        if (!inserted)
            out.push_back("environmental board ID " + std::to_string(b.board_id) +
                          " is claimed by both [" + owner->second + "] and [" + b.section + "]");
    }
    return out;
}

void validate_environmental_boards(const Config& cfg) {
    auto errors = environmental_board_errors(cfg);
    if (!errors.empty())
        throw ConfigError("board table", std::move(errors));
}

// A map section of role -> number ([abort_pts], [calibration_full_scale_*], ...).
void read_number_map(Reader& r, const std::string& key, const toml::table& rt,
                     std::map<std::string, double>& m) {
    for (auto&& [rk, rv] : rt) {
        const std::string name(rk.str());
        const CNV n(rv);
        if (n.is_integer() || n.is_floating_point())
            m[name] = *n.value<double>();
        else
            r.fail(n, "[" + key + "].\"" + name + "\"", "must be a number, got " + type_name(rv));
    }
}

Config from_table(const toml::table& t, std::vector<std::string>& errors) {
    Reader r;
    Config c;

    for (const char* sec :
         {"network", "database", "server_heartbeat", "heartbeat_service", "logs", "time_sync",
          "config_broadcast_service", "boards", "actuator_roles", "fire", "flow",
          "controller_service", "controller", "actuator_service", "sequencer", "calibration",
          "state_machine", "abort_pts"})
        r.table(t[sec], std::string("[") + sec + "]");
    for (const char* sec : {"tc", "rtd", "lc"})
        r.table(t["calibration"][sec], std::string("[calibration.") + sec + "]");

    c.network.bind_ip = r.ip(t["network"]["bind_ip"], "[network].bind_ip", c.network.bind_ip);
    c.network.sensor_port = r.port(t["network"]["sensor_port"], "[network].sensor_port", 5006);
    c.network.actuator_cmd_port =
        r.port(t["network"]["actuator_cmd_port"], "[network].actuator_cmd_port", 5005);

    c.database.host = r.ip(t["database"]["host"], "[database].host", c.database.host);
    c.database.port = r.port(t["database"]["port"], "[database].port", 2240);

    c.server_heartbeat.interval_ms =
        r.u32(t["server_heartbeat"]["interval_ms"], "[server_heartbeat].interval_ms", 1000);
    c.server_heartbeat.broadcast_port =
        r.port(t["server_heartbeat"]["broadcast_port"], "[server_heartbeat].broadcast_port", 5005);
    c.server_heartbeat.broadcast_ip =
        r.ip(t["server_heartbeat"]["broadcast_ip"], "[server_heartbeat].broadcast_ip",
             c.server_heartbeat.broadcast_ip);
    // 0 turns the backend's SERVER_HEARTBEAT watch off, so it is not a port() (1..65535).
    c.server_heartbeat.monitor_port = static_cast<uint16_t>(
        r.integer(t["server_heartbeat"]["monitor_port"], "[server_heartbeat].monitor_port",
                  c.server_heartbeat.monitor_port, 0, 65535));

    c.heartbeat_service.enabled =
        r.boolean(t["heartbeat_service"]["enabled"], "[heartbeat_service].enabled", false);
    c.heartbeat_service.interval_ms =
        r.u32(t["heartbeat_service"]["interval_ms"], "[heartbeat_service].interval_ms", 1000);
    // broadcast_ip/port fall back to [server_heartbeat] when absent (matches the old heartbeat
    // main).
    c.heartbeat_service.broadcast_ip =
        r.ip(t["heartbeat_service"]["broadcast_ip"], "[heartbeat_service].broadcast_ip",
             r.ip(t["server_heartbeat"]["broadcast_ip"], "[server_heartbeat].broadcast_ip",
                  c.heartbeat_service.broadcast_ip));
    c.heartbeat_service.broadcast_port =
        r.port(t["heartbeat_service"]["broadcast_port"], "[heartbeat_service].broadcast_port",
               r.port(t["server_heartbeat"]["broadcast_port"], "[server_heartbeat].broadcast_port",
                      5005));
    c.heartbeat_service.elodin_host =
        r.ip(t["heartbeat_service"]["elodin_host"], "[heartbeat_service].elodin_host",
             c.heartbeat_service.elodin_host);
    c.heartbeat_service.elodin_port =
        r.port(t["heartbeat_service"]["elodin_port"], "[heartbeat_service].elodin_port", 2240);

    // Default: the bridge sends the heartbeat unless the standalone service is enabled.
    c.server_heartbeat.send_from_daq_bridge =
        r.boolean(t["server_heartbeat"]["send_from_daq_bridge"],
                  "[server_heartbeat].send_from_daq_bridge", !c.heartbeat_service.enabled);

    c.logs.backend_udp_port =
        r.port(t["logs"]["backend_udp_port"], "[logs].backend_udp_port", 8092);

    {
        const std::string m = r.str(t["time_sync"]["mode"], "[time_sync].mode", "board_clock");
        c.time_sync.mode = (m == "arrival") ? fsw::time::TimeSyncConfig::Mode::Arrival
                                            : fsw::time::TimeSyncConfig::Mode::BoardClock;
        c.time_sync.window_seconds =
            r.u32(t["time_sync"]["window_seconds"], "[time_sync].window_seconds", 10);
        c.time_sync.max_plausible_gap_s =
            r.u32(t["time_sync"]["max_plausible_gap_s"], "[time_sync].max_plausible_gap_s", 60);
        c.time_sync.max_batch_age_s =
            r.u32(t["time_sync"]["max_batch_age_s"], "[time_sync].max_batch_age_s", 5);
        c.time_sync.resync_threshold_ms =
            r.u32(t["time_sync"]["resync_threshold_ms"], "[time_sync].resync_threshold_ms", 1000);
        c.time_sync.log_interval_s =
            r.u32(t["time_sync"]["log_interval_s"], "[time_sync].log_interval_s", 10);
    }

    c.config_broadcast_interval_ms = r.u32(t["config_broadcast_service"]["interval_ms"],
                                           "[config_broadcast_service].interval_ms", 1000);

    if (auto boards = t["boards"].as_table())
        for (auto&& [k, v] : *boards) {
            const std::string section = "boards." + std::string(k.str());
            if (auto bt = v.as_table()) {
                // A LabJack T7 is validated by parse_t7_boards into t7_errors, which t7_bridge
                // refuses with its own exit 2 and every other reader skips (unknown type). Its
                // keys mean different things there, so the generic board checks do not apply.
                const bool t7 = (*bt)["type"].value<std::string>().value_or("") == "T7";
                Reader t7_reader;
                c.boards.push_back(parse_board(t7 ? t7_reader : r, section, *bt));
            } else
                r.fail(CNV(v), "[" + section + "]", "must be a table, got " + type_name(v));
        }

    if (auto ar = t["actuator_roles"].as_table())
        for (auto&& [k, v] : *ar) {
            const std::string key = "[actuator_roles].\"" + std::string(k.str()) + "\"";
            const auto* arr = v.as_array();
            if (!arr || arr->size() < 3 || arr->size() > 4) {
                r.fail(CNV(v), key,
                       "must be [\"NC\" or \"NO\", channel, board_id] with an optional "
                       "controller role, got " +
                           (arr ? "an array of " + std::to_string(arr->size()) : type_name(v)));
                continue;
            }
            ActuatorRole role;
            role.kind = r.str(CNV((*arr)[0]), key + "[0] (NC/NO)", "NC");
            role.is_no = (role.kind == "NO" || role.kind == "no");
            role.channel =
                static_cast<int>(r.integer(CNV((*arr)[1]), key + "[1] (channel)", 0, 0, 255));
            role.board_id =
                static_cast<int>(r.integer(CNV((*arr)[2]), key + "[2] (board_id)", 0, 0, 255));
            // Optional 4th element: which controller_service PWM output this actuator serves
            // ("pwm_fuel" / "pwm_ox"). Absent means the sequencer owns it.
            if (arr->size() >= 4)
                role.controller_role = r.str(CNV((*arr)[3]), key + "[3] (controller role)", "");
            c.actuator_roles[std::string(k.str())] = role;
        }

    // A role on a BALL_VALVE board has no polarity: 1 is open and 0 is closed on the wire. Force
    // pass-through so a stray "NO" cannot invert it (config validation rejects "NO" there too).
    for (auto& [name, role] : c.actuator_roles) {
        for (const auto& b : c.boards) {
            if (b.board_id != role.board_id || kind_of(b.type) != ActiveBoardKind::BALL_VALVE)
                continue;
            role.ball_valve = true;
            if (role.is_no)
                std::cerr << "[Config] WARNING: actuator role '" << name
                          << "' is on ball valve board " << role.board_id
                          << " and is marked NO; ball valves have no NO/NC, treating it as "
                             "pass-through (1 = open)."
                          << std::endl;
            role.is_no = false;
            break;
        }
    }

    c.fire.state = r.str(t["fire"]["state"], "[fire].state", "");
    c.fire.expiry_target = r.str(t["fire"]["expiry_target"], "[fire].expiry_target", "");
    // Durations: [fire] is the home; fall back to the legacy [controller_service].fire_* keys.
    c.fire.duration_ms = r.u32(t["fire"]["duration_ms"], "[fire].duration_ms",
                               r.u32(t["controller_service"]["fire_duration_ms"],
                                     "[controller_service].fire_duration_ms", 6000));
    c.fire.extended_ms = r.u32(t["fire"]["extended_ms"], "[fire].extended_ms",
                               r.u32(t["controller_service"]["fire_extended_ms"],
                                     "[controller_service].fire_extended_ms", 10000));

    // [flow] — the characterization hold. No `state` key by design: which state this is comes from
    // the is_flow flag on a [[states]] entry, so a rename cannot orphan it the way [fire].state
    // can.
    c.flow.return_target = r.str(t["flow"]["return_target"], "[flow].return_target", "");
    c.flow.duration_ms = r.u32(t["flow"]["duration_ms"], "[flow].duration_ms", 0);
    c.flow.max_ms = r.u32(t["flow"]["max_ms"], "[flow].max_ms", 0);
    c.fire.gate_actuator = r.str(t["fire"]["gate_actuator"], "[fire].gate_actuator", "");
    c.flow.gate_actuator = r.str(t["flow"]["gate_actuator"], "[flow].gate_actuator", "");

    c.controller_service.port =
        r.port(t["controller_service"]["port"], "[controller_service].port", 9999);
    c.controller_service.host = r.ip(t["controller_service"]["host"], "[controller_service].host",
                                     c.controller_service.host);
    c.controller_service.fire_duration_ms = r.u32(t["controller_service"]["fire_duration_ms"],
                                                  "[controller_service].fire_duration_ms", 6000);
    c.controller_service.fire_extended_ms = r.u32(t["controller_service"]["fire_extended_ms"],
                                                  "[controller_service].fire_extended_ms", 10000);
    c.controller_service.sequencer_owns_valves =
        r.boolean(t["controller_service"]["sequencer_owns_valves"],
                  "[controller_service].sequencer_owns_valves", false);

    const auto ctl = [&](const char* key) {
        return t["controller"][key];
    };
    c.controller.pwm_frequency_hz =
        r.num(ctl("pwm_frequency_hz"), "[controller].pwm_frequency_hz", 10.0);
    c.controller.pwm_duration_ms =
        r.u32(ctl("pwm_duration_ms"), "[controller].pwm_duration_ms", 10000);
    c.controller.controller_loop_hz =
        r.num(ctl("controller_loop_hz"), "[controller].controller_loop_hz", 10.0);
    c.controller.P_copv_min_pa = r.num(ctl("P_copv_min_pa"), "[controller].P_copv_min_pa", 0.0);
    c.controller.fallback_fuel_duty_cycle =
        r.num(ctl("fallback_fuel_duty_cycle"), "[controller].fallback_fuel_duty_cycle", 0.0);
    c.controller.fallback_ox_duty_cycle =
        r.num(ctl("fallback_ox_duty_cycle"), "[controller].fallback_ox_duty_cycle", 0.0);
    c.controller.lut_path = r.str(ctl("lut_path"), "[controller].lut_path", "");
    c.controller.thrust_curve_path =
        r.str(ctl("thrust_curve_path"), "[controller].thrust_curve_path", "");

    c.actuator_service.port =
        r.port(t["actuator_service"]["port"], "[actuator_service].port", 9998);
    c.actuator_service.bind_address =
        r.ip(t["actuator_service"]["bind_address"], "[actuator_service].bind_address",
             c.actuator_service.bind_address);
    c.sequencer.command_deadline_ms =
        r.u32(t["sequencer"]["command_deadline_ms"], "[sequencer].command_deadline_ms",
              c.sequencer.command_deadline_ms);
    c.sequencer.wedge_threshold_ms =
        r.u32(t["sequencer"]["wedge_threshold_ms"], "[sequencer].wedge_threshold_ms",
              c.sequencer.wedge_threshold_ms);

    const auto cal = [&](const char* type, const char* key) {
        return t["calibration"][type][key];
    };
    const auto cal_key = [](const char* type, const char* key) {
        return std::string("[calibration.") + type + "]." + key;
    };
    c.calibration.tc_adc_ref_voltage =
        r.num(cal("tc", "adc_ref_voltage"), cal_key("tc", "adc_ref_voltage"), 2.5);
    c.calibration.rtd_adc_ref_voltage =
        r.num(cal("rtd", "adc_ref_voltage"), cal_key("rtd", "adc_ref_voltage"), 2.5);
    c.calibration.rtd_excitation_ua =
        r.num(cal("rtd", "excitation_ua"), cal_key("rtd", "excitation_ua"), 1000.0);
    c.calibration.rtd_r0_ohm = r.num(cal("rtd", "r0_ohm"), cal_key("rtd", "r0_ohm"), 1000.0);
    c.calibration.lc_sensitivity_mv_per_v =
        r.num(cal("lc", "sensitivity_mv_per_v"), cal_key("lc", "sensitivity_mv_per_v"), 2.0);
    c.calibration.lc_pga_gain = r.num(cal("lc", "pga_gain"), cal_key("lc", "pga_gain"), 32.0);
    c.calibration.lc_full_scale_value =
        r.num(cal("lc", "full_scale_value"), cal_key("lc", "full_scale_value"), 300.0);

    // [calibration.<type>] coefficient sources (json_dir + first of csv_paths) — previously
    // ignored.
    auto first_csv = [&](const char* type) -> std::string {
        const auto n = cal(type, "csv_paths");
        if (!n)
            return std::string();
        const auto* arr = n.as_array();
        if (!arr) {
            r.fail(n, cal_key(type, "csv_paths"),
                   "must be an array of paths, got " + type_name(*n.node()));
            return std::string();
        }
        std::string first;
        bool have_first = false;
        for (size_t i = 0; i < arr->size(); ++i) {
            const std::string v = r.str(
                CNV((*arr)[i]), cal_key(type, "csv_paths") + "[" + std::to_string(i) + "]", "");
            if (!have_first && (*arr)[i].is_string()) {
                first = v;
                have_first = true;
            }
        }
        return first;
    };
    c.calibration.tc_json_dir = r.str(cal("tc", "json_dir"), cal_key("tc", "json_dir"), "");
    c.calibration.tc_csv_path = first_csv("tc");
    c.calibration.rtd_json_dir = r.str(cal("rtd", "json_dir"), cal_key("rtd", "json_dir"), "");
    c.calibration.rtd_csv_path = first_csv("rtd");
    c.calibration.lc_json_dir = r.str(cal("lc", "json_dir"), cal_key("lc", "json_dir"), "");
    c.calibration.lc_csv_path = first_csv("lc");

    c.state_machine.transitions_csv =
        r.str(t["state_machine"]["transitions_csv"], "[state_machine].transitions_csv",
              c.state_machine.transitions_csv);
    c.state_machine.actuator_csv =
        r.str(t["state_machine"]["actuator_csv"], "[state_machine].actuator_csv",
              c.state_machine.actuator_csv);
    c.state_machine.actuator_delay_csv =
        r.str(t["state_machine"]["actuator_delay_csv"], "[state_machine].actuator_delay_csv",
              c.state_machine.actuator_delay_csv);

    if (const auto states = t["states"]; states) {
        const auto* arr = states.as_array();
        if (!arr)
            r.fail(states, "[[states]]",
                   "must be an array of tables, got " + type_name(*states.node()));
        // name -> where it was first declared. A repeated name used to be last-wins in the
        // sequencer's by_name map (C2-9), so a command for it reached whichever came last.
        std::map<std::string, size_t> first_by_name;
        for (size_t i = 0; arr && i < arr->size(); ++i) {
            const std::string k = "[[states]] #" + std::to_string(i + 1) + " ";
            const auto* st = (*arr)[i].as_table();
            if (!st) {
                r.fail(CNV((*arr)[i]), k, "must be a table, got " + type_name((*arr)[i]));
                continue;
            }
            StateDef s;
            // A state id is one byte: the sequencer publishes it as uint8_t.
            s.id = static_cast<int>(r.integer((*st)["id"], k + "id", -1, 0, 255));
            s.name = r.str((*st)["name"], k + "name", "");
            s.is_abort = r.boolean((*st)["is_abort"], k + "is_abort", false);
            s.is_boot = r.boolean((*st)["is_boot"], k + "is_boot", false);
            s.is_flow = r.boolean((*st)["is_flow"], k + "is_flow", false);
            s.script_file = r.str((*st)["script_file"], k + "script_file", "");
            s.script_timeout_ms = r.u32((*st)["script_timeout_ms"], k + "script_timeout_ms", 0);
            s.script_return_target =
                r.str((*st)["script_return_target"], k + "script_return_target", "");
            s.script_timeout_target =
                r.str((*st)["script_timeout_target"], k + "script_timeout_target", "");
            if (!s.name.empty()) {
                const auto [prev, inserted] = first_by_name.emplace(s.name, i + 1);
                if (!inserted)
                    r.fail((*st)["name"], k + "name",
                           "\"" + s.name + "\" is already the name of [[states]] #" +
                               std::to_string(prev->second) + "; state names must be unique");
            }
            c.states.push_back(s);
        }
    }

    // All [sensor_roles*] top-level tables -> section -> {role name -> channel}.
    for (auto&& [k, v] : t) {
        const std::string key(k.str());
        if (key.rfind("sensor_roles", 0) != 0)
            continue;
        const auto* rt = v.as_table();
        if (!rt) {
            r.fail(CNV(v), "[" + key + "]", "must be a table, got " + type_name(v));
            continue;
        }
        auto& m = c.sensor_roles[key];
        for (auto&& [rk, rv] : *rt) {
            const std::string name(rk.str());
            const auto ch =
                r.integer(CNV(rv), "[" + key + "].\"" + name + "\" (channel)", -1, 0, 255);
            if (ch >= 0)
                m[name] = static_cast<int>(ch);
        }
    }

    if (auto ap = t["abort_pts"].as_table())
        read_number_map(r, "abort_pts", *ap, c.abort_pts);

    // All [calibration_model*] top-level tables -> section -> {role name -> model string}.
    for (auto&& [k, v] : t) {
        const std::string key(k.str());
        if (key.rfind("calibration_model", 0) != 0)
            continue;
        const auto* rt = v.as_table();
        if (!rt) {
            r.fail(CNV(v), "[" + key + "]", "must be a table, got " + type_name(v));
            continue;
        }
        auto& m = c.calibration_models[key];
        for (auto&& [rk, rv] : *rt) {
            const std::string name(rk.str());
            if (rv.is_string())
                m[name] = *rv.value<std::string>();
            else
                r.fail(CNV(rv), "[" + key + "].\"" + name + "\"",
                       "must be a string, got " + type_name(rv));
        }
    }

    // Per-sensor physics params: [calibration_full_scale*] and [calibration_sense_resistor*] as
    // role -> double sections (accept int or double).
    for (auto&& [k, v] : t) {
        const std::string key(k.str());
        std::map<std::string, std::map<std::string, double>>* target = nullptr;
        if (key.rfind("calibration_full_scale", 0) == 0)
            target = &c.calibration_full_scale;
        else if (key.rfind("calibration_sense_resistor", 0) == 0)
            target = &c.calibration_sense_resistor;
        else if (key.rfind("calibration_sensitivity", 0) == 0)
            target = &c.calibration_sensitivity;
        else if (key.rfind("calibration_pga", 0) == 0)
            target = &c.calibration_pga_gain;
        if (!target)
            continue;
        if (auto rt = v.as_table())
            read_number_map(r, key, *rt, (*target)[key]);
        else
            r.fail(CNV(v), "[" + key + "]", "must be a table, got " + type_name(v));
    }

    for (auto& e : environmental_board_errors(c))
        r.errors.push_back(std::move(e));
    c.t7_boards = detail::parse_t7_boards(t, c.t7_errors);

    // A key read twice (the [fire] fallbacks) reports once.
    for (auto& e : r.errors)
        if (std::find(errors.begin(), errors.end(), e) == errors.end())
            errors.push_back(std::move(e));
    return c;
}

Config parse_checked(const std::string& source, const std::function<toml::table()>& parse) {
    std::vector<std::string> errors;
    Config c;
    try {
        c = from_table(parse(), errors);
    } catch (const toml::parse_error& e) {
        const auto& at = e.source().begin;
        errors.push_back((at.line > 0 ? "line " + std::to_string(at.line) + ": " : std::string()) +
                         "not valid TOML: " + std::string(e.description()));
    }
    if (!errors.empty())
        throw ConfigError(source, std::move(errors));
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

const std::map<std::string, double>* Config::full_scale_for(const std::string& section_key) const {
    auto it = calibration_full_scale.find(section_key);
    if (it != calibration_full_scale.end() && !it->second.empty())
        return &it->second;
    return nullptr;
}

const std::map<std::string, double>* Config::sense_resistor_for(
    const std::string& section_key) const {
    auto it = calibration_sense_resistor.find(section_key);
    if (it != calibration_sense_resistor.end() && !it->second.empty())
        return &it->second;
    return nullptr;
}

const std::map<std::string, double>* Config::sensitivity_for(const std::string& section_key) const {
    auto it = calibration_sensitivity.find(section_key);
    if (it != calibration_sensitivity.end() && !it->second.empty())
        return &it->second;
    return nullptr;
}

const std::map<std::string, double>* Config::pga_gain_for(const std::string& section_key) const {
    auto it = calibration_pga_gain.find(section_key);
    if (it != calibration_pga_gain.end() && !it->second.empty())
        return &it->second;
    return nullptr;
}

namespace {
std::string join_problems(const std::string& source, const std::vector<std::string>& problems) {
    std::string out = "[Config] " + source + " refused: ";
    for (size_t i = 0; i < problems.size(); ++i)
        out += (i ? "; " : "") + problems[i];
    return out;
}
}  // namespace

ConfigError::ConfigError(const std::string& source, std::vector<std::string> problems)
    : std::invalid_argument(join_problems(source, problems)),
      source_(source),
      problems_(std::move(problems)) {}

bool is_ipv4(const std::string& s) {
    in_addr a{};
    return inet_pton(AF_INET, s.c_str(), &a) == 1;
}

Config load(const std::string& path) {
    {
        std::ifstream f(path);
        if (!f.is_open())
            throw ConfigError(path, {"cannot open the file (" + std::string(std::strerror(errno)) +
                                         ")"});
    }
    return parse_checked(path, [&] {
        return toml::parse_file(path);
    });
}

Config load_from_string(const std::string& text) {
    return parse_checked("config text", [&] {
        return toml::parse(text);
    });
}

int report_refused(const ConfigError& e, const std::string& tag) {
    std::cerr << tag << " FATAL: config " << e.source() << " refused, " << e.problems().size()
              << (e.problems().size() == 1 ? " problem:" : " problems:") << std::endl;
    for (const auto& p : e.problems())
        std::cerr << tag << "   " << p << std::endl;
    std::cerr << tag << " Not starting (exit " << kExitConfig
              << ", EX_CONFIG): systemd will not restart this until the config is fixed."
              << std::endl;
    return kExitConfig;
}

int load_at_startup(const std::string& path, const std::string& tag, Config& out) {
    try {
        out = load(path);
        return 0;
    } catch (const ConfigError& e) {
        return report_refused(e, tag);
    }
}

std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> active_boards(const Config& cfg) {
    validate_environmental_boards(cfg);
    std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> result;
    std::map<ActiveBoardKind, std::map<uint8_t, std::string>> slot_owner;
    for (const auto& b : cfg.boards) {
        if (b.type.empty() || !b.enabled || b.board_id < 0)
            continue;
        ActiveBoardKind bt = kind_of(b.type);
        if (bt == ActiveBoardKind::UNKNOWN)
            continue;
        const uint8_t slot = b.slot();
        // Environmental tables use the full board ID, not a channel-slot block.
        if (bt != ActiveBoardKind::ENVIRONMENTAL)
            check_board_slots(slot_owner, bt, slot, b.section, b.board_id);

        elodin::BoardChannels bc;
        bc.board_id = static_cast<uint8_t>(b.board_id);
        bc.board_number = slot;
        // active_connectors is the only statement of which channels exist; an empty list
        // means none. This used to fall back to 1..num_sensors, a config-only field with
        // no counterpart on the wire or in firmware.
        for (int ch : b.active_connectors)
            bc.channels.push_back(static_cast<uint8_t>(ch));
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
