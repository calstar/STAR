#ifndef DIABLO_GLOBALS_H
#define DIABLO_GLOBALS_H

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <mutex>

#include "../../utl/TCPSocket.hpp"
#include "../comms/include/StateMachineMessage.hpp"
#include "../comms/include/mfDiabloSensorMessages.hpp"
#include "../comms/include/mfNavigationMessage.hpp"

// Forward declarations (none needed)

// Elodin socket for writing telemetry to DB
extern std::mutex ELODIN_DB_LOCK;
extern std::unique_ptr<Socket> Sock;
extern std::string ROOT_FSW_DIR;

// ══════════════════════════════════════════════════════════════════════════════
// Message IDs (matches reference pattern)
// ══════════════════════════════════════════════════════════════════════════════

extern uint8_t PT_MSG_ID;
extern uint8_t TC_MSG_ID;
extern uint8_t RTD_MSG_ID;
extern uint8_t LC_MSG_ID;
extern uint8_t NAV_ID;
extern uint8_t CONTROL_ID;
extern uint8_t STATE_MACHINE_OUTPUT_ID;
extern uint8_t ENGINE_CONTROL_ID;
extern uint8_t VALVE_CONTROL_ID;

// ══════════════════════════════════════════════════════════════════════════════
// Sensor Messages - Mutex-protected global state
// ══════════════════════════════════════════════════════════════════════════════

// PT Messages (up to 8 sensors)
extern std::mutex PT_MESSAGE_0_LOCK;
extern std::mutex PT_MESSAGE_1_LOCK;
extern std::mutex PT_MESSAGE_2_LOCK;
extern std::mutex PT_MESSAGE_3_LOCK;
extern std::mutex PT_MESSAGE_4_LOCK;
extern std::mutex PT_MESSAGE_5_LOCK;
extern std::mutex PT_MESSAGE_6_LOCK;
extern std::mutex PT_MESSAGE_7_LOCK;

extern mfPTMessage pt_message_0;
extern mfPTMessage pt_message_1;
extern mfPTMessage pt_message_2;
extern mfPTMessage pt_message_3;
extern mfPTMessage pt_message_4;
extern mfPTMessage pt_message_5;
extern mfPTMessage pt_message_6;
extern mfPTMessage pt_message_7;

// TC Messages (up to 8 sensors)
extern std::mutex TC_MESSAGE_0_LOCK;
extern std::mutex TC_MESSAGE_1_LOCK;
extern std::mutex TC_MESSAGE_2_LOCK;
extern std::mutex TC_MESSAGE_3_LOCK;

extern mfTCMessage tc_message_0;
extern mfTCMessage tc_message_1;
extern mfTCMessage tc_message_2;
extern mfTCMessage tc_message_3;

// RTD Messages (up to 8 sensors)
extern std::mutex RTD_MESSAGE_0_LOCK;
extern std::mutex RTD_MESSAGE_1_LOCK;
extern std::mutex RTD_MESSAGE_2_LOCK;
extern std::mutex RTD_MESSAGE_3_LOCK;

extern mfRTDMessage rtd_message_0;
extern mfRTDMessage rtd_message_1;
extern mfRTDMessage rtd_message_2;
extern mfRTDMessage rtd_message_3;

// Load Cell Messages (up to 4 sensors)
extern std::mutex LC_MESSAGE_0_LOCK;
extern std::mutex LC_MESSAGE_1_LOCK;
extern std::mutex LC_MESSAGE_2_LOCK;
extern std::mutex LC_MESSAGE_3_LOCK;

extern mfLCMessage lc_message_0;
extern mfLCMessage lc_message_1;
extern mfLCMessage lc_message_2;
extern mfLCMessage lc_message_3;

// ══════════════════════════════════════════════════════════════════════════════
// Navigation Message - Global navigation state
// ══════════════════════════════════════════════════════════════════════════════

extern std::mutex NAVIGATION_MESSAGE_LOCK;
extern std::mutex NAVIGATION_CONDITION_LOCK;
extern std::condition_variable nav_cv;
extern mfNavigationMessage navigation_message;

// ══════════════════════════════════════════════════════════════════════════════
// State Machine Messages (StateMachineInput/Output defined in StateMachineMessage.hpp)
// ══════════════════════════════════════════════════════════════════════════════

// State machine input
extern std::condition_variable state_machine_input_cv;
extern std::mutex STATE_MACHINE_INPUT_LOCK;
extern StateMachineInput state_machine_input;

// State machine output
extern std::mutex STATE_MACHINE_OUTPUT_LOCK;
extern StateMachineOutput state_machine_output;

// ══════════════════════════════════════════════════════════════════════════════
// Control Messages
// ══════════════════════════════════════════════════════════════════════════════

extern std::mutex CONTROL_MESSAGE_LOCK;
// extern ControlMessage control_message;

// ══════════════════════════════════════════════════════════════════════════════
// Helper Functions - Get sensor message by ID
// ══════════════════════════════════════════════════════════════════════════════

// Helper to get PT message mutex by sensor ID
inline std::mutex* get_pt_message_lock(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &PT_MESSAGE_0_LOCK;
        case 1:
            return &PT_MESSAGE_1_LOCK;
        case 2:
            return &PT_MESSAGE_2_LOCK;
        case 3:
            return &PT_MESSAGE_3_LOCK;
        case 4:
            return &PT_MESSAGE_4_LOCK;
        case 5:
            return &PT_MESSAGE_5_LOCK;
        case 6:
            return &PT_MESSAGE_6_LOCK;
        case 7:
            return &PT_MESSAGE_7_LOCK;
        default:
            return nullptr;
    }
}

// Helper to get PT message by sensor ID
inline mfPTMessage* get_pt_message(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &pt_message_0;
        case 1:
            return &pt_message_1;
        case 2:
            return &pt_message_2;
        case 3:
            return &pt_message_3;
        case 4:
            return &pt_message_4;
        case 5:
            return &pt_message_5;
        case 6:
            return &pt_message_6;
        case 7:
            return &pt_message_7;
        default:
            return nullptr;
    }
}

// Helper to get TC message mutex by sensor ID
inline std::mutex* get_tc_message_lock(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &TC_MESSAGE_0_LOCK;
        case 1:
            return &TC_MESSAGE_1_LOCK;
        case 2:
            return &TC_MESSAGE_2_LOCK;
        case 3:
            return &TC_MESSAGE_3_LOCK;
        default:
            return nullptr;
    }
}

// Helper to get TC message by sensor ID
inline mfTCMessage* get_tc_message(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &tc_message_0;
        case 1:
            return &tc_message_1;
        case 2:
            return &tc_message_2;
        case 3:
            return &tc_message_3;
        default:
            return nullptr;
    }
}

// Helper to get RTD message mutex by sensor ID
inline std::mutex* get_rtd_message_lock(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &RTD_MESSAGE_0_LOCK;
        case 1:
            return &RTD_MESSAGE_1_LOCK;
        case 2:
            return &RTD_MESSAGE_2_LOCK;
        case 3:
            return &RTD_MESSAGE_3_LOCK;
        default:
            return nullptr;
    }
}

// Helper to get RTD message by sensor ID
inline mfRTDMessage* get_rtd_message(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &rtd_message_0;
        case 1:
            return &rtd_message_1;
        case 2:
            return &rtd_message_2;
        case 3:
            return &rtd_message_3;
        default:
            return nullptr;
    }
}

// Helper to get LC message mutex by sensor ID
inline std::mutex* get_lc_message_lock(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &LC_MESSAGE_0_LOCK;
        case 1:
            return &LC_MESSAGE_1_LOCK;
        case 2:
            return &LC_MESSAGE_2_LOCK;
        case 3:
            return &LC_MESSAGE_3_LOCK;
        default:
            return nullptr;
    }
}

// Helper to get LC message by sensor ID
inline mfLCMessage* get_lc_message(uint8_t sensor_id) {
    switch (sensor_id) {
        case 0:
            return &lc_message_0;
        case 1:
            return &lc_message_1;
        case 2:
            return &lc_message_2;
        case 3:
            return &lc_message_3;
        default:
            return nullptr;
    }
}

#endif  // DIABLO_GLOBALS_H
