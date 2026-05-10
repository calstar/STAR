/**
 * Sensor state machine unit tests
 *
 * Tests the sensor state machine transitions, packet processing, and
 * heartbeat state encoding.
 * 
 * Rather than including SensorHotfireCore.h directly (which pulls in
 * heavy ESP32 dependencies), we extract the testable pure-logic functions
 * here. This mirrors the approach used for the actuator tests.
 */
#include <unity.h>
#include <cstring>
#include <vector>

// DAQv2-Comms
#include "DiabloEnums.h"
#include "DiabloPackets.h"
#include "DiabloPacketUtils.h"
#include "DiabloPacketUtils.cpp"

// ---------------------------------------------------------------------------
// Replicate the sensor state machine enums and transition logic
// (extracted from SensorHotfireCore.h for testability)
// ---------------------------------------------------------------------------

namespace SensorSM {

enum class State : uint8_t {
    WaitingForServer = 1,
    Active = 2,
    StandaloneAbort = 9,
    SelfTest = 10
};

enum class IncomingPacketKind {
    None,
    ServerHeartbeat,
    SensorConfig,
    NoConnAbort,
    ClearAbort
};

// Extracted config for testing
struct StoredConfig {
    bool valid = false;
    uint8_t num_sensors = 0;
    uint8_t sensor_ids[10] = {};
    uint8_t reference_voltage = 0;
    bool necessary_for_abort = false;
    uint32_t actuator_controller_ip = 0;
    uint8_t enable_serial_printing = 0;
};

// Replicate applyPacketTransition from SensorHotfireCore.h
static State applyPacketTransition(State state, IncomingPacketKind kind,
                                    bool necessary_for_abort, bool run_self_test) {
    switch (state) {
        case State::WaitingForServer:
            if (kind == IncomingPacketKind::SensorConfig) {
                if (run_self_test) {
                    return State::SelfTest;
                } else {
                    return State::Active;
                }
            }
            break;
        case State::Active:
            if (kind == IncomingPacketKind::NoConnAbort && necessary_for_abort) {
                return State::StandaloneAbort;
            }
            break;
        case State::StandaloneAbort:
            if (kind == IncomingPacketKind::ClearAbort) {
                return State::Active;
            }
            break;
    }
    return state; // No transition
}

// Replicate readPacketHeader from SensorHotfireCore.h
static IncomingPacketKind readPacketHeader(const uint8_t* buf, size_t len) {
    if (len < sizeof(Diablo::PacketHeader)) return IncomingPacketKind::None;
    Diablo::PacketHeader hdr;
    memcpy(&hdr, buf, sizeof(hdr));
    switch (hdr.packet_type) {
        case Diablo::PacketType::SERVER_HEARTBEAT: return IncomingPacketKind::ServerHeartbeat;
        case Diablo::PacketType::SENSOR_CONFIG:    return IncomingPacketKind::SensorConfig;
        case Diablo::PacketType::CLEAR_ABORT:      return IncomingPacketKind::ClearAbort;
        default: return IncomingPacketKind::None;
    }
}

// Replicate processIncomingPacket (simplified, testing-focused)
static IncomingPacketKind processIncomingPacket(
    StoredConfig& stored_config,
    const uint8_t* buf, size_t len)
{
    IncomingPacketKind kind = readPacketHeader(buf, len);

    if (kind == IncomingPacketKind::SensorConfig) {
        // Parse the config packet
        Diablo::PacketHeader hdr_out;
        std::vector<uint8_t> ids;
        uint8_t ref;
        bool abort_needed;
        uint32_t controller_ip;
        uint8_t serial;
        if (Diablo::parse_sensor_config_packet(buf, len, hdr_out, ids, ref,
                                                abort_needed, controller_ip, serial)) {
            stored_config.valid = true;
            stored_config.num_sensors = ids.size();
            for (size_t i = 0; i < ids.size() && i < 10; i++) {
                stored_config.sensor_ids[i] = ids[i];
            }
            stored_config.reference_voltage = ref;
            stored_config.necessary_for_abort = abort_needed;
            stored_config.actuator_controller_ip = controller_ip;
            stored_config.enable_serial_printing = serial;
        }
    }

    return kind;
}

// Replicate the heartbeat state→BoardState mapping from loop()
static Diablo::BoardState getBoardStateForHeartbeat(State state) {
    switch (state) {
        case State::WaitingForServer: return Diablo::BoardState::SETUP;
        case State::Active:           return Diablo::BoardState::ACTIVE;
        case State::StandaloneAbort:  return Diablo::BoardState::STANDALONE_ABORT;
        case State::SelfTest:         return Diablo::BoardState::SELF_TEST;
        default:                      return Diablo::BoardState::SETUP;
    }
}

} // namespace SensorSM

// ===========================================================================
// State transition tests
// ===========================================================================

void test_sensor_initial_state() {
    SensorSM::State s = SensorSM::State::WaitingForServer;
    TEST_ASSERT_EQUAL((int)SensorSM::State::WaitingForServer, (int)s);
}

void test_sensor_config_transitions_to_active() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::WaitingForServer,
        SensorSM::IncomingPacketKind::SensorConfig, false, false);
    TEST_ASSERT_EQUAL((int)SensorSM::State::Active, (int)next);
}

void test_sensor_config_transitions_to_selftest() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::WaitingForServer,
        SensorSM::IncomingPacketKind::SensorConfig, false, true);
    TEST_ASSERT_EQUAL((int)SensorSM::State::SelfTest, (int)next);
}

void test_sensor_heartbeat_stays_waiting() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::WaitingForServer,
        SensorSM::IncomingPacketKind::ServerHeartbeat, false, false);
    TEST_ASSERT_EQUAL((int)SensorSM::State::WaitingForServer, (int)next);
}

void test_sensor_noconn_abort_with_necessary() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::Active,
        SensorSM::IncomingPacketKind::NoConnAbort, true, false);
    TEST_ASSERT_EQUAL((int)SensorSM::State::StandaloneAbort, (int)next);
}

void test_sensor_noconn_abort_without_necessary() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::Active,
        SensorSM::IncomingPacketKind::NoConnAbort, false, false);
    TEST_ASSERT_EQUAL((int)SensorSM::State::Active, (int)next);
}

void test_sensor_clear_abort_returns_to_active() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::StandaloneAbort,
        SensorSM::IncomingPacketKind::ClearAbort, true, false);
    TEST_ASSERT_EQUAL((int)SensorSM::State::Active, (int)next);
}

void test_sensor_clear_abort_in_active_stays() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::Active,
        SensorSM::IncomingPacketKind::ClearAbort, false, false);
    TEST_ASSERT_EQUAL((int)SensorSM::State::Active, (int)next);
}

void test_sensor_none_packet_doesnt_transition() {
    auto next = SensorSM::applyPacketTransition(
        SensorSM::State::Active,
        SensorSM::IncomingPacketKind::None, false, false);
    TEST_ASSERT_EQUAL((int)SensorSM::State::Active, (int)next);
}

// ===========================================================================
// processIncomingPacket — parse raw buffers into packet kinds
// ===========================================================================

void test_sensor_process_server_heartbeat_packet() {
    Diablo::PacketHeader hdr;
    hdr.packet_type = Diablo::PacketType::SERVER_HEARTBEAT;
    hdr.version = 0;
    hdr.timestamp = 1000;
    Diablo::ServerHeartbeatPacket srv;
    srv.engine_state = Diablo::EngineState::SAFE;

    uint8_t buf[64];
    memcpy(buf, &hdr, sizeof(hdr));
    memcpy(buf + sizeof(hdr), &srv, sizeof(srv));
    size_t total = sizeof(hdr) + sizeof(srv);

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, total);
    TEST_ASSERT_EQUAL((int)SensorSM::IncomingPacketKind::ServerHeartbeat, (int)kind);
}

void test_sensor_process_sensor_config_packet() {
    std::vector<uint8_t> sensor_ids = {1, 2, 3};
    uint8_t buf[512];
    size_t n = Diablo::create_sensor_config_packet(
        sensor_ids, 0, false, 0, 1, 9001u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, n);
    TEST_ASSERT_EQUAL((int)SensorSM::IncomingPacketKind::SensorConfig, (int)kind);

    TEST_ASSERT_TRUE(cfg.valid);
    TEST_ASSERT_EQUAL(3, cfg.num_sensors);
    TEST_ASSERT_EQUAL(1, cfg.sensor_ids[0]);
    TEST_ASSERT_EQUAL(2, cfg.sensor_ids[1]);
    TEST_ASSERT_EQUAL(3, cfg.sensor_ids[2]);
}

void test_sensor_process_sensor_config_with_abort() {
    std::vector<uint8_t> sensor_ids = {5, 10};
    uint32_t controller_ip = 0xC0A80232;
    uint8_t buf[512];
    size_t n = Diablo::create_sensor_config_packet(
        sensor_ids, 1, true, controller_ip, 1, 9002u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, n);
    TEST_ASSERT_EQUAL((int)SensorSM::IncomingPacketKind::SensorConfig, (int)kind);

    TEST_ASSERT_TRUE(cfg.valid);
    TEST_ASSERT_TRUE(cfg.necessary_for_abort);
    TEST_ASSERT_EQUAL(1, cfg.reference_voltage);
    TEST_ASSERT_EQUAL_HEX32(0xC0A80232, cfg.actuator_controller_ip);
    TEST_ASSERT_EQUAL(1, cfg.enable_serial_printing);
}

void test_sensor_process_clear_abort_packet() {
    Diablo::PacketHeader hdr;
    hdr.packet_type = Diablo::PacketType::CLEAR_ABORT;
    hdr.version = 0;
    hdr.timestamp = 0;
    uint8_t buf[16];
    memcpy(buf, &hdr, sizeof(hdr));

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, sizeof(hdr));
    TEST_ASSERT_EQUAL((int)SensorSM::IncomingPacketKind::ClearAbort, (int)kind);
}

void test_sensor_process_too_short_returns_none() {
    uint8_t buf[2] = {0, 0};
    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, 2);
    TEST_ASSERT_EQUAL((int)SensorSM::IncomingPacketKind::None, (int)kind);
}

// ===========================================================================
// Heartbeat state encoding — verify state→BoardState mapping
// ===========================================================================

void test_sensor_heartbeat_state_mapping_table() {
    struct { SensorSM::State state; Diablo::BoardState expected; } mappings[] = {
        { SensorSM::State::WaitingForServer, Diablo::BoardState::SETUP },
        { SensorSM::State::Active,           Diablo::BoardState::ACTIVE },
        { SensorSM::State::StandaloneAbort,  Diablo::BoardState::STANDALONE_ABORT },
        { SensorSM::State::SelfTest,         Diablo::BoardState::SELF_TEST },
    };

    for (auto& m : mappings) {
        Diablo::BoardState got = SensorSM::getBoardStateForHeartbeat(m.state);
        TEST_ASSERT_EQUAL_MESSAGE(
            (int)m.expected, (int)got,
            "State mapping mismatch in getBoardStateForHeartbeat");

        // Also create → parse heartbeat to verify wire encoding
        Diablo::BoardHeartbeatPacket hb{};
        hb.board_id = 42;
        hb.engine_state = Diablo::EngineState::SAFE;
        hb.board_state = got;

        uint8_t buf[512];
        size_t n = Diablo::create_board_heartbeat_packet(hb, 9003u, buf, sizeof(buf));
        TEST_ASSERT_GREATER_THAN(0, n);

        Diablo::PacketHeader hdr_out;
        Diablo::BoardHeartbeatPacket hb_out;
        TEST_ASSERT_TRUE(Diablo::parse_board_heartbeat_packet(buf, n, hdr_out, hb_out));
        TEST_ASSERT_EQUAL((int)m.expected, (int)hb_out.board_state);
        TEST_ASSERT_EQUAL(42, hb_out.board_id);
        TEST_ASSERT_EQUAL((int)Diablo::EngineState::SAFE, (int)hb_out.engine_state);
    }
}

// ===========================================================================
// Unity runner
// ===========================================================================

void setUp() {}
void tearDown() {}

int main(int argc, char **argv) {
    UNITY_BEGIN();

    // State transitions
    RUN_TEST(test_sensor_initial_state);
    RUN_TEST(test_sensor_config_transitions_to_active);
    RUN_TEST(test_sensor_config_transitions_to_selftest);
    RUN_TEST(test_sensor_heartbeat_stays_waiting);
    RUN_TEST(test_sensor_noconn_abort_with_necessary);
    RUN_TEST(test_sensor_noconn_abort_without_necessary);
    RUN_TEST(test_sensor_clear_abort_returns_to_active);
    RUN_TEST(test_sensor_clear_abort_in_active_stays);
    RUN_TEST(test_sensor_none_packet_doesnt_transition);

    // processIncomingPacket
    RUN_TEST(test_sensor_process_server_heartbeat_packet);
    RUN_TEST(test_sensor_process_sensor_config_packet);
    RUN_TEST(test_sensor_process_sensor_config_with_abort);
    RUN_TEST(test_sensor_process_clear_abort_packet);
    RUN_TEST(test_sensor_process_too_short_returns_none);

    // Heartbeat state encoding
    RUN_TEST(test_sensor_heartbeat_state_mapping_table);

    return UNITY_END();
}
