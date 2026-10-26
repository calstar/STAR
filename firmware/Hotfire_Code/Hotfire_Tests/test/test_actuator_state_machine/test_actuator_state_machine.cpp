/**
 * Actuator state machine unit tests
 *
 * Exercises ActuatorLogic.h, the hardware-free half of the actuator hotfire
 * board, directly: packet-driven transitions, which commands are accepted in
 * which state, heartbeat state encoding, and each abort path's timing and
 * the packets it sends. A recording Outputs stands in for the pins and UDP.
 */
#include <unity.h>

#include <cstring>
#include <vector>

// DAQv2-Comms
#include "ActuatorLogic.h"
#include "DiabloEnums.h"
#include "DiabloPacketUtils.cpp"
#include "DiabloPacketUtils.h"
#include "DiabloPackets.h"

using ActuatorHotfire::Controller;
using ActuatorHotfire::State;

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

constexpr uint32_t ip(uint8_t a, uint8_t b, uint8_t c, uint8_t d) {
    return (uint32_t)a << 24 | (uint32_t)b << 16 | (uint32_t)c << 8 | d;
}
constexpr uint32_t SERVER = ip(192, 168, 2, 20);
constexpr uint32_t SELF = ip(192, 168, 2, 50);
constexpr uint32_t OTHER_ACT = ip(192, 168, 2, 51);
constexpr uint32_t PT = ip(192, 168, 2, 21);

struct Sent {
    uint32_t ip;
    uint16_t port;
    uint8_t type;
    std::vector<uint8_t> bytes;
};

struct Recorder : ActuatorHotfire::Outputs {
    std::vector<std::pair<uint8_t, bool>> set;
    std::vector<daq::PWMActuatorCommand> pwm;
    std::vector<Sent> sent;
    int ignored = 0;
    void setActuator(uint8_t id, bool on) override {
        set.push_back({id, on});
    }
    void startPwm(const daq::PWMActuatorCommand& cmd) override {
        pwm.push_back(cmd);
    }
    void send(uint32_t to, uint16_t port, const uint8_t* data,
              size_t len) override {
        sent.push_back({to, port, data[0], std::vector<uint8_t>(data, data + len)});
    }
    void onCommandsIgnored(uint8_t, State) override {
        ignored++;
    }
    int countSent(uint32_t to, daq::PacketType type) const {
        int n = 0;
        for (const auto& s : sent)
            if (s.ip == to && s.type == static_cast<uint8_t>(type))
                n++;
        return n;
    }
    void clear() {
        set.clear();
        pwm.clear();
        sent.clear();
        ignored = 0;
    }
};

struct Rig {
    Recorder out;
    Controller ctl{out, 10};
    uint32_t now = 1000;

    explicit Rig(bool enable_all = false) {
        ctl.enable_all_transitions = enable_all;
        ctl.begin(now);
    }

    ActuatorHotfire::PacketResult feed(const std::vector<uint8_t>& pkt,
                                       uint32_t from = SERVER) {
        return ctl.onPacket(pkt.data(), pkt.size(), from, SERVER, SELF, now);
    }
    void tick() {
        ctl.tick(now, SELF, SERVER);
    }
    void advance(uint32_t ms) {
        now += ms;
        tick();
    }
};

static std::vector<uint8_t> headerOnly(daq::PacketType type) {
    uint8_t buf[16];
    size_t n = ActuatorHotfire::createHeaderOnlyPacket(type, 0, buf, sizeof(buf));
    return std::vector<uint8_t>(buf, buf + n);
}

static std::vector<uint8_t> heartbeat() {
    daq::PacketHeader hdr{};
    hdr.packet_type = daq::PacketType::SERVER_HEARTBEAT;
    daq::ServerHeartbeatPacket body{};
    body.engine_state = daq::EngineState::SAFE;
    std::vector<uint8_t> v(sizeof(hdr) + sizeof(body));
    memcpy(v.data(), &hdr, sizeof(hdr));
    memcpy(v.data() + sizeof(hdr), &body, sizeof(body));
    return v;
}

// Abort config: actuator 1 on this board (vent ON, abort OFF), actuator 2 on
// another board (vent OFF, abort ON), one PT with an abort threshold.
static std::vector<uint8_t> config(bool controller) {
    std::vector<daq::AbortActuatorLocation> acts = {{SELF, 1, 1, 0},
                                                    {OTHER_ACT, 2, 0, 1}};
    std::vector<daq::AbortPTLocation> pts = {{PT, 3, 5000}};
    uint8_t buf[512];
    size_t n = daq::create_actuator_config_packet(controller ? 1 : 0, acts, pts,
                                                  1, 0, buf, sizeof(buf));
    TEST_ASSERT_GREATER_THAN(0, n);
    return std::vector<uint8_t>(buf, buf + n);
}

static std::vector<uint8_t> ptReading(uint32_t value) {
    std::vector<daq::SensorDataChunkCollection> chunks;
    daq::SensorDataChunkCollection c(0, 1);
    c.add_datapoint(3, value);
    chunks.push_back(c);
    uint8_t buf[512];
    size_t n = daq::create_sensor_data_packet(chunks, 1, 0, buf, sizeof(buf));
    return std::vector<uint8_t>(buf, buf + n);
}

static std::vector<uint8_t> command(uint8_t id, uint8_t on) {
    std::vector<daq::ActuatorCommand> cmds = {{id, on}};
    uint8_t buf[64];
    size_t n = daq::create_actuator_command_packet(cmds, 0, buf, sizeof(buf));
    return std::vector<uint8_t>(buf, buf + n);
}

// Active, then the server goes quiet long enough to enter
// ConnectionLossDetected (needs enable_all_transitions).
static void driveToConnectionLoss(Rig& r, bool controller) {
    r.feed(config(controller));
    r.feed(heartbeat());
    r.advance(HEARTBEAT_TIMEOUT_MS + 1);
    TEST_ASSERT_EQUAL((int)State::ConnectionLossDetected, (int)r.ctl.state());
}

static void driveToNoConnectionAbort(Rig& r) {
    driveToConnectionLoss(r, true);
    r.advance(CONNECTION_LOSS_GRACE_MS);
    TEST_ASSERT_EQUAL((int)State::NoConnectionAbort, (int)r.ctl.state());
}

// ===========================================================================
// Packet-driven transitions
// ===========================================================================

void test_actuator_waiting_config_goes_active() {
    Rig r;
    r.feed(config(false));
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

void test_actuator_waiting_heartbeat_stays() {
    Rig r;
    r.feed(heartbeat());
    TEST_ASSERT_EQUAL((int)State::WaitingForServer, (int)r.ctl.state());
}

void test_actuator_connloss_heartbeat_goes_active() {
    Rig r(true);
    driveToConnectionLoss(r, true);
    r.feed(heartbeat());
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

void test_actuator_abort_finished_clear_goes_active() {
    Rig r(true);
    r.feed(config(true));
    r.feed(headerOnly(daq::PacketType::ABORT));
    TEST_ASSERT_EQUAL((int)State::AbortFinished, (int)r.ctl.state());
    r.feed(headerOnly(daq::PacketType::CLEAR_ABORT));
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

void test_actuator_active_abort_stays_active() {
    Rig r(false);
    r.feed(config(true));
    r.feed(headerOnly(daq::PacketType::ABORT));
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

void test_actuator_active_abort_goes_abort_finished() {
    Rig r(true);
    r.feed(config(true));
    r.feed(headerOnly(daq::PacketType::ABORT));
    TEST_ASSERT_EQUAL((int)State::AbortFinished, (int)r.ctl.state());
}

void test_actuator_active_abort_done_stays_active() {
    Rig r(false);
    r.feed(config(false));
    r.feed(headerOnly(daq::PacketType::ABORT_DONE));
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

void test_actuator_active_abort_done_goes_abort_finished() {
    Rig r(true);
    r.feed(config(false));
    r.feed(headerOnly(daq::PacketType::ABORT_DONE));
    TEST_ASSERT_EQUAL((int)State::AbortFinished, (int)r.ctl.state());
}

void test_actuator_active_noconn_abort_stays_active() {
    Rig r(false);
    r.feed(config(false));
    r.feed(headerOnly(daq::PacketType::NO_CONNECTION_ABORT));
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

void test_actuator_active_noconn_abort_goes_follower() {
    Rig r(true);
    r.feed(config(false));
    r.feed(headerOnly(daq::PacketType::NO_CONNECTION_ABORT));
    TEST_ASSERT_EQUAL((int)State::NoConnAbortFollower, (int)r.ctl.state());
}

void test_actuator_noconn_abort_state_clear_doesnt_transition() {
    Rig r(true);
    driveToNoConnectionAbort(r);
    r.feed(headerOnly(daq::PacketType::CLEAR_ABORT));
    TEST_ASSERT_EQUAL((int)State::NoConnectionAbort, (int)r.ctl.state());
}

void test_actuator_pt_abort_clear_doesnt_transition() {
    Rig r(true);
    driveToNoConnectionAbort(r);
    r.feed(ptReading(9000), PT);
    r.advance(NO_CONN_ABORT_PT_WAIT_MS);
    TEST_ASSERT_EQUAL((int)State::PTAbort, (int)r.ctl.state());
    r.feed(headerOnly(daq::PacketType::CLEAR_ABORT));
    TEST_ASSERT_EQUAL((int)State::PTAbort, (int)r.ctl.state());
}

void test_actuator_none_kind_stays() {
    Rig r;
    r.feed(config(false));
    uint8_t junk[2] = {0, 0};
    r.ctl.onPacket(junk, sizeof(junk), SERVER, SERVER, SELF, r.now);
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

void test_actuator_config_reports_log_mode() {
    Rig r;
    auto res = r.feed(config(false));
    TEST_ASSERT_EQUAL((int)ActuatorHotfire::PacketKind::Config, (int)res.kind);
    TEST_ASSERT_TRUE(res.has_log_mode);
    TEST_ASSERT_EQUAL(1, res.log_mode);
    TEST_ASSERT_FALSE(r.ctl.isAbortController());
}

// ===========================================================================
// Command acceptance
// ===========================================================================

void test_actuator_command_applied_when_active() {
    Rig r;
    r.feed(config(false));
    r.feed(command(4, 1));
    TEST_ASSERT_EQUAL(1, r.out.set.size());
    TEST_ASSERT_EQUAL(4, r.out.set[0].first);
    TEST_ASSERT_TRUE(r.out.set[0].second);
}

void test_actuator_command_ignored_before_config() {
    Rig r;
    r.feed(command(4, 1));
    TEST_ASSERT_EQUAL(0, r.out.set.size());
    TEST_ASSERT_EQUAL(1, r.out.ignored);
}

void test_actuator_command_out_of_range_id_dropped() {
    Rig r;
    r.feed(config(false));
    r.feed(command(0, 1));
    r.feed(command(11, 1));
    TEST_ASSERT_EQUAL(0, r.out.set.size());
}

void test_actuator_follower_ignores_server_takes_survivor() {
    Rig r(true);
    driveToConnectionLoss(r, false);
    r.advance(CONNECTION_LOSS_GRACE_MS);
    TEST_ASSERT_EQUAL((int)State::NoConnAbortFollower, (int)r.ctl.state());
    r.out.clear();
    r.feed(command(4, 1), SERVER);
    TEST_ASSERT_EQUAL(0, r.out.set.size());
    r.feed(command(4, 1), OTHER_ACT);
    TEST_ASSERT_EQUAL(1, r.out.set.size());
}

// ===========================================================================
// Abort paths: timing and packets
// ===========================================================================

void test_no_connection_abort_resends_and_vents() {
    Rig r(true);
    driveToConnectionLoss(r, true);
    r.out.clear();
    r.advance(CONNECTION_LOSS_GRACE_MS);  // enter NoConnectionAbort
    r.tick();                             // first pass in the new state
    TEST_ASSERT_EQUAL(1, r.out.countSent(PT, daq::PacketType::NO_CONNECTION_ABORT));
    // Vent: local actuator 1 ON, actuator 2 OFF by command to its board.
    TEST_ASSERT_EQUAL(1, r.out.set.size());
    TEST_ASSERT_EQUAL(1, r.out.set[0].first);
    TEST_ASSERT_TRUE(r.out.set[0].second);
    TEST_ASSERT_EQUAL(1, r.out.countSent(OTHER_ACT,
                                         daq::PacketType::ACTUATOR_COMMAND));

    r.advance(ActuatorHotfire::NO_CONN_ABORT_RESEND_MS - 1);
    TEST_ASSERT_EQUAL(1, r.out.countSent(PT, daq::PacketType::NO_CONNECTION_ABORT));
    r.advance(1);
    TEST_ASSERT_EQUAL(2, r.out.countSent(PT, daq::PacketType::NO_CONNECTION_ABORT));
    r.advance(ActuatorHotfire::NO_CONN_ABORT_RESEND_MS);
    TEST_ASSERT_EQUAL(3, r.out.countSent(PT, daq::PacketType::NO_CONNECTION_ABORT));
    r.advance(100);
    TEST_ASSERT_EQUAL(3, r.out.countSent(PT, daq::PacketType::NO_CONNECTION_ABORT));
    // Vent is sent once, not every tick.
    TEST_ASSERT_EQUAL(1, r.out.set.size());
}

void test_no_pt_abort_path_timing() {
    Rig r(true);
    driveToNoConnectionAbort(r);
    r.advance(NO_CONN_ABORT_PT_WAIT_MS);  // no PT data heard
    TEST_ASSERT_EQUAL((int)State::NoPTAbort, (int)r.ctl.state());
    r.out.clear();

    r.tick();  // vent on entry
    TEST_ASSERT_EQUAL(1, r.out.set.size());
    TEST_ASSERT_TRUE(r.out.set[0].second);

    r.advance(NO_PT_ABORT_VENT_TO_ABORT_MS - 1);
    TEST_ASSERT_EQUAL((int)State::NoPTAbort, (int)r.ctl.state());
    r.advance(1);
    TEST_ASSERT_EQUAL((int)State::AbortFinished, (int)r.ctl.state());
    // Abort: local actuator 1 OFF.
    TEST_ASSERT_EQUAL(2, r.out.set.size());
    TEST_ASSERT_EQUAL(1, r.out.set[1].first);
    TEST_ASSERT_FALSE(r.out.set[1].second);
    TEST_ASSERT_EQUAL(1, r.out.countSent(PT, daq::PacketType::ABORT_DONE));
    TEST_ASSERT_EQUAL(1, r.out.countSent(OTHER_ACT, daq::PacketType::ABORT_DONE));
    TEST_ASSERT_EQUAL(0, r.out.countSent(SELF, daq::PacketType::ABORT_DONE));
}

void test_pt_abort_ends_when_pressure_below_threshold() {
    Rig r(true);
    driveToNoConnectionAbort(r);
    r.feed(ptReading(9000), PT);  // PT heard, above threshold
    r.advance(NO_CONN_ABORT_PT_WAIT_MS);
    TEST_ASSERT_EQUAL((int)State::PTAbort, (int)r.ctl.state());
    r.tick();
    TEST_ASSERT_EQUAL((int)State::PTAbort, (int)r.ctl.state());

    r.feed(ptReading(4000), PT);  // below the 5000 threshold
    r.advance(1);
    TEST_ASSERT_EQUAL((int)State::AbortFinished, (int)r.ctl.state());
    TEST_ASSERT_EQUAL(1, r.out.countSent(PT, daq::PacketType::ABORT_DONE));
}

void test_pt_abort_times_out_without_pressure_drop() {
    Rig r(true);
    driveToNoConnectionAbort(r);
    r.feed(ptReading(9000), PT);
    r.advance(NO_CONN_ABORT_PT_WAIT_MS);
    TEST_ASSERT_EQUAL((int)State::PTAbort, (int)r.ctl.state());
    r.advance(PT_ABORT_THRESHOLD_TIMEOUT_MS - 1);
    TEST_ASSERT_EQUAL((int)State::PTAbort, (int)r.ctl.state());
    r.advance(1);
    TEST_ASSERT_EQUAL((int)State::AbortFinished, (int)r.ctl.state());
}

void test_heartbeat_loss_ignored_unless_enabled() {
    Rig r(false);
    r.feed(config(true));
    r.feed(heartbeat());
    r.advance(HEARTBEAT_TIMEOUT_MS * 10);
    TEST_ASSERT_EQUAL((int)State::Active, (int)r.ctl.state());
}

// ===========================================================================
// Heartbeat state encoding — verify state→BoardState mapping
// ===========================================================================

void test_actuator_heartbeat_state_mapping_table() {
    struct {
        State state;
        daq::BoardState expected;
    } mappings[] = {
        {State::WaitingForServer, daq::BoardState::SETUP},
        {State::Active, daq::BoardState::ACTIVE},
        {State::ConnectionLossDetected,
         daq::BoardState::CONNECTION_LOSS_DETECTED},
        {State::NoConnectionAbort, daq::BoardState::NO_CONNECTION_ABORT},
        {State::NoConnAbortFollower, daq::BoardState::NO_CONN_ABORT_FOLLOWER},
        {State::PTAbort, daq::BoardState::PT_ABORT},
        {State::NoPTAbort, daq::BoardState::NO_PT_ABORT},
        {State::AbortFinished, daq::BoardState::ABORT_FINISHED},
    };

    for (auto& m : mappings) {
        daq::BoardState got = ActuatorHotfire::boardStateFor(m.state);
        TEST_ASSERT_EQUAL_MESSAGE((int)m.expected, (int)got,
                                  "State mapping mismatch in boardStateFor");

        // Also verify: create heartbeat → parse → board_state roundtrips
        // correctly
        daq::BoardHeartbeatPacket hb{};
        hb.board_id = 99;
        hb.engine_state = daq::EngineState::SAFE;
        hb.board_state = got;

        uint8_t buf[512];
        size_t n =
            daq::create_board_heartbeat_packet(hb, 12345u, buf, sizeof(buf));
        TEST_ASSERT_GREATER_THAN(0, n);

        daq::PacketHeader hdr_out;
        daq::BoardHeartbeatPacket hb_out;
        TEST_ASSERT_TRUE(
            daq::parse_board_heartbeat_packet(buf, n, hdr_out, hb_out));
        TEST_ASSERT_EQUAL((int)m.expected, (int)hb_out.board_state);
        TEST_ASSERT_EQUAL(99, hb_out.board_id);
    }
}

void test_actuator_heartbeat_board_id_preserved() {
    daq::BoardHeartbeatPacket hb{};
    hb.board_id = 127;
    hb.engine_state = daq::EngineState::FIRING;
    hb.board_state = ActuatorHotfire::boardStateFor(State::PTAbort);

    uint8_t buf[512];
    size_t n = daq::create_board_heartbeat_packet(hb, 12346u, buf, sizeof(buf));

    daq::PacketHeader hdr_out;
    daq::BoardHeartbeatPacket hb_out;
    TEST_ASSERT_TRUE(
        daq::parse_board_heartbeat_packet(buf, n, hdr_out, hb_out));
    TEST_ASSERT_EQUAL(127, hb_out.board_id);
    TEST_ASSERT_EQUAL((int)daq::EngineState::FIRING, (int)hb_out.engine_state);
    TEST_ASSERT_EQUAL((int)daq::BoardState::PT_ABORT, (int)hb_out.board_state);
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
    RUN_TEST(test_actuator_waiting_config_goes_active);
    RUN_TEST(test_actuator_waiting_heartbeat_stays);
    RUN_TEST(test_actuator_connloss_heartbeat_goes_active);
    RUN_TEST(test_actuator_abort_finished_clear_goes_active);
    RUN_TEST(test_actuator_active_abort_stays_active);
    RUN_TEST(test_actuator_active_abort_goes_abort_finished);
    RUN_TEST(test_actuator_active_abort_done_stays_active);
    RUN_TEST(test_actuator_active_abort_done_goes_abort_finished);
    RUN_TEST(test_actuator_active_noconn_abort_stays_active);
    RUN_TEST(test_actuator_active_noconn_abort_goes_follower);
    RUN_TEST(test_actuator_noconn_abort_state_clear_doesnt_transition);
    RUN_TEST(test_actuator_pt_abort_clear_doesnt_transition);
    RUN_TEST(test_actuator_none_kind_stays);
    RUN_TEST(test_actuator_config_reports_log_mode);

    // Command acceptance
    RUN_TEST(test_actuator_command_applied_when_active);
    RUN_TEST(test_actuator_command_ignored_before_config);
    RUN_TEST(test_actuator_command_out_of_range_id_dropped);
    RUN_TEST(test_actuator_follower_ignores_server_takes_survivor);

    // Abort paths
    RUN_TEST(test_no_connection_abort_resends_and_vents);
    RUN_TEST(test_no_pt_abort_path_timing);
    RUN_TEST(test_pt_abort_ends_when_pressure_below_threshold);
    RUN_TEST(test_pt_abort_times_out_without_pressure_drop);
    RUN_TEST(test_heartbeat_loss_ignored_unless_enabled);

    // Heartbeat state encoding
    RUN_TEST(test_actuator_heartbeat_state_mapping_table);
    RUN_TEST(test_actuator_heartbeat_board_id_preserved);

    return UNITY_END();
}
