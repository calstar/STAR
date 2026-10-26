/**
 * Sensor state machine unit tests
 *
 * Exercises SensorCoreLogic.h, the hardware-free half of the sensor hotfire
 * core, directly: packet classification, state transitions, heartbeat state
 * encoding, chunk batching, the drop-oldest queue rule and data-ready
 * timeouts.
 */
#include <unity.h>

#include <cstring>
#include <deque>
#include <vector>

// DAQv2-Comms
#include "DiabloEnums.h"
#include "DiabloPacketUtils.cpp"
#include "DiabloPacketUtils.h"
#include "DiabloPackets.h"
#include "SensorCoreLogic.h"

using SensorHotfire::IncomingPacketKind;
using SensorHotfire::State;

namespace SensorSM {

using StoredConfig = SensorHotfire::StoredSensorConfig;

static State applyPacketTransition(State state, IncomingPacketKind kind,
                                   bool necessary_for_abort,
                                   bool run_self_test) {
    return SensorHotfire::nextState(state, kind, necessary_for_abort,
                                    run_self_test);
}

static uint8_t g_last_log_mode = 0;

static IncomingPacketKind processIncomingPacket(StoredConfig& stored_config,
                                                const uint8_t* buf,
                                                size_t len) {
    return SensorHotfire::parseIncoming(buf, len, stored_config,
                                        g_last_log_mode);
}

static daq::BoardState getBoardStateForHeartbeat(State state) {
    return SensorHotfire::boardStateFor(state);
}

}  // namespace SensorSM

// ===========================================================================
// State transition tests
// ===========================================================================

void test_sensor_initial_state() {
    State s = State::WaitingForServer;
    TEST_ASSERT_EQUAL((int)State::WaitingForServer, (int)s);
}

void test_sensor_config_transitions_to_active() {
    auto next = SensorSM::applyPacketTransition(
        State::WaitingForServer,
        IncomingPacketKind::SensorConfig, false, false);
    TEST_ASSERT_EQUAL((int)State::Active, (int)next);
}

void test_sensor_config_transitions_to_selftest() {
    auto next = SensorSM::applyPacketTransition(
        State::WaitingForServer,
        IncomingPacketKind::SensorConfig, false, true);
    TEST_ASSERT_EQUAL((int)State::SelfTest, (int)next);
}

void test_sensor_heartbeat_stays_waiting() {
    auto next = SensorSM::applyPacketTransition(
        State::WaitingForServer,
        IncomingPacketKind::ServerHeartbeat, false, false);
    TEST_ASSERT_EQUAL((int)State::WaitingForServer, (int)next);
}

void test_sensor_noconn_abort_with_necessary() {
    auto next = SensorSM::applyPacketTransition(
        State::Active, IncomingPacketKind::NoConnAbort,
        true, false);
    TEST_ASSERT_EQUAL((int)State::StandaloneAbort, (int)next);
}

void test_sensor_noconn_abort_without_necessary() {
    auto next = SensorSM::applyPacketTransition(
        State::Active, IncomingPacketKind::NoConnAbort,
        false, false);
    TEST_ASSERT_EQUAL((int)State::Active, (int)next);
}

void test_sensor_clear_abort_returns_to_active() {
    auto next = SensorSM::applyPacketTransition(
        State::StandaloneAbort,
        IncomingPacketKind::ClearAbort, true, false);
    TEST_ASSERT_EQUAL((int)State::Active, (int)next);
}

void test_sensor_clear_abort_in_active_stays() {
    auto next = SensorSM::applyPacketTransition(
        State::Active, IncomingPacketKind::ClearAbort,
        false, false);
    TEST_ASSERT_EQUAL((int)State::Active, (int)next);
}

void test_sensor_none_packet_doesnt_transition() {
    auto next = SensorSM::applyPacketTransition(
        State::Active, IncomingPacketKind::None, false,
        false);
    TEST_ASSERT_EQUAL((int)State::Active, (int)next);
}

// ===========================================================================
// processIncomingPacket — parse raw buffers into packet kinds
// ===========================================================================

void test_sensor_process_server_heartbeat_packet() {
    daq::PacketHeader hdr;
    hdr.packet_type = daq::PacketType::SERVER_HEARTBEAT;
    hdr.version = 0;
    hdr.timestamp = 1000;
    daq::ServerHeartbeatPacket srv;
    srv.engine_state = daq::EngineState::SAFE;

    uint8_t buf[64];
    memcpy(buf, &hdr, sizeof(hdr));
    memcpy(buf + sizeof(hdr), &srv, sizeof(srv));
    size_t total = sizeof(hdr) + sizeof(srv);

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, total);
    TEST_ASSERT_EQUAL((int)IncomingPacketKind::ServerHeartbeat,
                      (int)kind);
}

void test_sensor_process_sensor_config_packet() {
    std::vector<uint8_t> sensor_ids = {1, 2, 3};
    uint8_t buf[512];
    size_t n = daq::create_sensor_config_packet(sensor_ids, 0, false, 0, 1,
                                                9001u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, n);
    TEST_ASSERT_EQUAL((int)IncomingPacketKind::SensorConfig,
                      (int)kind);

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
    size_t n = daq::create_sensor_config_packet(
        sensor_ids, 1, true, controller_ip, 1, 9002u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, n);
    TEST_ASSERT_EQUAL((int)IncomingPacketKind::SensorConfig,
                      (int)kind);

    TEST_ASSERT_TRUE(cfg.valid);
    TEST_ASSERT_TRUE(cfg.necessary_for_abort);
    TEST_ASSERT_EQUAL(1, cfg.reference_voltage);
    TEST_ASSERT_EQUAL_HEX32(0xC0A80232, cfg.actuator_controller_ip);
    TEST_ASSERT_EQUAL(1, SensorSM::g_last_log_mode);
}

void test_sensor_process_clear_abort_packet() {
    daq::PacketHeader hdr;
    hdr.packet_type = daq::PacketType::CLEAR_ABORT;
    hdr.version = 0;
    hdr.timestamp = 0;
    uint8_t buf[16];
    memcpy(buf, &hdr, sizeof(hdr));

    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, sizeof(hdr));
    TEST_ASSERT_EQUAL((int)IncomingPacketKind::ClearAbort, (int)kind);
}

void test_sensor_process_too_short_returns_none() {
    uint8_t buf[2] = {0, 0};
    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, 2);
    TEST_ASSERT_EQUAL((int)IncomingPacketKind::None, (int)kind);
}

// ===========================================================================
// Heartbeat state encoding — verify state→BoardState mapping
// ===========================================================================

void test_sensor_heartbeat_state_mapping_table() {
    struct {
        State state;
        daq::BoardState expected;
    } mappings[] = {
        {State::WaitingForServer, daq::BoardState::SETUP},
        {State::Active, daq::BoardState::ACTIVE},
        {State::StandaloneAbort, daq::BoardState::STANDALONE_ABORT},
        {State::SelfTest, daq::BoardState::SELF_TEST},
    };

    for (auto& m : mappings) {
        daq::BoardState got = SensorSM::getBoardStateForHeartbeat(m.state);
        TEST_ASSERT_EQUAL_MESSAGE(
            (int)m.expected, (int)got,
            "State mapping mismatch in getBoardStateForHeartbeat");

        // Also create → parse heartbeat to verify wire encoding
        daq::BoardHeartbeatPacket hb{};
        hb.board_id = 42;
        hb.engine_state = daq::EngineState::SAFE;
        hb.board_state = got;

        uint8_t buf[512];
        size_t n =
            daq::create_board_heartbeat_packet(hb, 9003u, buf, sizeof(buf));
        TEST_ASSERT_GREATER_THAN(0, n);

        daq::PacketHeader hdr_out;
        daq::BoardHeartbeatPacket hb_out;
        TEST_ASSERT_TRUE(
            daq::parse_board_heartbeat_packet(buf, n, hdr_out, hb_out));
        TEST_ASSERT_EQUAL((int)m.expected, (int)hb_out.board_state);
        TEST_ASSERT_EQUAL(42, hb_out.board_id);
        TEST_ASSERT_EQUAL((int)daq::EngineState::SAFE,
                          (int)hb_out.engine_state);
    }
}

// ===========================================================================
// Config parsing edge cases
// ===========================================================================

void test_sensor_bad_config_leaves_stored_config_untouched() {
    std::vector<uint8_t> sensor_ids = {4, 5};
    uint8_t buf[512];
    size_t n = daq::create_sensor_config_packet(sensor_ids, 0, false, 0, 1,
                                                9004u, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    SensorSM::StoredConfig cfg{};
    cfg.num_sensors = 7;
    // Truncate the packet so the body no longer parses.
    auto kind = SensorSM::processIncomingPacket(cfg, buf, n - 1);
    TEST_ASSERT_EQUAL((int)IncomingPacketKind::None, (int)kind);
    TEST_ASSERT_FALSE(cfg.valid);
    TEST_ASSERT_EQUAL(7, cfg.num_sensors);
}

void test_sensor_no_conn_abort_packet() {
    daq::PacketHeader hdr{};
    hdr.packet_type = daq::PacketType::NO_CONNECTION_ABORT;
    uint8_t buf[16];
    memcpy(buf, &hdr, sizeof(hdr));
    SensorSM::StoredConfig cfg{};
    auto kind = SensorSM::processIncomingPacket(cfg, buf, sizeof(hdr));
    TEST_ASSERT_EQUAL((int)IncomingPacketKind::NoConnAbort, (int)kind);
}

void test_sensor_selftest_ignores_packets() {
    auto next = SensorSM::applyPacketTransition(
        State::SelfTest, IncomingPacketKind::NoConnAbort, true, true);
    TEST_ASSERT_EQUAL((int)State::SelfTest, (int)next);
}

void test_sensor_same_sensor_list() {
    SensorSM::StoredConfig a{}, b{};
    a.num_sensors = b.num_sensors = 2;
    a.sensor_ids[0] = b.sensor_ids[0] = 1;
    a.sensor_ids[1] = b.sensor_ids[1] = 3;
    TEST_ASSERT_TRUE(SensorHotfire::sameSensorList(a, b));
    b.sensor_ids[1] = 4;
    TEST_ASSERT_FALSE(SensorHotfire::sameSensorList(a, b));
    b.sensor_ids[1] = 3;
    b.num_sensors = 1;
    TEST_ASSERT_FALSE(SensorHotfire::sameSensorList(a, b));
}

// ===========================================================================
// Chunk batching
// ===========================================================================

static SensorHotfire::Chunk makeChunk(uint32_t ts, uint32_t seq, uint8_t n) {
    SensorHotfire::Chunk c{};
    c.timestamp_ms = ts;
    c.config_seq = seq;
    c.num_sensors = n;
    for (uint8_t i = 0; i < n; ++i) {
        c.sensor_ids[i] = i + 1;
        c.values[i] = ts * 100 + i;
    }
    return c;
}

void test_batch_fills_to_capacity() {
    SensorHotfire::ChunkBatch batch(3);
    TEST_ASSERT_TRUE(batch.add(makeChunk(1, 0, 2)));
    TEST_ASSERT_TRUE(batch.add(makeChunk(2, 0, 2)));
    TEST_ASSERT_TRUE(batch.add(makeChunk(3, 0, 2)));
    TEST_ASSERT_TRUE(batch.full());
    TEST_ASSERT_TRUE(batch.mustSendBefore(makeChunk(4, 0, 2)));
    TEST_ASSERT_FALSE(batch.add(makeChunk(4, 0, 2)));
    TEST_ASSERT_EQUAL(3, batch.size());
}

void test_batch_round_trips_through_packet() {
    SensorHotfire::ChunkBatch batch(9);
    for (uint32_t t = 1; t <= 9; ++t)
        TEST_ASSERT_TRUE(batch.add(makeChunk(t, 5, 3)));

    uint8_t buf[512];
    size_t n = batch.buildPacket(1234, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);

    daq::PacketHeader hdr;
    std::vector<daq::SensorDataChunkCollection> out;
    TEST_ASSERT_TRUE(daq::parse_sensor_data_packet(buf, n, hdr, out));
    TEST_ASSERT_EQUAL(9, out.size());
    TEST_ASSERT_EQUAL(9, out[8].timestamp);
    TEST_ASSERT_EQUAL(3, out[8].datapoints.size());
    TEST_ASSERT_EQUAL(902, out[8].datapoints[2].data);
}

void test_batch_config_change_forces_short_packet() {
    SensorHotfire::ChunkBatch batch(9);
    TEST_ASSERT_TRUE(batch.add(makeChunk(1, 1, 3)));
    TEST_ASSERT_TRUE(batch.add(makeChunk(2, 1, 3)));

    // New config, same channel count: still must not join.
    SensorHotfire::Chunk next = makeChunk(3, 2, 3);
    TEST_ASSERT_TRUE(batch.mustSendBefore(next));
    TEST_ASSERT_FALSE(batch.add(next));

    uint8_t buf[512];
    size_t n = batch.buildPacket(10, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);
    daq::PacketHeader hdr;
    std::vector<daq::SensorDataChunkCollection> out;
    TEST_ASSERT_TRUE(daq::parse_sensor_data_packet(buf, n, hdr, out));
    TEST_ASSERT_EQUAL(2, out.size());

    batch.clear();
    TEST_ASSERT_TRUE(batch.add(next));
    TEST_ASSERT_EQUAL(1, batch.size());
}

void test_batch_channel_count_change_forces_send() {
    SensorHotfire::ChunkBatch batch(9);
    TEST_ASSERT_TRUE(batch.add(makeChunk(1, 1, 3)));
    TEST_ASSERT_TRUE(batch.mustSendBefore(makeChunk(2, 1, 2)));
}

void test_batch_empty_builds_nothing() {
    SensorHotfire::ChunkBatch batch(9);
    uint8_t buf[512];
    TEST_ASSERT_EQUAL(0, batch.buildPacket(0, buf, sizeof(buf)));
    TEST_ASSERT_FALSE(batch.mustSendBefore(makeChunk(1, 0, 1)));
}

// ===========================================================================
// Drop-oldest queue rule
// ===========================================================================

struct FakeQueue {
    size_t capacity;
    std::deque<int> items;
    bool trySend(const int& v) {
        if (items.size() >= capacity)
            return false;
        items.push_back(v);
        return true;
    }
    bool tryReceive(int& v) {
        if (items.empty())
            return false;
        v = items.front();
        items.pop_front();
        return true;
    }
};

void test_push_drop_oldest_keeps_newest() {
    FakeQueue q{3, {}};
    TEST_ASSERT_FALSE(SensorHotfire::pushDropOldest(q, 1));
    TEST_ASSERT_FALSE(SensorHotfire::pushDropOldest(q, 2));
    TEST_ASSERT_FALSE(SensorHotfire::pushDropOldest(q, 3));
    TEST_ASSERT_TRUE(SensorHotfire::pushDropOldest(q, 4));
    TEST_ASSERT_TRUE(SensorHotfire::pushDropOldest(q, 5));
    TEST_ASSERT_EQUAL(3, q.items.size());
    TEST_ASSERT_EQUAL(3, q.items[0]);
    TEST_ASSERT_EQUAL(4, q.items[1]);
    TEST_ASSERT_EQUAL(5, q.items[2]);
}

// ===========================================================================
// Data-ready timeouts (rate codes are the ADS126X_RATE_* values)
// ===========================================================================

void test_conversion_periods() {
    TEST_ASSERT_EQUAL(400000, SensorHotfire::conversionPeriodUs(0b0000));
    TEST_ASSERT_EQUAL(50000, SensorHotfire::conversionPeriodUs(0b0100));
    TEST_ASSERT_EQUAL(2500, SensorHotfire::conversionPeriodUs(0b1000));
    TEST_ASSERT_EQUAL(27, SensorHotfire::conversionPeriodUs(0b1111));
}

void test_drdy_timeout_20sps() {
    // TC / RTD: FIR @ 20 SPS, one conversion per read.
    TEST_ASSERT_EQUAL(150000, SensorHotfire::drdyTimeoutUs(0b0100));
    // LC: SINC4 @ 20 SPS after a mux change, 4 settling + 1 real.
    TEST_ASSERT_EQUAL(750000, SensorHotfire::drdyTimeoutUs(0b0100, 5));
}

void test_drdy_timeout_floor_at_high_rate() {
    // PT: SINC5 @ 38400 SPS; 3 periods is ~81 us, so the floor applies.
    TEST_ASSERT_EQUAL(SensorHotfire::DRDY_TIMEOUT_FLOOR_US,
                      SensorHotfire::drdyTimeoutUs(0b1111));
    TEST_ASSERT_EQUAL(SensorHotfire::DRDY_TIMEOUT_FLOOR_US,
                      SensorHotfire::drdyTimeoutUs(0b1111, 0));
}

// ===========================================================================
// Unity runner
// ===========================================================================

void setUp() {
}
void tearDown() {
}

int main(int argc, char** argv) {
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

    // Config parsing edge cases
    RUN_TEST(test_sensor_bad_config_leaves_stored_config_untouched);
    RUN_TEST(test_sensor_no_conn_abort_packet);
    RUN_TEST(test_sensor_selftest_ignores_packets);
    RUN_TEST(test_sensor_same_sensor_list);

    // Chunk batching
    RUN_TEST(test_batch_fills_to_capacity);
    RUN_TEST(test_batch_round_trips_through_packet);
    RUN_TEST(test_batch_config_change_forces_short_packet);
    RUN_TEST(test_batch_channel_count_change_forces_send);
    RUN_TEST(test_batch_empty_builds_nothing);

    // Drop-oldest
    RUN_TEST(test_push_drop_oldest_keeps_newest);

    // Data-ready timeouts
    RUN_TEST(test_conversion_periods);
    RUN_TEST(test_drdy_timeout_20sps);
    RUN_TEST(test_drdy_timeout_floor_at_high_rate);

    return UNITY_END();
}
