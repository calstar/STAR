#pragma once

// Centralized, typed view of config.toml, parsed once via toml++ (see Config.cpp).
//
// Every C++ binary used to re-open and hand-scan config.toml with its own copy-pasted parser; this
// module is the single source of truth. Each field carries the historical call-site default so a
// missing key reproduces the old behavior exactly. Only sections that C++ actually consumes are
// modeled — [sim_pt_targets], [gui.*], [pressure_limits.*], [adc], [discovery] are TS/Python-only.
//
// NOTE: distinct from the unrelated legacy global `class Config` in lib/include/Config.h.

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "config/LoadActiveBoards.hpp"  // ActiveBoardKind, PtInterface, PtBoardConfig, BoardChannels
#include "time/BoardClockSync.hpp"      // fsw::time::TimeSyncConfig

namespace fsw {
namespace config {

struct NetworkConfig {
    std::string bind_ip = "0.0.0.0";    // [network].bind_ip
    uint16_t sensor_port = 5006;        // [network].sensor_port
    uint16_t actuator_cmd_port = 5005;  // [network].actuator_cmd_port
};

struct DatabaseConfig {
    std::string host = "127.0.0.1";  // [database].host
    uint16_t port = 2240;            // [database].port
};

struct ServerHeartbeatConfig {    // [server_heartbeat]
    uint32_t interval_ms = 1000;  // daq_bridge default (file usually supplies)
    uint16_t broadcast_port = 5005;
    std::string broadcast_ip = "255.255.255.255";
    bool send_from_daq_bridge = true;  // synthesized: false when [heartbeat_service].enabled
};

struct HeartbeatServiceConfig {  // [heartbeat_service]
    bool enabled = false;
    uint32_t interval_ms = 1000;  // clamped >=100 at use site
    std::string broadcast_ip = "192.168.2.255";
    uint16_t broadcast_port = 5005;
    std::string elodin_host = "127.0.0.1";
    uint16_t elodin_port = 2240;
};

struct LogsConfig {
    uint16_t backend_udp_port = 8092;  // [logs].backend_udp_port
};

struct ControllerServiceConfig {  // [controller_service]
    uint16_t port = 9999;
    std::string host = "127.0.0.1";
    uint32_t fire_duration_ms = 6000;
    uint32_t fire_extended_ms = 10000;
};

struct ControllerConfig {  // [controller]
    double pwm_frequency_hz = 10.0;
    uint32_t pwm_duration_ms = 10000;
    double controller_loop_hz = 10.0;
    double P_copv_min_pa = 0.0;
    double fallback_fuel_duty_cycle = 0.0;
    double fallback_ox_duty_cycle = 0.0;
    std::string lut_path;
    std::string thrust_curve_path;
};

struct ActuatorServiceConfig {  // [actuator_service]
    uint16_t port = 9998;
    std::string bind_address = "0.0.0.0";
};

struct CalibrationConfig {  // [calibration.tc/.rtd/.lc]
    double tc_adc_ref_voltage = 2.5;
    double rtd_adc_ref_voltage = 2.5;
    double rtd_excitation_ua = 1000.0;
    double rtd_r0_ohm = 1000.0;
    double lc_sensitivity_mv_per_v = 2.0;
    double lc_pga_gain = 32.0;
    double lc_full_scale_value = 300.0;
    // Per-type coefficient sources from the TOML (previously ignored; the service used to hardcode
    // these). json_dir = newest-*.json dir of per-channel coeffs; csv_path = first of
    // [calibration.*] csv_paths. Empty string keeps the historical hardcoded default at the call
    // site.
    std::string tc_json_dir, tc_csv_path;
    std::string rtd_json_dir, rtd_csv_path;
    std::string lc_json_dir, lc_csv_path;
};

struct FireConfig {     // [fire]
    std::string state;  // "" when absent; consumers guard on empty and keep their own default
    std::string expiry_target;
    uint32_t duration_ms = 6000;
    uint32_t extended_ms = 10000;
};

struct StateMachinePaths {  // [state_machine]
    std::string transitions_csv = "config/state_transitions.csv";
    std::string actuator_csv = "config/state_machine_actuators.csv";
    std::string actuator_delay_csv = "config/state_machine_actuator_delays.csv";
};

struct StateDef {  // one per [[states]]
    int id = -1;
    std::string name;
    bool is_abort = false;
    bool is_boot = false;
};

struct ActuatorRole {         // [actuator_roles] value ["NC"|"NO"|"PWM", channel, board_id]
    std::string kind = "NC";  // raw first element (NC/NO/PWM)
    bool is_no = false;       // kind == "NO"
    int channel = 0;
    int board_id = 0;
};

// One [boards.*] section. Superset of every reader's keys so a single parse serves all binaries.
struct BoardConfig {
    std::string section;  // e.g. "boards.pt_board" (order/diagnostics)
    std::string type;     // "PT"/"TC"/"RTD"/"LC"/"ACTUATOR"/"ENCODER" (raw, unquoted)
    std::string ip;
    int board_id = -1;  // board_id, with legacy "id" fallback
    bool enabled = true;
    int num_sensors = 10;
    int num_actuators = 0;
    uint16_t send_port = 5005;
    uint16_t listen_port = 5005;
    int enable_serial_printing = 0;  // tolerate bool-or-int; clamped 0..3
    int voltage_reference = 0;
    bool necessary_for_abort = false;
    bool designated_survivor = false;
    std::vector<int> active_connectors;  // empty -> caller expands to 1..num_sensors

    // PT-specific (feeds pt_boards()):
    std::string pt_type;  // "" if absent
    double adc_ref_voltage = 2.5;
    bool has_hp_pt_keys = false;  // hp_pt_connectors or hp_pt_full_scale_psi present (legacy infer)
    double hp_pt_full_scale_psi = 5000.0;
    double hp_pt_sense_resistor_ohms = 120.0;

    /** Elodin slot: board_id % 10, with 0 mapping to 10. */
    uint8_t slot() const {
        int m = board_id % 10;
        return static_cast<uint8_t>(m == 0 ? 10 : m);
    }
};

/** The whole parsed config.toml, restricted to what C++ consumes. */
struct Config {
    NetworkConfig network;
    DatabaseConfig database;
    ServerHeartbeatConfig server_heartbeat;
    HeartbeatServiceConfig heartbeat_service;
    LogsConfig logs;
    fsw::time::TimeSyncConfig time_sync;
    uint32_t config_broadcast_interval_ms = 1000;  // [config_broadcast_service].interval_ms
    std::vector<BoardConfig> boards;               // parse order preserved
    std::map<std::string, ActuatorRole> actuator_roles;
    FireConfig fire;
    ControllerServiceConfig controller_service;
    ControllerConfig controller;
    ActuatorServiceConfig actuator_service;
    CalibrationConfig calibration;
    StateMachinePaths state_machine;
    std::vector<StateDef> states;
    // section name -> {role name -> channel}, e.g. "sensor_roles_pt_board" -> {"Fuel Upstream": 1}.
    std::map<std::string, std::map<std::string, int>> sensor_roles;
    std::map<std::string, double> abort_pts;  // [abort_pts]
    // section name -> {role name -> "cubic"|"robust"|"physics"|"blend"}, e.g.
    // "calibration_model_pt_board" -> {"Ox Upstream": "robust"}. Per-sensor PT streaming model.
    std::map<std::string, std::map<std::string, std::string>> calibration_models;
    // Per-sensor physics-mode parameters, role-keyed, parallel to calibration_models:
    // [calibration_full_scale_<board>] role->PSI and [calibration_sense_resistor_<board>] role->Ω.
    std::map<std::string, std::map<std::string, double>> calibration_full_scale;
    std::map<std::string, std::map<std::string, double>> calibration_sense_resistor;

    /** [sensor_roles_<board>] with a legacy [sensor_roles] fallback. */
    const std::map<std::string, int>* sensor_roles_for(const std::string& board_key) const;

    /** [calibration_model_<board>] role->model map, or nullptr when absent/empty. */
    const std::map<std::string, std::string>* calibration_model_for(
        const std::string& section_key) const;

    /** [calibration_full_scale_<board>] role->PSI map, or nullptr when absent/empty. */
    const std::map<std::string, double>* full_scale_for(const std::string& section_key) const;

    /** [calibration_sense_resistor_<board>] role->Ω map, or nullptr when absent/empty. */
    const std::map<std::string, double>* sense_resistor_for(const std::string& section_key) const;
};

/** Parse config.toml at `path`. On any error, logs and returns a default-constructed Config. */
Config load(const std::string& path);

/** Parse config from an in-memory TOML string (SequencerService / ActuatorCommander hold it so). */
Config load_from_string(const std::string& text);

/**
 * Derive the active-board table (enabled boards -> Elodin BoardChannels), with the same
 * slot-collision validation the old load_active_boards() logged. Free-function form used by
 * daq_bridge/calibration/sequencer.
 */
std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> active_boards(const Config& cfg);

/** Derive PT board 4-20 mA parameters keyed by Elodin slot (mirrors old load_pt_boards()). */
std::map<uint8_t, PtBoardConfig> pt_boards(const Config& cfg);

}  // namespace config
}  // namespace fsw
