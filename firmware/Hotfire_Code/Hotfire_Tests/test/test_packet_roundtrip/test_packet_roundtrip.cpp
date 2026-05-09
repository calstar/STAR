/**
 * Packet round-trip unit tests — DAQv2-Comms serialization / parsing
 *
 * For each packet type: create → parse → verify all fields match.
 * Also tests buffer-too-small and edge cases.
 */
#include <unity.h>
#include <cstring>
#include <vector>

// DAQv2-Comms (uses our Arduino.h stub via -I stubs)
#include "DiabloEnums.h"
#include "DiabloPackets.h"
#include "DiabloPacketUtils.h"

// Pull in the implementation
#include "DiabloPacketUtils.cpp"

// ---------------------------------------------------------------------------
// Board Heartbeat
// ---------------------------------------------------------------------------

void test_board_heartbeat_roundtrip() {
    Diablo::BoardHeartbeatPacket hb_in;
    memset(hb_in.firmware_hash, 0xAB, 32);
    hb_in.board_id = 42;
    hb_in.engine_state = Diablo::EngineState::FIRING;
    hb_in.board_state = Diablo::BoardState::ACTIVE;

    const uint32_t ts = 99999u;
    uint8_t buf[512];
    size_t n = Diablo::create_board_heartbeat_packet(hb_in, ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    Diablo::BoardHeartbeatPacket hb_out;
    TEST_ASSERT_TRUE(Diablo::parse_board_heartbeat_packet(buf, n, hdr_out, hb_out));

    TEST_ASSERT_EQUAL(Diablo::PacketType::BOARD_HEARTBEAT, hdr_out.packet_type);
    TEST_ASSERT_EQUAL(ts, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(42, hb_out.board_id);
    TEST_ASSERT_EQUAL((int)Diablo::EngineState::FIRING, (int)hb_out.engine_state);
    TEST_ASSERT_EQUAL((int)Diablo::BoardState::ACTIVE, (int)hb_out.board_state);
    TEST_ASSERT_EQUAL_MEMORY(hb_in.firmware_hash, hb_out.firmware_hash, 32);
}

void test_board_heartbeat_buffer_too_small() {
    Diablo::BoardHeartbeatPacket hb_in{};
    uint8_t buf[2]; // way too small
    TEST_ASSERT_EQUAL(0, Diablo::create_board_heartbeat_packet(hb_in, 0u, buf, sizeof(buf)));
}

void test_board_heartbeat_parse_wrong_type() {
    // Construct a buffer with SENSOR_DATA type but try to parse as heartbeat
    uint8_t buf[512];
    Diablo::BoardHeartbeatPacket hb_in{};
    hb_in.board_id = 1;
    size_t n = Diablo::create_board_heartbeat_packet(hb_in, 1u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);
    // Corrupt the packet type
    buf[0] = (uint8_t)Diablo::PacketType::SENSOR_DATA;
    Diablo::PacketHeader hdr;
    Diablo::BoardHeartbeatPacket hb_out;
    TEST_ASSERT_FALSE(Diablo::parse_board_heartbeat_packet(buf, n, hdr, hb_out));
}

// ---------------------------------------------------------------------------
// Server Heartbeat
// ---------------------------------------------------------------------------

void test_server_heartbeat_roundtrip() {
    // Create a server heartbeat manually (no create function, build raw)
    Diablo::PacketHeader hdr;
    hdr.packet_type = Diablo::PacketType::SERVER_HEARTBEAT;
    hdr.version = 0;
    hdr.timestamp = 12345;
    Diablo::ServerHeartbeatPacket srv;
    srv.engine_state = Diablo::EngineState::LOX_FILL;

    uint8_t buf[64];
    memcpy(buf, &hdr, sizeof(hdr));
    memcpy(buf + sizeof(hdr), &srv, sizeof(srv));
    size_t total = sizeof(hdr) + sizeof(srv);

    Diablo::PacketHeader hdr_out;
    Diablo::ServerHeartbeatPacket srv_out;
    TEST_ASSERT_TRUE(Diablo::parse_server_heartbeat_packet(buf, total, hdr_out, srv_out));
    TEST_ASSERT_EQUAL((int)Diablo::EngineState::LOX_FILL, (int)srv_out.engine_state);
    TEST_ASSERT_EQUAL(12345, hdr_out.timestamp);
}

// ---------------------------------------------------------------------------
// Sensor Data (variable-length)
// ---------------------------------------------------------------------------

void test_sensor_data_roundtrip() {
    const uint8_t num_sensors = 3;
    std::vector<Diablo::SensorDataChunkCollection> chunks;

    Diablo::SensorDataChunkCollection c1(1000, num_sensors);
    c1.add_datapoint(1, 0xDEAD);
    c1.add_datapoint(2, 0xBEEF);
    c1.add_datapoint(3, 0xCAFE);
    chunks.push_back(c1);

    Diablo::SensorDataChunkCollection c2(2000, num_sensors);
    c2.add_datapoint(1, 100);
    c2.add_datapoint(2, 200);
    c2.add_datapoint(3, 300);
    chunks.push_back(c2);

    const uint32_t hdr_ts = 5555u;
    uint8_t buf[512];
    size_t n = Diablo::create_sensor_data_packet(chunks, num_sensors, hdr_ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    std::vector<Diablo::SensorDataChunkCollection> chunks_out;
    TEST_ASSERT_TRUE(Diablo::parse_sensor_data_packet(buf, n, hdr_out, chunks_out));

    TEST_ASSERT_EQUAL(hdr_ts, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(2, chunks_out.size());
    TEST_ASSERT_EQUAL(1000, chunks_out[0].timestamp);
    TEST_ASSERT_EQUAL(2000, chunks_out[1].timestamp);
    TEST_ASSERT_EQUAL(3, chunks_out[0].datapoints.size());
    TEST_ASSERT_EQUAL(1, chunks_out[0].datapoints[0].sensor_id);
    TEST_ASSERT_EQUAL(0xDEAD, chunks_out[0].datapoints[0].data);
    TEST_ASSERT_EQUAL(2, chunks_out[0].datapoints[1].sensor_id);
    TEST_ASSERT_EQUAL(0xBEEF, chunks_out[0].datapoints[1].data);
    TEST_ASSERT_EQUAL(300, chunks_out[1].datapoints[2].data);
}

void test_sensor_data_buffer_too_small() {
    std::vector<Diablo::SensorDataChunkCollection> chunks;
    Diablo::SensorDataChunkCollection c1(1000, 2);
    c1.add_datapoint(1, 100);
    c1.add_datapoint(2, 200);
    chunks.push_back(c1);

    uint8_t buf[4]; // too small
    TEST_ASSERT_EQUAL(0, Diablo::create_sensor_data_packet(chunks, 2, 0u, buf, sizeof(buf)));
}

// ---------------------------------------------------------------------------
// Actuator Command
// ---------------------------------------------------------------------------

void test_actuator_command_roundtrip() {
    std::vector<Diablo::ActuatorCommand> cmds;
    cmds.push_back({1, 1}); // actuator 1 ON
    cmds.push_back({3, 0}); // actuator 3 OFF
    cmds.push_back({7, 1}); // actuator 7 ON

    const uint32_t ts = 7777u;
    uint8_t buf[512];
    size_t n = Diablo::create_actuator_command_packet(cmds, ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    std::vector<Diablo::ActuatorCommand> cmds_out;
    TEST_ASSERT_TRUE(Diablo::parse_actuator_command_packet(buf, n, hdr_out, cmds_out));

    TEST_ASSERT_EQUAL(ts, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(3, cmds_out.size());
    TEST_ASSERT_EQUAL(1, cmds_out[0].actuator_id);
    TEST_ASSERT_EQUAL(1, cmds_out[0].actuator_state);
    TEST_ASSERT_EQUAL(3, cmds_out[1].actuator_id);
    TEST_ASSERT_EQUAL(0, cmds_out[1].actuator_state);
    TEST_ASSERT_EQUAL(7, cmds_out[2].actuator_id);
    TEST_ASSERT_EQUAL(1, cmds_out[2].actuator_state);
}

void test_actuator_command_empty_list() {
    std::vector<Diablo::ActuatorCommand> cmds; // empty
    uint8_t buf[512];
    TEST_ASSERT_EQUAL(0, Diablo::create_actuator_command_packet(cmds, 0u, buf, sizeof(buf)));
}

// ---------------------------------------------------------------------------
// PWM Actuator Command
// ---------------------------------------------------------------------------

void test_pwm_actuator_roundtrip() {
    std::vector<Diablo::PWMActuatorCommand> cmds;
    Diablo::PWMActuatorCommand cmd;
    cmd.actuator_id = 5;
    cmd.duration = 3000;
    cmd.duty_cycle = 0.75f;
    cmd.frequency = 100.0f;
    cmds.push_back(cmd);

    const uint32_t ts = 8888u;
    uint8_t buf[512];
    size_t n = Diablo::create_pwm_actuator_packet(cmds, ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    std::vector<Diablo::PWMActuatorCommand> cmds_out;
    TEST_ASSERT_TRUE(Diablo::parse_pwm_actuator_packet(buf, n, hdr_out, cmds_out));

    TEST_ASSERT_EQUAL(ts, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(1, cmds_out.size());
    TEST_ASSERT_EQUAL(5, cmds_out[0].actuator_id);
    TEST_ASSERT_EQUAL(3000, cmds_out[0].duration);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.75f, cmds_out[0].duty_cycle);
    TEST_ASSERT_FLOAT_WITHIN(0.1f, 100.0f, cmds_out[0].frequency);
}

// ---------------------------------------------------------------------------
// Sensor Config (conditional controller_ip field)
// ---------------------------------------------------------------------------

void test_sensor_config_roundtrip_with_abort() {
    std::vector<uint8_t> sensor_ids = {1, 3, 5, 7};
    uint8_t ref_voltage = 1;  // VDD
    bool necessary_for_abort = true;
    uint32_t controller_ip = 0xC0A80232; // 192.168.2.50
    uint8_t enable_serial = 1;

    const uint32_t ts = 11111u;
    uint8_t buf[512];
    size_t n = Diablo::create_sensor_config_packet(
        sensor_ids, ref_voltage, necessary_for_abort,
        controller_ip, enable_serial, ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    std::vector<uint8_t> ids_out;
    uint8_t ref_out;
    bool abort_out;
    uint32_t ip_out;
    uint8_t serial_out;
    TEST_ASSERT_TRUE(Diablo::parse_sensor_config_packet(
        buf, n, hdr_out, ids_out, ref_out, abort_out, ip_out, serial_out));

    TEST_ASSERT_EQUAL(ts, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(4, ids_out.size());
    TEST_ASSERT_EQUAL(1, ids_out[0]);
    TEST_ASSERT_EQUAL(7, ids_out[3]);
    TEST_ASSERT_EQUAL(1, ref_out);
    TEST_ASSERT_TRUE(abort_out);
    TEST_ASSERT_EQUAL_HEX32(0xC0A80232, ip_out);
    TEST_ASSERT_EQUAL(1, serial_out);
}

void test_sensor_config_roundtrip_without_abort() {
    std::vector<uint8_t> sensor_ids = {2};
    uint8_t ref_voltage = 0;
    bool necessary_for_abort = false;
    uint32_t controller_ip = 0; // should not be written

    const uint32_t ts = 11112u;
    uint8_t buf[512];
    size_t n = Diablo::create_sensor_config_packet(
        sensor_ids, ref_voltage, necessary_for_abort,
        controller_ip, 0, ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    std::vector<uint8_t> ids_out;
    uint8_t ref_out;
    bool abort_out;
    uint32_t ip_out = 0xFFFFFFFF;
    uint8_t serial_out;
    TEST_ASSERT_TRUE(Diablo::parse_sensor_config_packet(
        buf, n, hdr_out, ids_out, ref_out, abort_out, ip_out, serial_out));

    TEST_ASSERT_EQUAL(ts, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(1, ids_out.size());
    TEST_ASSERT_EQUAL(2, ids_out[0]);
    TEST_ASSERT_FALSE(abort_out);
    TEST_ASSERT_EQUAL(0, ip_out); // parser should zero it
}

void test_sensor_config_empty_sensors() {
    std::vector<uint8_t> sensor_ids; // empty
    uint8_t buf[512];
    size_t n = Diablo::create_sensor_config_packet(
        sensor_ids, 0, false, 0, 1, 11113u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    std::vector<uint8_t> ids_out;
    uint8_t ref_out, serial_out;
    bool abort_out;
    uint32_t ip_out;
    TEST_ASSERT_TRUE(Diablo::parse_sensor_config_packet(
        buf, n, hdr_out, ids_out, ref_out, abort_out, ip_out, serial_out));
    TEST_ASSERT_EQUAL(0, ids_out.size());
}

// ---------------------------------------------------------------------------
// Actuator Config (complex layout)
// ---------------------------------------------------------------------------

void test_actuator_config_roundtrip() {
    std::vector<Diablo::AbortActuatorLocation> actuators;
    actuators.push_back({0xC0A80201, 1, 1, 0}); // IP, id, vent=on, abort=off
    actuators.push_back({0xC0A80202, 3, 0, 1}); // different board

    std::vector<Diablo::AbortPTLocation> pts;
    pts.push_back({0xC0A80203, 2, 500000}); // IP, sensor_id, threshold

    uint8_t buf[512];
    size_t n = Diablo::create_actuator_config_packet(1, actuators, pts, 1, 22222u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    uint8_t is_controller;
    std::vector<Diablo::AbortActuatorLocation> act_out;
    std::vector<Diablo::AbortPTLocation> pt_out;
    uint8_t serial_out;
    TEST_ASSERT_TRUE(Diablo::parse_actuator_config_packet(
        buf, n, hdr_out, is_controller, act_out, pt_out, serial_out));

    TEST_ASSERT_EQUAL(22222u, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(1, is_controller);
    TEST_ASSERT_EQUAL(2, act_out.size());
    TEST_ASSERT_EQUAL_HEX32(0xC0A80201, act_out[0].ip_address);
    TEST_ASSERT_EQUAL(1, act_out[0].actuator_id);
    TEST_ASSERT_EQUAL(1, act_out[0].vent_state);
    TEST_ASSERT_EQUAL(0, act_out[0].abort_state);
    TEST_ASSERT_EQUAL(1, pt_out.size());
    TEST_ASSERT_EQUAL(2, pt_out[0].sensor_id);
    TEST_ASSERT_EQUAL(500000, pt_out[0].pressure_threshold_adc);
    TEST_ASSERT_EQUAL(1, serial_out);
}

void test_actuator_config_no_pts() {
    std::vector<Diablo::AbortActuatorLocation> actuators;
    actuators.push_back({0xC0A80201, 1, 1, 1});
    std::vector<Diablo::AbortPTLocation> pts; // empty

    uint8_t buf[512];
    size_t n = Diablo::create_actuator_config_packet(0, actuators, pts, 0, 22223u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    uint8_t is_controller;
    std::vector<Diablo::AbortActuatorLocation> act_out;
    std::vector<Diablo::AbortPTLocation> pt_out;
    uint8_t serial_out;
    TEST_ASSERT_TRUE(Diablo::parse_actuator_config_packet(
        buf, n, hdr_out, is_controller, act_out, pt_out, serial_out));
    TEST_ASSERT_EQUAL(22223u, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(0, is_controller);
    TEST_ASSERT_EQUAL(1, act_out.size());
    TEST_ASSERT_EQUAL(0, pt_out.size());
    TEST_ASSERT_EQUAL(0, serial_out);
}

// ---------------------------------------------------------------------------
// Self Test
// ---------------------------------------------------------------------------

void test_self_test_roundtrip() {
    std::vector<Diablo::SelfTestResult> results;
    results.push_back({1, 1}); // sensor 1 good
    results.push_back({2, 0}); // sensor 2 bad
    results.push_back({5, 1}); // sensor 5 good

    const uint32_t ts = 33333u;
    uint8_t buf[512];
    size_t n = Diablo::create_self_test_packet(1, results, ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    uint8_t adc_good_out;
    std::vector<Diablo::SelfTestResult> results_out;
    TEST_ASSERT_TRUE(Diablo::parse_self_test_packet(buf, n, hdr_out, adc_good_out, results_out));

    TEST_ASSERT_EQUAL(ts, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(1, adc_good_out);
    TEST_ASSERT_EQUAL(3, results_out.size());
    TEST_ASSERT_EQUAL(1, results_out[0].sensor_id);
    TEST_ASSERT_EQUAL(1, results_out[0].result);
    TEST_ASSERT_EQUAL(2, results_out[1].sensor_id);
    TEST_ASSERT_EQUAL(0, results_out[1].result);
}

void test_self_test_adc_bad() {
    std::vector<Diablo::SelfTestResult> results;
    results.push_back({1, 0});

    uint8_t buf[512];
    size_t n = Diablo::create_self_test_packet(0, results, 33334u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    Diablo::PacketHeader hdr_out;
    uint8_t adc_good_out;
    std::vector<Diablo::SelfTestResult> results_out;
    TEST_ASSERT_TRUE(Diablo::parse_self_test_packet(buf, n, hdr_out, adc_good_out, results_out));
    TEST_ASSERT_EQUAL(33334u, hdr_out.timestamp);
    TEST_ASSERT_EQUAL(0, adc_good_out);
}

// ---------------------------------------------------------------------------
// Abort Done (header-only)
// ---------------------------------------------------------------------------

void test_abort_done_roundtrip() {
    const uint32_t ts = 44444u;
    uint8_t buf[64];
    size_t n = Diablo::create_abort_done_packet(ts, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);
    TEST_ASSERT_EQUAL(sizeof(Diablo::PacketHeader), n);

    Diablo::PacketHeader hdr_out;
    TEST_ASSERT_TRUE(Diablo::parse_abort_done_packet(buf, n, hdr_out));
    TEST_ASSERT_EQUAL((int)Diablo::PacketType::ABORT_DONE, (int)hdr_out.packet_type);
    TEST_ASSERT_EQUAL(ts, hdr_out.timestamp);
}

void test_abort_done_buffer_too_small() {
    uint8_t buf[2];
    TEST_ASSERT_EQUAL(0, Diablo::create_abort_done_packet(0u, buf, sizeof(buf)));
}

// ---------------------------------------------------------------------------
// Parse with null buffer
// ---------------------------------------------------------------------------

void test_parse_null_buffer() {
    Diablo::PacketHeader hdr;
    Diablo::BoardHeartbeatPacket hb;
    TEST_ASSERT_FALSE(Diablo::parse_board_heartbeat_packet(nullptr, 100, hdr, hb));

    std::vector<Diablo::SensorDataChunkCollection> chunks;
    TEST_ASSERT_FALSE(Diablo::parse_sensor_data_packet(nullptr, 100, hdr, chunks));

    std::vector<Diablo::ActuatorCommand> cmds;
    TEST_ASSERT_FALSE(Diablo::parse_actuator_command_packet(nullptr, 100, hdr, cmds));
}

// ---------------------------------------------------------------------------
// Unity runner
// ---------------------------------------------------------------------------

void setUp() {}
void tearDown() {}

int main(int argc, char **argv) {
    UNITY_BEGIN();

    // Board Heartbeat
    RUN_TEST(test_board_heartbeat_roundtrip);
    RUN_TEST(test_board_heartbeat_buffer_too_small);
    RUN_TEST(test_board_heartbeat_parse_wrong_type);

    // Server Heartbeat
    RUN_TEST(test_server_heartbeat_roundtrip);

    // Sensor Data
    RUN_TEST(test_sensor_data_roundtrip);
    RUN_TEST(test_sensor_data_buffer_too_small);

    // Actuator Command
    RUN_TEST(test_actuator_command_roundtrip);
    RUN_TEST(test_actuator_command_empty_list);

    // PWM Actuator Command
    RUN_TEST(test_pwm_actuator_roundtrip);

    // Sensor Config
    RUN_TEST(test_sensor_config_roundtrip_with_abort);
    RUN_TEST(test_sensor_config_roundtrip_without_abort);
    RUN_TEST(test_sensor_config_empty_sensors);

    // Actuator Config
    RUN_TEST(test_actuator_config_roundtrip);
    RUN_TEST(test_actuator_config_no_pts);

    // Self Test
    RUN_TEST(test_self_test_roundtrip);
    RUN_TEST(test_self_test_adc_bad);

    // Abort Done
    RUN_TEST(test_abort_done_roundtrip);
    RUN_TEST(test_abort_done_buffer_too_small);

    // Null buffer
    RUN_TEST(test_parse_null_buffer);

    return UNITY_END();
}
