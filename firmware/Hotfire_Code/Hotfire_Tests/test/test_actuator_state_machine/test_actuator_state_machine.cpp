/**
 * Actuator state machine unit tests
 *
 * Tests the actuator applyPacketTransition() and getBoardStateForHeartbeat() 
 * functions. Because these are static in Actuator_Hotfire/main.cpp with tightly
 * coupled globals, we extract the pure logic here for testing.
 */
#include <unity.h>
#include <cstring>
#include <vector>
#include <set>

// DAQv2-Comms
#include "DiabloEnums.h"
#include "DiabloPackets.h"
#include "DiabloPacketUtils.h"
#include "DiabloPacketUtils.cpp"

// ---------------------------------------------------------------------------
// Replicate the actuator state machine enums and transition logic
// (extracted from Actuator_Hotfire/src/main.cpp for testability)
// ---------------------------------------------------------------------------

enum class ActuatorControllerState : uint8_t {
    WaitingForServer = 1,
    Active = 2,
    ConnectionLossDetected = 3,
    NoConnectionAbort = 4,
    NoConnAbortFollower = 5,
    PTAbort = 6,
    NoPTAbort = 7,
    AbortFinished = 8
};

enum class IncomingPacketKind {
    None,
    ServerHeartbeat,
    Config,
    Abort,
    AbortDone,
    ClearAbort,
    SensorData,
    NoConnAbort
};

// Replicate getBoardStateForHeartbeat() from Actuator_Hotfire/main.cpp
static Diablo::BoardState getBoardStateForHeartbeat(ActuatorControllerState state) {
    switch (state) {
        case ActuatorControllerState::WaitingForServer:
            return Diablo::BoardState::SETUP;
        case ActuatorControllerState::Active:
            return Diablo::BoardState::ACTIVE;
        case ActuatorControllerState::ConnectionLossDetected:
            return Diablo::BoardState::CONNECTION_LOSS_DETECTED;
        case ActuatorControllerState::NoConnectionAbort:
            return Diablo::BoardState::NO_CONNECTION_ABORT;
        case ActuatorControllerState::NoConnAbortFollower:
            return Diablo::BoardState::NO_CONN_ABORT_FOLLOWER;
        case ActuatorControllerState::PTAbort:
            return Diablo::BoardState::PT_ABORT;
        case ActuatorControllerState::NoPTAbort:
            return Diablo::BoardState::NO_PT_ABORT;
        case ActuatorControllerState::AbortFinished:
            return Diablo::BoardState::ABORT_FINISHED;
        default:
            return Diablo::BoardState::SETUP;
    }
}

// Replicate applyPacketTransition() from Actuator_Hotfire/main.cpp
// Takes state + is_abort_controller as explicit params instead of globals
static ActuatorControllerState applyPacketTransition(
    ActuatorControllerState state,
    IncomingPacketKind kind,
    bool is_abort_controller,
    bool enable_transitions)
{
    // Global Clear Abort recovery
    if (kind == IncomingPacketKind::ClearAbort) {
        if (state == ActuatorControllerState::AbortFinished) {
            return ActuatorControllerState::Active;
        }
    }

    switch (state) {
        case ActuatorControllerState::WaitingForServer:
            if (kind == IncomingPacketKind::Config) {
                return ActuatorControllerState::Active;
            }
            break;
        case ActuatorControllerState::Active:
            // Stay in Active: no transitions on Abort, AbortDone, or NoConnAbort (unless config allows).
            if (enable_transitions) {
                if (kind == IncomingPacketKind::Abort || kind == IncomingPacketKind::AbortDone) {
                    return ActuatorControllerState::AbortFinished;
                } else if (kind == IncomingPacketKind::NoConnAbort && !is_abort_controller) {
                    return ActuatorControllerState::NoConnAbortFollower;
                }
            }
            break;
        case ActuatorControllerState::ConnectionLossDetected:
            if (kind == IncomingPacketKind::ServerHeartbeat) {
                return ActuatorControllerState::Active;
            }
            break;
        default:
            break;
    }
    return state;
}

// ===========================================================================
// Packet-driven transition tests
// ===========================================================================

void test_actuator_waiting_config_goes_active() {
    auto result = applyPacketTransition(
        ActuatorControllerState::WaitingForServer,
        IncomingPacketKind::Config, false, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::Active, (int)result);
}

void test_actuator_waiting_heartbeat_stays() {
    auto result = applyPacketTransition(
        ActuatorControllerState::WaitingForServer,
        IncomingPacketKind::ServerHeartbeat, false, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::WaitingForServer, (int)result);
}

void test_actuator_connloss_heartbeat_goes_active() {
    auto result = applyPacketTransition(
        ActuatorControllerState::ConnectionLossDetected,
        IncomingPacketKind::ServerHeartbeat, true, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::Active, (int)result);
}

void test_actuator_abort_finished_clear_goes_active() {
    auto result = applyPacketTransition(
        ActuatorControllerState::AbortFinished,
        IncomingPacketKind::ClearAbort, true, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::Active, (int)result);
}

void test_actuator_active_abort_stays_active() {
    // With transitions disabled, Active -> Abort returns Active
    auto result = applyPacketTransition(
        ActuatorControllerState::Active,
        IncomingPacketKind::Abort, true, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::Active, (int)result);
}

void test_actuator_active_abort_goes_abort_finished() {
    // With transitions ENABLED, Active -> Abort goes to AbortFinished
    auto result = applyPacketTransition(
        ActuatorControllerState::Active,
        IncomingPacketKind::Abort, true, true);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::AbortFinished, (int)result);
}

void test_actuator_active_abort_done_stays_active() {
    auto result = applyPacketTransition(
        ActuatorControllerState::Active,
        IncomingPacketKind::AbortDone, false, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::Active, (int)result);
}

void test_actuator_active_abort_done_goes_abort_finished() {
    auto result = applyPacketTransition(
        ActuatorControllerState::Active,
        IncomingPacketKind::AbortDone, false, true);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::AbortFinished, (int)result);
}

void test_actuator_active_noconn_abort_stays_active() {
    // When disabled, NoConnAbort does not transition
    auto result = applyPacketTransition(
        ActuatorControllerState::Active,
        IncomingPacketKind::NoConnAbort, false, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::Active, (int)result);
}

void test_actuator_active_noconn_abort_goes_follower() {
    // When ENABLED, NoConnAbort (as a non-controller) goes to NoConnAbortFollower
    auto result = applyPacketTransition(
        ActuatorControllerState::Active,
        IncomingPacketKind::NoConnAbort, false, true);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::NoConnAbortFollower, (int)result);
}

void test_actuator_noconn_abort_state_clear_doesnt_transition() {
    // ClearAbort only transitions from AbortFinished, not NoConnectionAbort
    auto result = applyPacketTransition(
        ActuatorControllerState::NoConnectionAbort,
        IncomingPacketKind::ClearAbort, true, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::NoConnectionAbort, (int)result);
}

void test_actuator_pt_abort_clear_doesnt_transition() {
    auto result = applyPacketTransition(
        ActuatorControllerState::PTAbort,
        IncomingPacketKind::ClearAbort, true, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::PTAbort, (int)result);
}

void test_actuator_none_kind_stays() {
    auto result = applyPacketTransition(
        ActuatorControllerState::Active,
        IncomingPacketKind::None, false, false);
    TEST_ASSERT_EQUAL((int)ActuatorControllerState::Active, (int)result);
}

// ===========================================================================
// Heartbeat state encoding — verify state→BoardState mapping
// ===========================================================================

void test_actuator_heartbeat_state_mapping_table() {
    struct { ActuatorControllerState state; Diablo::BoardState expected; } mappings[] = {
        { ActuatorControllerState::WaitingForServer,     Diablo::BoardState::SETUP },
        { ActuatorControllerState::Active,               Diablo::BoardState::ACTIVE },
        { ActuatorControllerState::ConnectionLossDetected, Diablo::BoardState::CONNECTION_LOSS_DETECTED },
        { ActuatorControllerState::NoConnectionAbort,    Diablo::BoardState::NO_CONNECTION_ABORT },
        { ActuatorControllerState::NoConnAbortFollower,  Diablo::BoardState::NO_CONN_ABORT_FOLLOWER },
        { ActuatorControllerState::PTAbort,              Diablo::BoardState::PT_ABORT },
        { ActuatorControllerState::NoPTAbort,            Diablo::BoardState::NO_PT_ABORT },
        { ActuatorControllerState::AbortFinished,        Diablo::BoardState::ABORT_FINISHED },
    };

    for (auto& m : mappings) {
        Diablo::BoardState got = getBoardStateForHeartbeat(m.state);
        TEST_ASSERT_EQUAL_MESSAGE(
            (int)m.expected, (int)got,
            "State mapping mismatch in getBoardStateForHeartbeat");

        // Also verify: create heartbeat → parse → board_state roundtrips correctly
        Diablo::BoardHeartbeatPacket hb{};
        hb.board_id = 99;
        hb.engine_state = Diablo::EngineState::SAFE;
        hb.board_state = got;

        uint8_t buf[512];
        size_t n = Diablo::create_board_heartbeat_packet(hb, 12345u, buf, sizeof(buf));
        TEST_ASSERT_GREATER_THAN(0, n);

        Diablo::PacketHeader hdr_out;
        Diablo::BoardHeartbeatPacket hb_out;
        TEST_ASSERT_TRUE(Diablo::parse_board_heartbeat_packet(buf, n, hdr_out, hb_out));
        TEST_ASSERT_EQUAL((int)m.expected, (int)hb_out.board_state);
        TEST_ASSERT_EQUAL(99, hb_out.board_id);
    }
}

void test_actuator_heartbeat_board_id_preserved() {
    Diablo::BoardHeartbeatPacket hb{};
    hb.board_id = 127;
    hb.engine_state = Diablo::EngineState::FIRING;
    hb.board_state = getBoardStateForHeartbeat(ActuatorControllerState::PTAbort);

    uint8_t buf[512];
    size_t n = Diablo::create_board_heartbeat_packet(hb, 12346u, buf, sizeof(buf));

    Diablo::PacketHeader hdr_out;
    Diablo::BoardHeartbeatPacket hb_out;
    TEST_ASSERT_TRUE(Diablo::parse_board_heartbeat_packet(buf, n, hdr_out, hb_out));
    TEST_ASSERT_EQUAL(127, hb_out.board_id);
    TEST_ASSERT_EQUAL((int)Diablo::EngineState::FIRING, (int)hb_out.engine_state);
    TEST_ASSERT_EQUAL((int)Diablo::BoardState::PT_ABORT, (int)hb_out.board_state);
}

// ===========================================================================
// Unity runner
// ===========================================================================

void setUp() {}
void tearDown() {}

int main(int argc, char **argv) {
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

    // Heartbeat state encoding
    RUN_TEST(test_actuator_heartbeat_state_mapping_table);
    RUN_TEST(test_actuator_heartbeat_board_id_preserved);

    return UNITY_END();
}
