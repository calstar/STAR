#pragma once
#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>

#include "Elodin.hpp"
#include "TCPSocket.hpp"
#include "db.hpp"

using namespace vtable;
using namespace vtable::builder;

extern std::unique_ptr<Socket> LocalSock;
extern std::unique_ptr<Socket> GroundStationSock;

static std::unordered_map<std::string, std::string> structToEntityID;
static std::unordered_set<std::string> addedComponents;

/*
 * @brief a template fn to send messages to the DB using
 * Elodin defined primitives (Msg, .encode_vec())
 */
template <typename T>
void send(T msg) {
    auto buf = Msg(msg).encode_vec();
    // Send to local database - use write_all_elodin for consistent buffering
    LocalSock->write_all_elodin(buf.data(), buf.size());
    // Immediately flush to prevent fragmentation during config setup
    LocalSock->flush_elodin();
}

void cppGenerateDBConfig() {
    std::cout << "Generating database configuration..." << std::endl;

    // ══════════════════════════════════════════════════════════════════════════════
    // IMUMessage
    // Fields: time_imu, accelerometer (x, y, z), gyroscope (x, y, z), time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto imuTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x01, "time_imu"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, pair(0x01, "accelerometer_x"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, pair(0x01, "accelerometer_y"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, pair(0x01, "accelerometer_z"))),
        raw_field(32, 8, schema(PrimType::F64(), {}, pair(0x01, "gyroscope_x"))),
        raw_field(40, 8, schema(PrimType::F64(), {}, pair(0x01, "gyroscope_y"))),
        raw_field(48, 8, schema(PrimType::F64(), {}, pair(0x01, "gyroscope_z"))),
        raw_field(56, 8, schema(PrimType::U64(), {}, pair(0x01, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x01, 0x00},
        .vtable = imuTable,
    });

    send(set_component_name("time_imu"));
    send(set_component_name("accelerometer_x"));
    send(set_component_name("accelerometer_y"));
    send(set_component_name("accelerometer_z"));
    send(set_component_name("gyroscope_x"));
    send(set_component_name("gyroscope_y"));
    send(set_component_name("gyroscope_z"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x01, "IMU"));

    // ══════════════════════════════════════════════════════════════════════════════
    // PTMessage (Pressure/Temperature)
    // Fields: time_pt, pressure, temperature, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto ptTable = builder::vtable({
        raw_field(0, 1, schema(PrimType::U8(), {}, pair(0x20, "ch"))),
        raw_field(1, 1, schema(PrimType::U8(), {}, pair(0x20, "ok"))),
        raw_field(4, 4,
                  schema(PrimType::U32(), {}, pair(0x20, "raw"))),  // Aligned to 4-byte boundary
        raw_field(8, 4, schema(PrimType::U32(), {}, pair(0x20, "sample_time"))),
        raw_field(12, 4, schema(PrimType::U32(), {}, pair(0x20, "read_time_dur"))),
        raw_field(16, 4, schema(PrimType::U32(), {}, pair(0x20, "conv_time_dur"))),
    });

    send(VTableMsg{
        .id = {0x20, 0x00},
        .vtable = ptTable,
    });

    send(set_component_name("ch"));
    send(set_component_name("ok"));
    send(set_component_name("raw"));
    send(set_component_name("sample_time"));
    send(set_component_name("read_time_dur"));
    send(set_component_name("conv_time_dur"));
    send(set_entity_name(0x20, "PT_Rec18"));

    // ══════════════════════════════════════════════════════════════════════════════
    // TCMessage (Thermocouple)
    // Fields: time_tc, temperature, voltage, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto tcTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x03, "time_tc"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, pair(0x03, "temperature"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, pair(0x03, "voltage"))),
        raw_field(24, 8, schema(PrimType::U64(), {}, pair(0x03, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x03, 0x00},
        .vtable = tcTable,
    });

    send(set_component_name("time_tc"));
    send(set_component_name("temperature"));
    send(set_component_name("voltage"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x03, "TC"));

    // ══════════════════════════════════════════════════════════════════════════════
    // RTDMessage (Resistance Temperature Detector)
    // Fields: time_rtd, temperature, resistance, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto rtdTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x04, "time_rtd"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, pair(0x04, "temperature"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, pair(0x04, "resistance"))),
        raw_field(24, 8, schema(PrimType::U64(), {}, pair(0x04, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x04, 0x00},
        .vtable = rtdTable,
    });

    send(set_component_name("time_rtd"));
    send(set_component_name("temperature"));
    send(set_component_name("resistance"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x04, "RTD"));

    // ══════════════════════════════════════════════════════════════════════════════
    // BarometerMessage
    // Fields: time_bar, pressure, altitude, temperature, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto barTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x05, "time_bar"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, pair(0x05, "pressure"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, pair(0x05, "altitude"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, pair(0x05, "temperature"))),
        raw_field(32, 8, schema(PrimType::U64(), {}, pair(0x05, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x05, 0x00},
        .vtable = barTable,
    });

    send(set_component_name("time_bar"));
    send(set_component_name("pressure"));
    send(set_component_name("altitude"));
    send(set_component_name("temperature"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x05, "Barometer"));

    // ══════════════════════════════════════════════════════════════════════════════
    // GPSPositionMessage
    // Fields: time_gps_pos, latitude, longitude, altitude, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto gpsPosTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x06, "time_gps_pos"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, pair(0x06, "latitude"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, pair(0x06, "longitude"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, pair(0x06, "altitude"))),
        raw_field(32, 8, schema(PrimType::U64(), {}, pair(0x06, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x06, 0x00},
        .vtable = gpsPosTable,
    });

    send(set_component_name("time_gps_pos"));
    send(set_component_name("latitude"));
    send(set_component_name("longitude"));
    send(set_component_name("altitude"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x06, "GPS_Position"));

    // ══════════════════════════════════════════════════════════════════════════════
    // GPSVelocityMessage
    // Fields: time_gps_vel, velocity_x, velocity_y, velocity_z, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto gpsVelTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x07, "time_gps_vel"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, pair(0x07, "velocity_x"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, pair(0x07, "velocity_y"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, pair(0x07, "velocity_z"))),
        raw_field(32, 8, schema(PrimType::U64(), {}, pair(0x07, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x07, 0x00},
        .vtable = gpsVelTable,
    });

    send(set_component_name("time_gps_vel"));
    send(set_component_name("velocity_x"));
    send(set_component_name("velocity_y"));
    send(set_component_name("velocity_z"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x07, "GPS_Velocity"));

    // ══════════════════════════════════════════════════════════════════════════════
    // Flight Software System Messages
    // ══════════════════════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════════════════════
    // EngineControlMessage
    // Fields: timestamp, engine_phase, thrust_demand, thrust_actual, chamber_pressure,
    //         mixture_ratio_demand, mixture_ratio_actual, fuel_valve_position,
    //         ox_valve_position, fuel_flow_rate, ox_flow_rate, specific_impulse,
    //         efficiency, ignition_confirmed, all_systems_go, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto engineControlTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x10, "timestamp"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, pair(0x10, "engine_phase"))),
        raw_field(9, 8, schema(PrimType::F64(), {}, pair(0x10, "thrust_demand"))),
        raw_field(17, 8, schema(PrimType::F64(), {}, pair(0x10, "thrust_actual"))),
        raw_field(25, 8, schema(PrimType::F64(), {}, pair(0x10, "chamber_pressure"))),
        raw_field(33, 8, schema(PrimType::F64(), {}, pair(0x10, "mixture_ratio_demand"))),
        raw_field(41, 8, schema(PrimType::F64(), {}, pair(0x10, "mixture_ratio_actual"))),
        raw_field(49, 8, schema(PrimType::F64(), {}, pair(0x10, "fuel_valve_position"))),
        raw_field(57, 8, schema(PrimType::F64(), {}, pair(0x10, "ox_valve_position"))),
        raw_field(65, 8, schema(PrimType::F64(), {}, pair(0x10, "fuel_flow_rate"))),
        raw_field(73, 8, schema(PrimType::F64(), {}, pair(0x10, "ox_flow_rate"))),
        raw_field(81, 8, schema(PrimType::F64(), {}, pair(0x10, "specific_impulse"))),
        raw_field(89, 8, schema(PrimType::F64(), {}, pair(0x10, "efficiency"))),
        raw_field(97, 1, schema(PrimType::Bool(), {}, pair(0x10, "ignition_confirmed"))),
        raw_field(98, 1, schema(PrimType::Bool(), {}, pair(0x10, "all_systems_go"))),
        raw_field(99, 8, schema(PrimType::U64(), {}, pair(0x10, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x10, 0x00},
        .vtable = engineControlTable,
    });

    send(set_component_name("timestamp"));
    send(set_component_name("engine_phase"));
    send(set_component_name("thrust_demand"));
    send(set_component_name("thrust_actual"));
    send(set_component_name("chamber_pressure"));
    send(set_component_name("mixture_ratio_demand"));
    send(set_component_name("mixture_ratio_actual"));
    send(set_component_name("fuel_valve_position"));
    send(set_component_name("ox_valve_position"));
    send(set_component_name("fuel_flow_rate"));
    send(set_component_name("ox_flow_rate"));
    send(set_component_name("specific_impulse"));
    send(set_component_name("efficiency"));
    send(set_component_name("ignition_confirmed"));
    send(set_component_name("all_systems_go"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x10, "EngineControl"));

    // ══════════════════════════════════════════════════════════════════════════════
    // ValveControlMessage
    // Fields: timestamp, valve_id, valve_type, commanded_position, actual_position,
    //         position_error, velocity, current, temperature, rate_limit,
    //         emergency_close, fault_detected, valve_state, command_confidence, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto valveControlTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x11, "timestamp"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, pair(0x11, "valve_id"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, pair(0x11, "valve_type"))),
        raw_field(10, 8, schema(PrimType::F64(), {}, pair(0x11, "commanded_position"))),
        raw_field(18, 8, schema(PrimType::F64(), {}, pair(0x11, "actual_position"))),
        raw_field(26, 8, schema(PrimType::F64(), {}, pair(0x11, "position_error"))),
        raw_field(34, 8, schema(PrimType::F64(), {}, pair(0x11, "velocity"))),
        raw_field(42, 8, schema(PrimType::F64(), {}, pair(0x11, "current"))),
        raw_field(50, 8, schema(PrimType::F64(), {}, pair(0x11, "temperature"))),
        raw_field(58, 8, schema(PrimType::F64(), {}, pair(0x11, "rate_limit"))),
        raw_field(66, 1, schema(PrimType::Bool(), {}, pair(0x11, "emergency_close"))),
        raw_field(67, 1, schema(PrimType::Bool(), {}, pair(0x11, "fault_detected"))),
        raw_field(68, 1, schema(PrimType::U8(), {}, pair(0x11, "valve_state"))),
        raw_field(69, 8, schema(PrimType::F64(), {}, pair(0x11, "command_confidence"))),
        raw_field(77, 8, schema(PrimType::U64(), {}, pair(0x11, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x11, 0x00},
        .vtable = valveControlTable,
    });

    send(set_component_name("timestamp"));
    send(set_component_name("valve_id"));
    send(set_component_name("valve_type"));
    send(set_component_name("commanded_position"));
    send(set_component_name("actual_position"));
    send(set_component_name("position_error"));
    send(set_component_name("velocity"));
    send(set_component_name("current"));
    send(set_component_name("temperature"));
    send(set_component_name("rate_limit"));
    send(set_component_name("emergency_close"));
    send(set_component_name("fault_detected"));
    send(set_component_name("valve_state"));
    send(set_component_name("command_confidence"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x11, "ValveControl"));

    // ══════════════════════════════════════════════════════════════════════════════
    // Enhanced PTMessage (Pressure Transducer with Calibration Data)
    // Fields: timestamp, sensor_id, raw_voltage, pressure, pressure_uncertainty,
    //         temperature, calibration_quality, calibration_valid, drift_detected,
    //         sensor_health, environmental_factor, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto enhancedPTTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x12, "timestamp"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, pair(0x12, "sensor_id"))),
        raw_field(9, 8, schema(PrimType::F64(), {}, pair(0x12, "raw_voltage"))),
        raw_field(17, 8, schema(PrimType::F64(), {}, pair(0x12, "pressure"))),
        raw_field(25, 8, schema(PrimType::F64(), {}, pair(0x12, "pressure_uncertainty"))),
        raw_field(33, 8, schema(PrimType::F64(), {}, pair(0x12, "temperature"))),
        raw_field(41, 8, schema(PrimType::F64(), {}, pair(0x12, "calibration_quality"))),
        raw_field(49, 1, schema(PrimType::Bool(), {}, pair(0x12, "calibration_valid"))),
        raw_field(50, 8, schema(PrimType::F64(), {}, pair(0x12, "drift_detected"))),
        raw_field(58, 1, schema(PrimType::U8(), {}, pair(0x12, "sensor_health"))),
        raw_field(59, 8, schema(PrimType::F64(), {}, pair(0x12, "environmental_factor"))),
        raw_field(67, 8, schema(PrimType::U64(), {}, pair(0x12, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x12, 0x00},
        .vtable = enhancedPTTable,
    });

    send(set_component_name("timestamp"));
    send(set_component_name("sensor_id"));
    send(set_component_name("raw_voltage"));
    send(set_component_name("pressure"));
    send(set_component_name("pressure_uncertainty"));
    send(set_component_name("temperature"));
    send(set_component_name("calibration_quality"));
    send(set_component_name("calibration_valid"));
    send(set_component_name("drift_detected"));
    send(set_component_name("sensor_health"));
    send(set_component_name("environmental_factor"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x12, "EnhancedPT"));

    // ══════════════════════════════════════════════════════════════════════════════
    // NavigationMessage (EKF Navigation State)
    // Fields: timestamp, position_x, position_y, position_z, velocity_x, velocity_y, velocity_z,
    //         attitude_qw, attitude_qx, attitude_qy, attitude_qz, angular_velocity_x,
    //         angular_velocity_y, angular_velocity_z, acceleration_x, acceleration_y,
    //         acceleration_z, engine_thrust, engine_mass, navigation_quality,
    //         navigation_mode, navigation_valid, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto navigationTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x13, "timestamp"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, pair(0x13, "position_x"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, pair(0x13, "position_y"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, pair(0x13, "position_z"))),
        raw_field(32, 8, schema(PrimType::F64(), {}, pair(0x13, "velocity_x"))),
        raw_field(40, 8, schema(PrimType::F64(), {}, pair(0x13, "velocity_y"))),
        raw_field(48, 8, schema(PrimType::F64(), {}, pair(0x13, "velocity_z"))),
        raw_field(56, 8, schema(PrimType::F64(), {}, pair(0x13, "attitude_qw"))),
        raw_field(64, 8, schema(PrimType::F64(), {}, pair(0x13, "attitude_qx"))),
        raw_field(72, 8, schema(PrimType::F64(), {}, pair(0x13, "attitude_qy"))),
        raw_field(80, 8, schema(PrimType::F64(), {}, pair(0x13, "attitude_qz"))),
        raw_field(88, 8, schema(PrimType::F64(), {}, pair(0x13, "angular_velocity_x"))),
        raw_field(96, 8, schema(PrimType::F64(), {}, pair(0x13, "angular_velocity_y"))),
        raw_field(104, 8, schema(PrimType::F64(), {}, pair(0x13, "angular_velocity_z"))),
        raw_field(112, 8, schema(PrimType::F64(), {}, pair(0x13, "acceleration_x"))),
        raw_field(120, 8, schema(PrimType::F64(), {}, pair(0x13, "acceleration_y"))),
        raw_field(128, 8, schema(PrimType::F64(), {}, pair(0x13, "acceleration_z"))),
        raw_field(136, 8, schema(PrimType::F64(), {}, pair(0x13, "engine_thrust"))),
        raw_field(144, 8, schema(PrimType::F64(), {}, pair(0x13, "engine_mass"))),
        raw_field(152, 8, schema(PrimType::F64(), {}, pair(0x13, "navigation_quality"))),
        raw_field(160, 1, schema(PrimType::U8(), {}, pair(0x13, "navigation_mode"))),
        raw_field(161, 1, schema(PrimType::Bool(), {}, pair(0x13, "navigation_valid"))),
        raw_field(162, 8, schema(PrimType::U64(), {}, pair(0x13, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x13, 0x00},
        .vtable = navigationTable,
    });

    send(set_component_name("timestamp"));
    send(set_component_name("position_x"));
    send(set_component_name("position_y"));
    send(set_component_name("position_z"));
    send(set_component_name("velocity_x"));
    send(set_component_name("velocity_y"));
    send(set_component_name("velocity_z"));
    send(set_component_name("attitude_qw"));
    send(set_component_name("attitude_qx"));
    send(set_component_name("attitude_qy"));
    send(set_component_name("attitude_qz"));
    send(set_component_name("angular_velocity_x"));
    send(set_component_name("angular_velocity_y"));
    send(set_component_name("angular_velocity_z"));
    send(set_component_name("acceleration_x"));
    send(set_component_name("acceleration_y"));
    send(set_component_name("acceleration_z"));
    send(set_component_name("engine_thrust"));
    send(set_component_name("engine_mass"));
    send(set_component_name("navigation_quality"));
    send(set_component_name("navigation_mode"));
    send(set_component_name("navigation_valid"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x13, "Navigation"));

    // ══════════════════════════════════════════════════════════════════════════════
    // CalibrationMessage
    // Fields: timestamp, sensor_id, sensor_type, calibration_status, calibration_quality,
    //         rmse, nrmse, coverage_95, extrapolation_confidence, num_calibration_points,
    //         drift_detected, calibration_valid, last_calibration_time, sensor_health,
    //         time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto calibrationTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x14, "timestamp"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, pair(0x14, "sensor_id"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, pair(0x14, "sensor_type"))),
        raw_field(10, 1, schema(PrimType::U8(), {}, pair(0x14, "calibration_status"))),
        raw_field(11, 8, schema(PrimType::F64(), {}, pair(0x14, "calibration_quality"))),
        raw_field(19, 8, schema(PrimType::F64(), {}, pair(0x14, "rmse"))),
        raw_field(27, 8, schema(PrimType::F64(), {}, pair(0x14, "nrmse"))),
        raw_field(35, 8, schema(PrimType::F64(), {}, pair(0x14, "coverage_95"))),
        raw_field(43, 8, schema(PrimType::F64(), {}, pair(0x14, "extrapolation_confidence"))),
        raw_field(51, 4, schema(PrimType::U32(), {}, pair(0x14, "num_calibration_points"))),
        raw_field(55, 8, schema(PrimType::F64(), {}, pair(0x14, "drift_detected"))),
        raw_field(63, 1, schema(PrimType::Bool(), {}, pair(0x14, "calibration_valid"))),
        raw_field(64, 8, schema(PrimType::F64(), {}, pair(0x14, "last_calibration_time"))),
        raw_field(72, 1, schema(PrimType::U8(), {}, pair(0x14, "sensor_health"))),
        raw_field(73, 8, schema(PrimType::U64(), {}, pair(0x14, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x14, 0x00},
        .vtable = calibrationTable,
    });

    send(set_component_name("timestamp"));
    send(set_component_name("sensor_id"));
    send(set_component_name("sensor_type"));
    send(set_component_name("calibration_status"));
    send(set_component_name("calibration_quality"));
    send(set_component_name("rmse"));
    send(set_component_name("nrmse"));
    send(set_component_name("coverage_95"));
    send(set_component_name("extrapolation_confidence"));
    send(set_component_name("num_calibration_points"));
    send(set_component_name("drift_detected"));
    send(set_component_name("calibration_valid"));
    send(set_component_name("last_calibration_time"));
    send(set_component_name("sensor_health"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x14, "Calibration"));

    // ══════════════════════════════════════════════════════════════════════════════
    // SystemHealthMessage
    // Fields: timestamp, system_status, system_health, active_faults, total_faults,
    //         cpu_usage, memory_usage, network_quality, control_performance,
    //         navigation_accuracy, calibration_quality, emergency_status,
    //         safety_systems_ok, communication_ok, time_monotonic
    // ══════════════════════════════════════════════════════════════════════════════

    auto systemHealthTable = builder::vtable({
        raw_field(0, 8, schema(PrimType::F64(), {}, pair(0x15, "timestamp"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, pair(0x15, "system_status"))),
        raw_field(9, 8, schema(PrimType::F64(), {}, pair(0x15, "system_health"))),
        raw_field(17, 4, schema(PrimType::U32(), {}, pair(0x15, "active_faults"))),
        raw_field(21, 4, schema(PrimType::U32(), {}, pair(0x15, "total_faults"))),
        raw_field(25, 8, schema(PrimType::F64(), {}, pair(0x15, "cpu_usage"))),
        raw_field(33, 8, schema(PrimType::F64(), {}, pair(0x15, "memory_usage"))),
        raw_field(41, 8, schema(PrimType::F64(), {}, pair(0x15, "network_quality"))),
        raw_field(49, 8, schema(PrimType::F64(), {}, pair(0x15, "control_performance"))),
        raw_field(57, 8, schema(PrimType::F64(), {}, pair(0x15, "navigation_accuracy"))),
        raw_field(65, 8, schema(PrimType::F64(), {}, pair(0x15, "calibration_quality"))),
        raw_field(73, 1, schema(PrimType::U8(), {}, pair(0x15, "emergency_status"))),
        raw_field(74, 1, schema(PrimType::Bool(), {}, pair(0x15, "safety_systems_ok"))),
        raw_field(75, 1, schema(PrimType::Bool(), {}, pair(0x15, "communication_ok"))),
        raw_field(76, 8, schema(PrimType::U64(), {}, pair(0x15, "time_monotonic"))),
    });

    send(VTableMsg{
        .id = {0x15, 0x00},
        .vtable = systemHealthTable,
    });

    send(set_component_name("timestamp"));
    send(set_component_name("system_status"));
    send(set_component_name("system_health"));
    send(set_component_name("active_faults"));
    send(set_component_name("total_faults"));
    send(set_component_name("cpu_usage"));
    send(set_component_name("memory_usage"));
    send(set_component_name("network_quality"));
    send(set_component_name("control_performance"));
    send(set_component_name("navigation_accuracy"));
    send(set_component_name("calibration_quality"));
    send(set_component_name("emergency_status"));
    send(set_component_name("safety_systems_ok"));
    send(set_component_name("communication_ok"));
    send(set_component_name("time_monotonic"));
    send(set_entity_name(0x15, "SystemHealth"));

    std::cout << "Database configuration complete!" << std::endl;
}
