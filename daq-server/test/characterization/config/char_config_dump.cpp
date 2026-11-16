// Characterization dump of every C++ config loader (docs/remaster/LEDGER.md, area "config").
//
// One input set per process: config loaders keep static state (StateMachine's [[states]] layer,
// config_broadcast's warning set), so a fresh process per file is what keeps one golden from
// depending on the order the files were dumped in.
//
//   char_config_dump [--config P] [--transitions P] [--actuators P] [--delays P]
//                    [--config-dir D] [--script P --state NAME] [--fixed]
//
// Everything the loaders print to std::cout / std::cerr is captured and emitted at the end in its
// own section, so the golden is one deterministic file with no interleaving of two streams. A
// loader that throws is recorded as EXCEPTION <type>: <what> and the next section still runs.
// Paths are passed relative to the cwd (the ctest WORKING_DIRECTORY) so every message that echoes
// a path is machine independent, and so the loaders' cwd-relative fallbacks (config/..., ../config/
// ...) resolve to nothing.

#include <cctype>
#include <charconv>
#include <cstdio>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <typeinfo>
#include <vector>

#include "config/BoardDiscovery.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "config/SensorAssignment.hpp"
#include "config/SensorTables.hpp"
#include "control/HoldParse.hpp"
#include "control/PWMTargets.hpp"
#include "control/ScriptStates.hpp"
#include "control/StateMachine.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "script/ScriptConfig.hpp"
#include "script/StateScript.hpp"

// ActuatorCommander keeps what it parsed (roles, both tables, the bind address) private, and its
// public accessors are lookups that cannot enumerate. Open it up for this TU only; everything it
// includes is included above first so the macro reaches nothing but this one class.
#include "elodin/ElodinClient.hpp"
#define private public
#include "control/ActuatorCommander.hpp"
#undef private

namespace {

std::ostringstream OUT;  // the dump proper
bool g_threw = false;

std::string num(double v) {
    char buf[64];
    auto r = std::to_chars(buf, buf + sizeof(buf), v);
    return std::string(buf, r.ptr);
}
std::string q(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\')
            o += '\\', o += c;
        else if (c == '\n')
            o += "\\n";
        else if (c == '\r')
            o += "\\r";
        else if (c == '\t')
            o += "\\t";
        else
            o += c;
    }
    return o + "\"";
}
const char* b(bool v) {
    return v ? "true" : "false";
}
std::string hex2(unsigned v) {
    char buf[8];
    std::snprintf(buf, sizeof(buf), "0x%02X", v & 0xFF);
    return buf;
}

void section(const std::string& name, const std::function<void()>& fn) {
    OUT << "\n=== " << name << "\n";
    try {
        fn();
    } catch (const std::invalid_argument& e) {
        OUT << "EXCEPTION std::invalid_argument: " << e.what() << "\n";
        g_threw = true;
    } catch (const std::exception& e) {
        OUT << "EXCEPTION std::exception: " << e.what() << "\n";
        g_threw = true;
    } catch (...) {
        OUT << "EXCEPTION (non-std)\n";
        g_threw = true;
    }
}

bool readFile(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open())
        return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

const char* kind_name(fsw::config::ActiveBoardKind k) {
    using K = fsw::config::ActiveBoardKind;
    switch (k) {
        case K::PT:
            return "PT";
        case K::LC:
            return "LC";
        case K::TC:
            return "TC";
        case K::RTD:
            return "RTD";
        case K::ACTUATOR:
            return "ACTUATOR";
        case K::ENCODER:
            return "ENCODER";
        case K::ENVIRONMENTAL:
            return "ENVIRONMENTAL";
        case K::BALL_VALVE:
            return "BALL_VALVE";
        case K::UNKNOWN:
            return "UNKNOWN";
    }
    return "?";
}

const char* iface_name(fsw::config::PtInterface i) {
    using I = fsw::config::PtInterface;
    switch (i) {
        case I::RATIOMETRIC_0_5V:
            return "RATIOMETRIC_0_5V";
        case I::CURRENT_LOOP_4_20MA:
            return "CURRENT_LOOP_4_20MA";
        case I::ABSOLUTE_0_5V:
            return "ABSOLUTE_0_5V";
    }
    return "?";
}

std::string state_str(sequencer::State s) {
    return std::to_string(static_cast<int>(s)) + " " + q(sequencer::StateMachine::name(s));
}

// ── Config (lib/src/config/Config.cpp) ───────────────────────────────────────────────────────────
void dump_config(const std::string& p, const fsw::config::Config& c) {
    OUT << p << "network.bind_ip = " << q(c.network.bind_ip) << "\n";
    OUT << p << "network.sensor_port = " << c.network.sensor_port << "\n";
    OUT << p << "network.actuator_cmd_port = " << c.network.actuator_cmd_port << "\n";
    OUT << p << "database.host = " << q(c.database.host) << "\n";
    OUT << p << "database.port = " << c.database.port << "\n";
    OUT << p << "server_heartbeat.interval_ms = " << c.server_heartbeat.interval_ms << "\n";
    OUT << p << "server_heartbeat.broadcast_port = " << c.server_heartbeat.broadcast_port << "\n";
    OUT << p << "server_heartbeat.broadcast_ip = " << q(c.server_heartbeat.broadcast_ip) << "\n";
    OUT << p
        << "server_heartbeat.send_from_daq_bridge = " << b(c.server_heartbeat.send_from_daq_bridge)
        << "\n";
    const auto& hs = c.heartbeat_service;
    OUT << p << "heartbeat_service.enabled = " << b(hs.enabled) << "\n";
    OUT << p << "heartbeat_service.interval_ms = " << hs.interval_ms << "\n";
    OUT << p << "heartbeat_service.broadcast_ip = " << q(hs.broadcast_ip) << "\n";
    OUT << p << "heartbeat_service.broadcast_port = " << hs.broadcast_port << "\n";
    OUT << p << "heartbeat_service.elodin_host = " << q(hs.elodin_host) << "\n";
    OUT << p << "heartbeat_service.elodin_port = " << hs.elodin_port << "\n";
    OUT << p << "logs.backend_udp_port = " << c.logs.backend_udp_port << "\n";
    const auto& ts = c.time_sync;
    OUT << p << "time_sync.mode = "
        << (ts.mode == fsw::time::TimeSyncConfig::Mode::Arrival ? "Arrival" : "BoardClock") << "\n";
    OUT << p << "time_sync.window_seconds = " << ts.window_seconds << "\n";
    OUT << p << "time_sync.max_plausible_gap_s = " << ts.max_plausible_gap_s << "\n";
    OUT << p << "time_sync.max_batch_age_s = " << ts.max_batch_age_s << "\n";
    OUT << p << "time_sync.resync_threshold_ms = " << ts.resync_threshold_ms << "\n";
    OUT << p << "time_sync.log_interval_s = " << ts.log_interval_s << "\n";
    OUT << p << "config_broadcast_interval_ms = " << c.config_broadcast_interval_ms << "\n";

    OUT << p << "boards.count = " << c.boards.size() << "\n";
    for (size_t i = 0; i < c.boards.size(); ++i) {
        const auto& x = c.boards[i];
        const std::string bp = p + "boards[" + std::to_string(i) + "].";
        OUT << bp << "section = " << q(x.section) << "\n";
        OUT << bp << "type = " << q(x.type) << "\n";
        OUT << bp << "ip = " << q(x.ip) << "\n";
        OUT << bp << "board_id = " << x.board_id << "\n";
        OUT << bp << "slot() = " << static_cast<int>(x.slot()) << "\n";
        OUT << bp << "enabled = " << b(x.enabled) << "\n";
        OUT << bp << "num_actuators = " << x.num_actuators << "\n";
        OUT << bp << "send_port = " << x.send_port << "\n";
        OUT << bp << "listen_port = " << x.listen_port << "\n";
        OUT << bp << "enable_serial_printing = " << x.enable_serial_printing << "\n";
        OUT << bp << "voltage_reference = " << x.voltage_reference << "\n";
        OUT << bp << "necessary_for_abort = " << b(x.necessary_for_abort) << "\n";
        OUT << bp << "designated_survivor = " << b(x.designated_survivor) << "\n";
        OUT << bp << "active_connectors = [";
        for (size_t k = 0; k < x.active_connectors.size(); ++k)
            OUT << (k ? ", " : "") << x.active_connectors[k];
        OUT << "]\n";
        OUT << bp << "pt_type = " << q(x.pt_type) << "\n";
        OUT << bp << "adc_ref_voltage = " << num(x.adc_ref_voltage) << "\n";
        OUT << bp << "has_hp_pt_keys = " << b(x.has_hp_pt_keys) << "\n";
        OUT << bp << "hp_pt_full_scale_psi = " << num(x.hp_pt_full_scale_psi) << "\n";
        OUT << bp << "hp_pt_sense_resistor_ohms = " << num(x.hp_pt_sense_resistor_ohms) << "\n";
        OUT << bp << "kind_of(type) = " << kind_name(fsw::config::kind_of(x.type)) << "\n";
        OUT << bp << "board_key_of = " << q(fsw::config::board_key_of(x)) << "\n";
    }

    OUT << p << "t7_boards.count = " << c.t7_boards.size() << "\n";
    for (size_t i = 0; i < c.t7_boards.size(); ++i) {
        const auto& t = c.t7_boards[i];
        const std::string tp = p + "t7_boards[" + std::to_string(i) + "].";
        OUT << tp << "section = " << q(t.section) << "\n";
        OUT << tp << "ip = " << q(t.ip) << "\n";
        OUT << tp << "mac = " << q(t.mac) << "\n";
        OUT << tp << "serial = " << t.serial << "\n";
        OUT << tp << "board_id = " << t.board_id << "\n";
        OUT << tp << "slot() = " << static_cast<int>(t.slot()) << "\n";
        OUT << tp << "enabled = " << b(t.enabled) << "\n";
        OUT << tp << "scan_rate_hz = " << num(t.scan_rate_hz) << "\n";
        OUT << tp << "resolution_index = " << t.resolution_index << "\n";
        OUT << tp << "settling_us = " << num(t.settling_us) << "\n";
        OUT << tp << "scans_per_read = " << t.scans_per_read << "\n";
        OUT << tp << "effective_scans_per_read() = " << t.effective_scans_per_read() << "\n";
        OUT << tp << "cjc_offset_k = " << num(t.cjc_offset_k) << "\n";
        OUT << tp << "channels.count = " << t.channels.size() << "\n";
        for (size_t k = 0; k < t.channels.size(); ++k) {
            const auto& ch = t.channels[k];
            const std::string cp = tp + "channels[" + std::to_string(k) + "].";
            OUT << cp << "ain = " << ch.ain << "\n";
            OUT << cp << "kind = " << q(ch.kind) << "\n";
            OUT << cp << "role = " << q(ch.role) << "\n";
            OUT << cp << "range_v = " << num(ch.range_v) << "\n";
            OUT << cp << "differential = " << b(ch.differential) << "\n";
            OUT << cp << "negative_ch() = " << ch.negative_ch() << "\n";
            OUT << cp << "tc_type = " << q(ch.tc_type) << "\n";
            OUT << cp << "full_scale = " << num(ch.full_scale) << "\n";
            OUT << cp << "signal = " << q(ch.signal) << "\n";
            OUT << cp << "shunt_ohms = " << num(ch.shunt_ohms) << "\n";
            OUT << cp << "sensitivity_mv_per_v = " << num(ch.sensitivity_mv_per_v) << "\n";
            OUT << cp << "excitation_v = " << num(ch.excitation_v) << "\n";
            OUT << cp << "r0_ohms = " << num(ch.r0_ohms) << "\n";
            OUT << cp << "ljtr_ohms = " << num(ch.ljtr_ohms) << "\n";
            OUT << cp << "vref_v = " << num(ch.vref_v) << "\n";
        }
    }
    OUT << p << "t7_errors.count = " << c.t7_errors.size() << "\n";
    for (size_t i = 0; i < c.t7_errors.size(); ++i)
        OUT << p << "t7_errors[" << i << "] = " << q(c.t7_errors[i]) << "\n";

    OUT << p << "actuator_roles.count = " << c.actuator_roles.size() << "\n";
    for (const auto& [name, r] : c.actuator_roles)
        OUT << p << "actuator_roles[" << q(name) << "] = {kind=" << q(r.kind)
            << " is_no=" << b(r.is_no) << " ball_valve=" << b(r.ball_valve)
            << " channel=" << r.channel << " board_id=" << r.board_id
            << " controller_role=" << q(r.controller_role) << "}\n";

    OUT << p << "fire.state = " << q(c.fire.state) << "\n";
    OUT << p << "fire.expiry_target = " << q(c.fire.expiry_target) << "\n";
    OUT << p << "fire.duration_ms = " << c.fire.duration_ms << "\n";
    OUT << p << "fire.extended_ms = " << c.fire.extended_ms << "\n";
    OUT << p << "fire.gate_actuator = " << q(c.fire.gate_actuator) << "\n";
    OUT << p << "flow.return_target = " << q(c.flow.return_target) << "\n";
    OUT << p << "flow.duration_ms = " << c.flow.duration_ms << "\n";
    OUT << p << "flow.max_ms = " << c.flow.max_ms << "\n";
    OUT << p << "flow.gate_actuator = " << q(c.flow.gate_actuator) << "\n";
    const auto& cs = c.controller_service;
    OUT << p << "controller_service.port = " << cs.port << "\n";
    OUT << p << "controller_service.host = " << q(cs.host) << "\n";
    OUT << p << "controller_service.fire_duration_ms = " << cs.fire_duration_ms << "\n";
    OUT << p << "controller_service.fire_extended_ms = " << cs.fire_extended_ms << "\n";
    OUT << p << "controller_service.sequencer_owns_valves = " << b(cs.sequencer_owns_valves)
        << "\n";
    const auto& ct = c.controller;
    OUT << p << "controller.pwm_frequency_hz = " << num(ct.pwm_frequency_hz) << "\n";
    OUT << p << "controller.pwm_duration_ms = " << ct.pwm_duration_ms << "\n";
    OUT << p << "controller.controller_loop_hz = " << num(ct.controller_loop_hz) << "\n";
    OUT << p << "controller.P_copv_min_pa = " << num(ct.P_copv_min_pa) << "\n";
    OUT << p << "controller.fallback_fuel_duty_cycle = " << num(ct.fallback_fuel_duty_cycle)
        << "\n";
    OUT << p << "controller.fallback_ox_duty_cycle = " << num(ct.fallback_ox_duty_cycle) << "\n";
    OUT << p << "controller.lut_path = " << q(ct.lut_path) << "\n";
    OUT << p << "controller.thrust_curve_path = " << q(ct.thrust_curve_path) << "\n";
    OUT << p << "actuator_service.port = " << c.actuator_service.port << "\n";
    OUT << p << "actuator_service.bind_address = " << q(c.actuator_service.bind_address) << "\n";
    const auto& cal = c.calibration;
    OUT << p << "calibration.tc_adc_ref_voltage = " << num(cal.tc_adc_ref_voltage) << "\n";
    OUT << p << "calibration.rtd_adc_ref_voltage = " << num(cal.rtd_adc_ref_voltage) << "\n";
    OUT << p << "calibration.rtd_excitation_ua = " << num(cal.rtd_excitation_ua) << "\n";
    OUT << p << "calibration.rtd_r0_ohm = " << num(cal.rtd_r0_ohm) << "\n";
    OUT << p << "calibration.lc_sensitivity_mv_per_v = " << num(cal.lc_sensitivity_mv_per_v)
        << "\n";
    OUT << p << "calibration.lc_pga_gain = " << num(cal.lc_pga_gain) << "\n";
    OUT << p << "calibration.lc_full_scale_value = " << num(cal.lc_full_scale_value) << "\n";
    OUT << p << "calibration.tc_json_dir = " << q(cal.tc_json_dir) << "\n";
    OUT << p << "calibration.tc_csv_path = " << q(cal.tc_csv_path) << "\n";
    OUT << p << "calibration.rtd_json_dir = " << q(cal.rtd_json_dir) << "\n";
    OUT << p << "calibration.rtd_csv_path = " << q(cal.rtd_csv_path) << "\n";
    OUT << p << "calibration.lc_json_dir = " << q(cal.lc_json_dir) << "\n";
    OUT << p << "calibration.lc_csv_path = " << q(cal.lc_csv_path) << "\n";
    OUT << p << "state_machine.transitions_csv = " << q(c.state_machine.transitions_csv) << "\n";
    OUT << p << "state_machine.actuator_csv = " << q(c.state_machine.actuator_csv) << "\n";
    OUT << p << "state_machine.actuator_delay_csv = " << q(c.state_machine.actuator_delay_csv)
        << "\n";

    OUT << p << "states.count = " << c.states.size() << "\n";
    for (size_t i = 0; i < c.states.size(); ++i) {
        const auto& s = c.states[i];
        OUT << p << "states[" << i << "] = {id=" << s.id << " name=" << q(s.name)
            << " is_abort=" << b(s.is_abort) << " is_boot=" << b(s.is_boot)
            << " is_flow=" << b(s.is_flow) << " script_file=" << q(s.script_file)
            << " script_timeout_ms=" << s.script_timeout_ms
            << " script_return_target=" << q(s.script_return_target)
            << " script_timeout_target=" << q(s.script_timeout_target) << "}\n";
    }

    for (const auto& [sec, m] : c.sensor_roles)
        for (const auto& [k, v] : m)
            OUT << p << "sensor_roles[" << q(sec) << "][" << q(k) << "] = " << v << "\n";
    for (const auto& [k, v] : c.abort_pts)
        OUT << p << "abort_pts[" << q(k) << "] = " << num(v) << "\n";
    for (const auto& [sec, m] : c.calibration_models)
        for (const auto& [k, v] : m)
            OUT << p << "calibration_models[" << q(sec) << "][" << q(k) << "] = " << q(v) << "\n";
    auto dmap = [&](const char* nm,
                    const std::map<std::string, std::map<std::string, double>>& mm) {
        for (const auto& [sec, m] : mm)
            for (const auto& [k, v] : m)
                OUT << p << nm << "[" << q(sec) << "][" << q(k) << "] = " << num(v) << "\n";
        OUT << p << nm << ".sections = " << mm.size() << "\n";
    };
    OUT << p << "sensor_roles.sections = " << c.sensor_roles.size() << "\n";
    OUT << p << "calibration_models.sections = " << c.calibration_models.size() << "\n";
    dmap("calibration_full_scale", c.calibration_full_scale);
    dmap("calibration_sense_resistor", c.calibration_sense_resistor);
    dmap("calibration_sensitivity", c.calibration_sensitivity);
    dmap("calibration_pga_gain", c.calibration_pga_gain);

    // The accessor views, per board key, exactly as the services ask for them.
    for (const auto& x : c.boards) {
        const std::string key = fsw::config::board_key_of(x);
        const auto* sr = c.sensor_roles_for("sensor_roles_" + key);
        OUT << p << "sensor_roles_for(sensor_roles_" << key << ") = ";
        if (!sr) {
            OUT << "null\n";
        } else {
            OUT << "{";
            bool first = true;
            for (const auto& [k, v] : *sr) {
                OUT << (first ? "" : ", ") << q(k) << ": " << v;
                first = false;
            }
            OUT << "}\n";
        }
        OUT << p << "calibration_model_for(" << key
            << ") = " << (c.calibration_model_for("calibration_model_" + key) ? "set" : "null")
            << "; full_scale_for = "
            << (c.full_scale_for("calibration_full_scale_" + key) ? "set" : "null")
            << "; sense_resistor_for = "
            << (c.sense_resistor_for("calibration_sense_resistor_" + key) ? "set" : "null")
            << "; sensitivity_for = "
            << (c.sensitivity_for("calibration_sensitivity_" + key) ? "set" : "null")
            << "; pga_gain_for = " << (c.pga_gain_for("calibration_pga_" + key) ? "set" : "null")
            << "\n";
    }
}

void dump_tables(const std::string& nm, const std::vector<std::pair<uint8_t, uint8_t>>& v) {
    OUT << nm << " (" << v.size() << ") =";
    for (const auto& [hi, lo] : v)
        OUT << " " << hex2(hi) << ":" << hex2(lo);
    OUT << "\n";
}

void dump_derived(const fsw::config::Config& cfg) {
    using K = fsw::config::ActiveBoardKind;
    section("active_boards", [&] {
        const auto ab = fsw::config::active_boards(cfg);
        for (const auto& [k, list] : ab)
            for (const auto& bc : list) {
                OUT << kind_name(k) << " board_id=" << static_cast<int>(bc.board_id)
                    << " board_number=" << static_cast<int>(bc.board_number) << " channels=[";
                for (size_t i = 0; i < bc.channels.size(); ++i)
                    OUT << (i ? ", " : "") << static_cast<int>(bc.channels[i]);
                OUT << "]\n";
            }
        auto get = [&](K k) {
            auto it = ab.find(k);
            return it == ab.end() ? std::vector<fsw::elodin::BoardChannels>{} : it->second;
        };
        const auto pt = get(K::PT), act = get(K::ACTUATOR), tc = get(K::TC), rtd = get(K::RTD),
                   lc = get(K::LC), enc = get(K::ENCODER), bv = get(K::BALL_VALVE);
        dump_tables("elodin.raw_sensor_tables",
                    fsw::elodin::raw_sensor_tables(pt, act, tc, rtd, lc, enc));
        dump_tables("elodin.calibrated_sensor_tables",
                    fsw::elodin::calibrated_sensor_tables(pt, tc, rtd, lc, enc, act));
        dump_tables("elodin.ball_valve_raw_tables", fsw::elodin::ball_valve_raw_tables(bv));
        dump_tables("elodin.ball_valve_calibrated_tables",
                    fsw::elodin::ball_valve_calibrated_tables(bv));
        dump_tables("elodin.ball_valve_cmd_tables", fsw::elodin::ball_valve_cmd_tables(bv));
    });
    section("pt_boards", [&] {
        for (const auto& [slot, p] : fsw::config::pt_boards(cfg))
            OUT << "slot " << static_cast<int>(slot)
                << " = {board_id=" << static_cast<int>(p.board_id)
                << " board_number=" << static_cast<int>(p.board_number)
                << " interface=" << iface_name(p.interface)
                << " is_current_loop=" << b(fsw::config::is_current_loop(p))
                << " full_scale_psi=" << num(p.full_scale_psi)
                << " sense_resistor_ohms=" << num(p.sense_resistor_ohms)
                << " adc_ref_voltage=" << num(p.adc_ref_voltage) << "}\n";
    });
    section("pt_role_tables", [&] {
        for (const auto& r : fsw::config::pt_role_tables(cfg))
            OUT << q(r.role) << " board_key=" << q(r.board_key)
                << " board=" << (r.board ? q(r.board->section) : "null")
                << " t7=" << (r.t7 ? q(r.t7->section) : "null") << " channel=" << r.channel
                << " board_number=" << static_cast<int>(r.board_number)
                << " table=" << hex2(r.table().first) << ":" << hex2(r.table().second) << "\n";
        // find_pt_role for every role name, plus one that cannot exist.
        std::map<std::string, int> names;
        for (const auto& [sec, m] : cfg.sensor_roles)
            for (const auto& [k, v] : m)
                names[k] = v;
        names["__no_such_role__"] = 0;
        for (const auto& [n, unused] : names) {
            (void)unused;
            const auto r = fsw::config::find_pt_role(cfg, n);
            OUT << "find_pt_role(" << q(n) << ") = ";
            if (!r)
                OUT << "nullopt\n";
            else
                OUT << q(r->board_key) << " ch=" << r->channel << " table=" << hex2(r->table_hi)
                    << ":" << hex2(r->table_lo) << "\n";
        }
    });
    section("build_slug_tables", [&] {
        const auto t = fsw::script::build_slug_tables(cfg);
        OUT << "ok = " << b(t.ok()) << "\n";
        for (const auto& [s, n] : t.tables.actuators)
            OUT << "actuator " << s << " = " << q(n) << "\n";
        for (const auto& [s, n] : t.tables.sensors)
            OUT << "sensor " << s << " = " << q(n) << "\n";
        for (const auto& [s, n] : t.tables.states)
            OUT << "state " << s << " = " << q(n) << "\n";
        for (const auto& s : t.tables.allowed_transitions)
            OUT << "allowed_transition " << s << "\n";
        for (const auto& x : t.bad)
            OUT << "bad " << x.where << " " << q(x.canonical) << " -> " << q(x.slug) << "\n";
        for (const auto& x : t.collisions)
            OUT << "collision " << x.where << " " << x.slug << ": " << q(x.first) << " / "
                << q(x.second) << "\n";
    });
    section("resolvePWMTargets", [&] {
        const auto r = fsw::control::resolvePWMTargets(cfg);
        auto t = [&](const char* n, const fsw::control::ControllerService::PWMTarget& x) {
            OUT << n << " = {board_ip=" << q(x.board_ip)
                << " channel=" << static_cast<int>(x.channel)
                << " actuator_name=" << q(x.actuator_name) << " resolved=" << b(x.resolved())
                << "}\n";
        };
        t("fuel", r.fuel);
        t("ox", r.ox);
        OUT << "ok = " << b(r.ok()) << "\n";
        for (const auto& i : r.issues)
            OUT << "issue " << q(i) << "\n";
        for (const auto& [id, ip] : fsw::control::boardIpMap(cfg))
            OUT << "boardIpMap[" << id << "] = " << q(ip) << "\n";
    });
}

// ── Sequencer view: [[states]], the transitions table, the actuator tables, dynamic states ──────
void dump_sequencer(const std::string& config_text, const fsw::config::Config& cfg,
                    const std::string& transitions, const std::string& actuators,
                    const std::string& delays, const std::string& config_dir) {
    using sequencer::State;
    using sequencer::StateMachine;
    sequencer::StateMachine sm;
    bool sm_ok = false;
    section("StateMachine", [&] {
        StateMachine::loadStatesFromConfig(config_text);
        sm_ok = sm.load(transitions);
        OUT << "load(" << transitions << ") = " << b(sm_ok) << " isLoaded=" << b(sm.isLoaded())
            << "\n";
        OUT << "bootState = " << state_str(StateMachine::bootState()) << "\n";
        for (int id = 0; id < 256; ++id) {
            const State s = static_cast<State>(static_cast<uint8_t>(id));
            const auto allowed = sm.allowedFrom(s);
            const std::string nm = StateMachine::name(s);
            if (nm == "Unknown" && allowed.empty())
                continue;
            OUT << "state " << id << " " << q(nm) << " isAbort=" << b(StateMachine::isAbort(s))
                << " fromName(name)=" << static_cast<int>(StateMachine::fromName(nm))
                << " bitmask=0x";
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%08X", sm.allowedBitmask(s));
            OUT << buf << " allowedFrom=[";
            for (size_t i = 0; i < allowed.size(); ++i)
                OUT << (i ? ", " : "") << static_cast<int>(allowed[i]);
            OUT << "]\n";
        }
        // Name resolution of the legacy aliases and of case-folded names.
        for (const char* n : {"Abort", "Quick Fire", "GN2 Press", "GN2 Vent", "High Press", "fire",
                              "IDLE", "No Such State", ""})
            OUT << "fromName(" << q(n) << ") = " << static_cast<int>(StateMachine::fromName(n))
                << "\n";
    });

    sequencer::ActuatorCommander ac;
    section("ActuatorCommander", [&] {
        const bool ok = ac.load(config_text, actuators, delays);
        OUT << "load = " << b(ok) << " isLoaded=" << b(ac.isLoaded()) << "\n";
        OUT << "bind_addr_ = " << q(ac.bind_addr_) << " explicit=" << b(ac.bind_addr_explicit_)
            << " actuator_port_ = " << ac.actuator_port_ << "\n";
        for (const auto& [n, r] : ac.roles_)
            OUT << "role " << q(n) << " = {channel=" << r.channel << " board_id=" << r.board_id
                << " board_ip=" << q(r.board_ip) << " is_no=" << b(r.is_no)
                << " is_pwm=" << b(r.is_pwm) << " cmd_table_hi=" << hex2(r.cmd_table_hi) << "}\n";
        for (const auto& [st, m] : ac.state_actuators_) {
            OUT << "positions " << q(st) << " (" << m.size() << ")\n";
            for (const auto& [role, p] : m)
                OUT << "  " << q(role) << " = " << p << "\n";
        }
        for (const auto& [st, m] : ac.state_actuator_delays_)
            for (const auto& [role, d] : m)
                OUT << "delay " << q(st) << " " << q(role) << " = " << num(d) << "\n";
        // The lookups callers actually use: exact, case-folded, and unknown.
        for (const auto& s : cfg.states) {
            std::string lower = s.name;
            for (auto& ch : lower)
                ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
            OUT << "positionsForState(" << q(lower)
                << ").size = " << ac.positionsForState(lower).size() << "\n";
        }
        OUT << "positionsForState(\"No Such State\").size = "
            << ac.positionsForState("No Such State").size() << "\n";
    });

    section("load_dynamic_states", [&] {
        sequencer::ScriptLoadContext ctx;
        ctx.config_dir = config_dir;
        ctx.state_machine = &sm;
        // The fire state the way SequencerService::applyConfig resolves it.
        ctx.fire_state =
            cfg.fire.state.empty() ? State::UNKNOWN : StateMachine::fromName(cfg.fire.state);
        ctx.has_actuator_column = [&](const std::string& name) {
            return !ac.positionsForState(name).empty();
        };
        const auto r = sequencer::load_dynamic_states(cfg, config_text, ctx);
        for (const auto& [st, why] : r.refused)
            OUT << "refused " << state_str(st) << ": " << q(why) << "\n";
        for (const auto& [st, ds] : r.dynamic) {
            OUT << "dynamic " << state_str(st) << " name=" << q(ds.name)
                << " timeout_ms=" << ds.timeout_ms
                << " return_target=" << state_str(ds.return_target)
                << " timeout_target=" << state_str(ds.timeout_target) << "\n";
            for (const auto& pr : ds.pressure_roles)
                OUT << "  pressure_role " << q(pr) << "\n";
            for (size_t i = 0; i < ds.slug_names.size(); ++i)
                OUT << "  slug_name[" << i << "] = " << q(ds.slug_names[i]) << "\n";
            for (size_t i = 0; i < ds.slug_states.size(); ++i)
                OUT << "  slug_state[" << i << "] = " << state_str(ds.slug_states[i]) << "\n";
            OUT << "  canonical:\n" << fsw::script::print_canonical(ds.program) << "\n";
        }
    });

    // The hold-rule inputs SequencerService::applyConfig derives (applyConfig itself also resolves
    // the DAQ NIC and starts a pressure subscriber, so it is not run here): the fire and flow
    // states as it resolves them and every gate delay it would read.
    section("hold_rule_inputs", [&] {
        const State fs =
            cfg.fire.state.empty() ? State::UNKNOWN : StateMachine::fromName(cfg.fire.state);
        const State fe = cfg.fire.expiry_target.empty()
                             ? State::UNKNOWN
                             : StateMachine::fromName(cfg.fire.expiry_target);
        OUT << "fire_state = " << state_str(fs) << "\n";
        OUT << "fire_expiry = " << state_str(fe) << "\n";
        OUT << "fire isAllowed(state, expiry) = " << b(sm.isAllowed(fs, fe)) << "\n";
        if (!cfg.fire.gate_actuator.empty())
            OUT << "fire gate delays in/out = "
                << num(ac.delayForRole(StateMachine::name(fs), cfg.fire.gate_actuator)) << " / "
                << num(ac.delayForRole(StateMachine::name(fe), cfg.fire.gate_actuator)) << "\n";
        for (const auto& sd : cfg.states) {
            if (!sd.is_flow)
                continue;
            const State s = static_cast<State>(static_cast<uint8_t>(sd.id));
            const State ret = cfg.flow.return_target.empty()
                                  ? State::UNKNOWN
                                  : StateMachine::fromName(cfg.flow.return_target);
            OUT << "flow_state candidate " << state_str(s) << " return=" << state_str(ret)
                << " isAllowed=" << b(sm.isAllowed(s, ret)) << "\n";
            if (!cfg.flow.gate_actuator.empty())
                OUT << "flow gate delays in/out = "
                    << num(ac.delayForRole(StateMachine::name(s), cfg.flow.gate_actuator)) << " / "
                    << num(ac.delayForRole(StateMachine::name(ret), cfg.flow.gate_actuator))
                    << "\n";
        }
        for (const char* t : {"1500", " 250 ", "0", "1e3", "-5", "3600000", "3600001", "", "12x"}) {
            uint32_t v = 0;
            const bool ok = sequencer::parseHoldMs(t, v);
            OUT << "parseHoldMs(" << q(t) << ") = " << b(ok) << " " << (ok ? v : 0) << "\n";
        }
    });
}

// ── Script parser and validator (lib/src/script) ────────────────────────────────────────────────
const char* stmt_kind(fsw::script::StmtKind k) {
    using K = fsw::script::StmtKind;
    switch (k) {
        case K::Assign:
            return "Assign";
        case K::OpenValve:
            return "OpenValve";
        case K::CloseValve:
            return "CloseValve";
        case K::Delay:
            return "Delay";
        case K::TransitionTo:
            return "TransitionTo";
        case K::If:
            return "If";
        case K::While:
            return "While";
    }
    return "?";
}
const char* expr_kind(fsw::script::ExprKind k) {
    using K = fsw::script::ExprKind;
    switch (k) {
        case K::Number:
            return "Number";
        case K::Var:
            return "Var";
        case K::Pressure:
            return "Pressure";
        case K::Elapsed:
            return "Elapsed";
        case K::Unary:
            return "Unary";
        case K::Binary:
            return "Binary";
    }
    return "?";
}

void dump_program(const fsw::script::ScriptProgram& p) {
    OUT << "top = [" << p.top_begin << ", " << p.top_end << ") empty=" << b(p.empty())
        << " max_depth=" << p.max_depth << "\n";
    for (size_t i = 0; i < p.stmts.size(); ++i) {
        const auto& s = p.stmts[i];
        OUT << "stmt[" << i << "] " << stmt_kind(s.kind) << " @" << s.line << ":" << s.col
            << " var=" << s.var << " expr=" << s.expr << " slug=" << s.slug << " body=["
            << s.body_begin << ", " << s.body_end << ") else=[" << s.else_begin << ", "
            << s.else_end << ")\n";
    }
    for (size_t i = 0; i < p.exprs.size(); ++i) {
        const auto& e = p.exprs[i];
        OUT << "expr[" << i << "] " << expr_kind(e.kind) << " @" << e.line << ":" << e.col
            << " number=" << num(e.number) << " var=" << e.var << " slug=" << e.slug
            << " op=" << fsw::script::op_name(e.op) << " lhs=" << e.lhs << " rhs=" << e.rhs << "\n";
    }
    OUT << "block_items = [";
    for (size_t i = 0; i < p.block_items.size(); ++i)
        OUT << (i ? ", " : "") << p.block_items[i];
    OUT << "]\n";
    for (size_t i = 0; i < p.slugs.size(); ++i) {
        const auto& s = p.slugs[i];
        OUT << "slug[" << i << "] " << s.slug << " ns=" << fsw::script::ns_name(s.ns) << " @"
            << s.line << ":" << s.col << " len=" << s.len << "\n";
    }
    for (size_t i = 0; i < p.variables.size(); ++i)
        OUT << "variable[" << i << "] " << p.variables[i] << "\n";
    OUT << "canonical:\n" << fsw::script::print_canonical(p) << "\n";
}

void dump_diags(const char* what, const std::vector<fsw::script::Diagnostic>& ds) {
    OUT << what << ".count = " << ds.size() << "\n";
    for (const auto& d : ds)
        OUT << what << " " << d.line << ":" << d.col << " " << fsw::script::diag_name(d.code) << " "
            << q(d.message) << "\n";
}

void dump_script(const std::string& script_path, const std::string& state_name,
                 const fsw::config::Config* cfg, const sequencer::StateMachine* sm) {
    std::string src;
    if (!readFile(script_path, src)) {
        OUT << "cannot read " << script_path << "\n";
        return;
    }
    const auto pr = fsw::script::parse(src);
    OUT << "parse.ok = " << b(pr.ok()) << "\n";
    dump_diags("parse.diag", pr.diagnostics);
    dump_program(pr.program);
    if (cfg && sm) {
        auto build = fsw::script::build_slug_tables(*cfg);
        // The allowed set exactly as state_script_check builds it.
        const auto from = sequencer::StateMachine::fromName(state_name);
        for (const auto& [slug, canonical] : build.tables.states)
            if (sm->isAllowed(from, sequencer::StateMachine::fromName(canonical)))
                build.tables.allowed_transitions.insert(slug);
        dump_diags("validate.diag", fsw::script::validate(pr.program, build.tables));
    }
}

// ── Hardcoded "loaders" (SensorAssignment / DynamicConfigManager / BoardDiscovery) ──────────────
void dump_fixed() {
    section("SensorAssignmentManager::load_sensor_definitions", [&] {
        fsw::config::SensorAssignmentManager m;
        OUT << "return = " << b(m.load_sensor_definitions("ignored/path.toml")) << "\n";
        for (const auto& [id, s] : m.get_pressure_sensor_specs())
            OUT << q(id) << " = {sensor_id=" << q(s.sensor_id) << " name=" << q(s.name)
                << " description=" << q(s.description) << " max_pressure_psi=" << s.max_pressure_psi
                << " system_state="
                << (s.system_state == fsw::config::SystemState::GSE ? "GSE" : "FLIGHT")
                << " location=" << q(s.location) << " purpose=" << q(s.purpose) << "}\n";
    });
    section("DynamicConfigManager::load_base_config", [&] {
        fsw::config::DynamicConfigManager m;
        OUT << "return = " << b(m.load_base_config("ignored/path.toml")) << "\n";
        for (const auto& [sec, kv] : m.get_config()) {
            OUT << "[" << sec << "] (" << kv.size() << ")\n";
            for (const auto& [k, v] : kv)
                OUT << "  " << k << " = " << q(v) << "\n";
        }
    });
    section("BoardDiscovery::generate_config (no boards)", [&] {
        fsw::config::BoardDiscovery d;
        for (const auto& [sec, kv] : d.generate_config()) {
            OUT << "[" << sec << "] (" << kv.size() << ")\n";
            for (const auto& [k, v] : kv)
                OUT << "  " << k << " = " << q(v) << "\n";
        }
    });
}

}  // namespace

int main(int argc, char** argv) {
    std::string config, transitions, actuators, delays, config_dir, script, state;
    bool fixed = false;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string {
            return i + 1 < argc ? argv[++i] : std::string();
        };
        if (a == "--config")
            config = next();
        else if (a == "--transitions")
            transitions = next();
        else if (a == "--actuators")
            actuators = next();
        else if (a == "--delays")
            delays = next();
        else if (a == "--config-dir")
            config_dir = next();
        else if (a == "--script")
            script = next();
        else if (a == "--state")
            state = next();
        else if (a == "--fixed")
            fixed = true;
        else {
            std::cerr << "unknown argument " << a << "\n";
            return 2;
        }
    }

    std::ostringstream cap_out, cap_err;
    std::streambuf* saved_out = std::cout.rdbuf(cap_out.rdbuf());
    std::streambuf* saved_err = std::cerr.rdbuf(cap_err.rdbuf());

    if (fixed)
        dump_fixed();

    if (!config.empty()) {
        std::string text;
        const bool have_text = readFile(config, text);
        OUT << "input " << config << " readable=" << b(have_text) << " bytes=" << text.size()
            << "\n";
        fsw::config::Config cfg;
        bool cfg_ok = false;
        section("config::load", [&] {
            cfg = fsw::config::load(config);
            cfg_ok = true;
            dump_config("", cfg);
        });
        section("config::load_from_string", [&] {
            const auto c2 = fsw::config::load_from_string(text);
            // Only the differences from load(): the two must agree on a file that parses.
            std::ostringstream a, bb;
            std::swap(OUT, a);
            dump_config("", cfg);
            std::swap(OUT, a);
            std::swap(OUT, bb);
            dump_config("", c2);
            std::swap(OUT, bb);
            if (!cfg_ok)
                OUT << bb.str();
            else
                OUT << (a.str() == bb.str() ? "identical to config::load\n"
                                            : "DIFFERS from config::load:\n" + bb.str());
        });
        if (cfg_ok)
            dump_derived(cfg);
        if (!transitions.empty() || !actuators.empty())
            dump_sequencer(text, cfg, transitions, actuators, delays, config_dir);

        if (!script.empty()) {
            section("script " + script + " as state " + q(state), [&] {
                sequencer::StateMachine::loadStatesFromConfig(text);
                sequencer::StateMachine sm;
                sm.load(transitions);
                dump_script(script, state, &cfg, &sm);
            });
        }
    } else if (!script.empty()) {
        section("script " + script + " (parse only)", [&] {
            dump_script(script, state, nullptr, nullptr);
        });
    }

    std::cout.rdbuf(saved_out);
    std::cerr.rdbuf(saved_err);
    std::cout << OUT.str();
    std::cout << "\n=== captured stdout\n" << cap_out.str();
    std::cout << "\n=== captured stderr\n" << cap_err.str();
    std::cout << "\n=== exit " << (g_threw ? 1 : 0) << "\n";
    return 0;
}
