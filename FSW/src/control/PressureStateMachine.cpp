#include "control/PressureStateMachine.hpp"

#include "DiabloPacketUtils.h"
#include "DiabloPackets.h"
#include "fsw/BoardTypeWire.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <thread>

#include "comms/messages/control/ControlMessages.hpp"
#include "comms/messages/control/ControllerMessages.hpp"
#include "db.hpp"

using namespace vtable;
using namespace vtable::builder;

namespace fsw {
namespace control {

PressureStateMachine::PressureStateMachine()
    : running_(false),
      current_state_(SystemState::IDLE),
      abort_requested_(false),
      state_entry_time_(std::chrono::steady_clock::now()) {
    // Initialize actuator message IDs from config
    actuator_message_ids_[ActuatorID::LOX_MAIN] = 0x5060;
    actuator_message_ids_[ActuatorID::FUEL_MAIN] = 0x5061;
    actuator_message_ids_[ActuatorID::LOX_VENT] = 0x5062;
    actuator_message_ids_[ActuatorID::FUEL_VENT] = 0x5063;
    actuator_message_ids_[ActuatorID::LOX_PRESS] = 0x5064;
    actuator_message_ids_[ActuatorID::FUEL_PRESS] = 0x5065;
    actuator_message_ids_[ActuatorID::PRESSURE_VENT] = 0x5066;  // Not in config, but needed
}

PressureStateMachine::~PressureStateMachine() {
    stop();
}

bool PressureStateMachine::initialize(std::shared_ptr<elodin::ElodinClient> elodin_client,
                                      std::shared_ptr<config::BoardDiscovery> board_discovery,
                                      const PressureThresholds& thresholds) {
    if (!elodin_client || !elodin_client->is_connected()) {
        std::cerr << "[PressureStateMachine] ERROR: Elodin client not connected" << std::endl;
        return false;
    }

    elodin_client_ = elodin_client;
    board_discovery_ = board_discovery;
    thresholds_ = thresholds;
    current_state_ = SystemState::IDLE;
    abort_requested_ = false;

    // Get actuator board IP/port (from discovery or config fallback)
    auto [board_ip, board_port] = getActuatorBoardAddress(ActuatorID::LOX_MAIN);
    actuator_board_ip_ = board_ip;
    actuator_board_port_ = board_port;

    // Create UDP socket for sending commands (reused, like DiabloAvionics GUI)
    command_socket_ = std::make_unique<daq_comms::transport::UDPSocket>(actuator_board_ip_,
                                                                        actuator_board_port_, true);
    if (!command_socket_->is_valid()) {
        std::cerr << "[PressureStateMachine] WARNING: Failed to create UDP socket for "
                  << actuator_board_ip_ << ":" << actuator_board_port_ << " - "
                  << command_socket_->last_error() << std::endl;
        std::cerr << "[PressureStateMachine] Commands will fail until socket is valid" << std::endl;
    }

    std::cout << "[PressureStateMachine] ✅ Initialized" << std::endl;
    std::cout << "[PressureStateMachine]   Actuator Board: " << actuator_board_ip_ << ":"
              << actuator_board_port_ << std::endl;
    std::cout << "[PressureStateMachine]   GN2 Low Target: " << thresholds_.gn2_low_target_psi
              << " PSI" << std::endl;
    std::cout << "[PressureStateMachine]   GN2 High Target: " << thresholds_.gn2_high_target_psi
              << " PSI" << std::endl;
    std::cout << "[PressureStateMachine]   Fuel Target: " << thresholds_.fuel_target_psi << " PSI"
              << std::endl;
    std::cout << "[PressureStateMachine]   OX Target: " << thresholds_.ox_target_psi << " PSI"
              << std::endl;

    // Register VTables with Elodin DB so PSM actuator command packets (0x5060-0x5066)
    // and state transition packets (0x43) are accepted and stored.
    registerPSMVTables();

    return true;
}

void PressureStateMachine::start() {
    if (running_.load()) {
        std::cerr << "[PressureStateMachine] WARNING: Already running" << std::endl;
        return;
    }

    running_ = true;
    state_machine_thread_ = std::thread(&PressureStateMachine::stateMachineLoop, this);
    std::cout << "[PressureStateMachine] ✅ Started state machine" << std::endl;
}

void PressureStateMachine::stop() {
    if (!running_.load()) {
        return;
    }

    running_ = false;
    if (state_machine_thread_.joinable()) {
        state_machine_thread_.join();
    }
    std::cout << "[PressureStateMachine] ✅ Stopped state machine" << std::endl;
}

PressureStateMachine::SystemState PressureStateMachine::getCurrentState() const {
    return current_state_.load();
}

std::string PressureStateMachine::getCurrentStateName() const {
    switch (current_state_.load()) {
        case SystemState::DEBUG_STATE:
            return "DEBUG_STATE";
        case SystemState::IDLE:
            return "IDLE";
        case SystemState::ARMED:
            return "ARMED";
        case SystemState::FUEL_FILL:
            return "FUEL_FILL";
        case SystemState::OX_FILL:
            return "OX_FILL";
        case SystemState::GN2_LOW_PRESS:
            return "GN2_LOW_PRESS";
        case SystemState::GN2_VENT:
            return "GN2_VENT";
        case SystemState::FUEL_PRESS:
            return "FUEL_PRESS";
        case SystemState::FUEL_VENT:
            return "FUEL_VENT";
        case SystemState::OX_PRESS:
            return "OX_PRESS";
        case SystemState::OX_VENT:
            return "OX_VENT";
        case SystemState::GN2_HIGH_PRESS:
            return "GN2_HIGH_PRESS";
        case SystemState::GN2_HIGH_VENT:
            return "GN2_HIGH_VENT";
        case SystemState::VENT:
            return "VENT";
        case SystemState::CALIBRATE:
            return "CALIBRATE";
        case SystemState::READY:
            return "READY";
        case SystemState::FIRE:
            return "FIRE";
        case SystemState::ABORT:
            return "ABORT";
    }
    return "UNKNOWN";
}

bool PressureStateMachine::requestTransition(SystemState target_state) {
    std::lock_guard<std::mutex> lock(state_mutex_);
    SystemState current = current_state_.load();

    // Validate transition
    bool valid = false;
    switch (current) {
        case SystemState::IDLE:
            valid =
                (target_state == SystemState::DEBUG_STATE || target_state == SystemState::ARMED);
            break;
        case SystemState::DEBUG_STATE:
            valid = (target_state == SystemState::IDLE);
            break;
        case SystemState::ARMED:
            valid = (target_state == SystemState::FUEL_FILL || target_state == SystemState::IDLE);
            break;
        // Add more valid transitions as needed
        default:
            // Allow transitions to IDLE or ABORT from any state
            valid = (target_state == SystemState::IDLE || target_state == SystemState::ABORT);
            break;
    }

    if (valid) {
        current_state_ = target_state;
        state_entry_time_ = std::chrono::steady_clock::now();
        executeStateEntryActions(target_state);
        std::cout << "[PressureStateMachine] ✅ Transitioned: " << getCurrentStateName() << " -> "
                  << getCurrentStateName() << std::endl;
        return true;
    }

    std::cerr << "[PressureStateMachine] ❌ Invalid transition: " << getCurrentStateName() << " -> "
              << static_cast<int>(target_state) << std::endl;
    return false;
}

void PressureStateMachine::requestAbort() {
    abort_requested_ = true;
    std::lock_guard<std::mutex> lock(state_mutex_);
    current_state_ = SystemState::ABORT;
    state_entry_time_ = std::chrono::steady_clock::now();
    executeStateEntryActions(SystemState::ABORT);
    std::cout << "[PressureStateMachine] 🚨 ABORT REQUESTED" << std::endl;
}

PressureStateMachine::PressureReadings PressureStateMachine::getLatestPressures() const {
    std::lock_guard<std::mutex> lock(pressure_mutex_);
    return latest_pressures_;
}

void PressureStateMachine::stateMachineLoop() {
    auto last_pressure_read = std::chrono::steady_clock::now();

    while (running_.load()) {
        auto now = std::chrono::steady_clock::now();

        // Read pressure data periodically
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_pressure_read)
                .count() >= pressure_read_period_.count()) {
            readPressureData();
            last_pressure_read = now;
        }

        // Check transitions and execute state actions
        checkTransitions();
        executeStateActions(current_state_.load());

        // Sleep until next cycle
        std::this_thread::sleep_for(state_machine_period_);
    }
}

void PressureStateMachine::readPressureData() {
    if (!elodin_client_ || !elodin_client_->is_connected()) {
        return;
    }

    // Read incoming packets from Elodin (non-blocking)
    // Elodin sends data packets back over the TCP connection
    // Packet format: [len(4)][type(1)][packet_id(2)][request_id(1)][padding(4)][payload...]

    constexpr size_t MAX_PACKET_SIZE = 4096;
    uint8_t packet_buffer[MAX_PACKET_SIZE];

    // Try to read a packet (non-blocking)
    ssize_t packet_len = elodin_client_->read_packet(packet_buffer, MAX_PACKET_SIZE);
    if (packet_len <= 0) {
        return;  // No data available or error
    }

    // Parse packet header
    uint32_t len = *reinterpret_cast<uint32_t*>(packet_buffer);
    uint8_t type = packet_buffer[4];
    uint16_t packet_id = (static_cast<uint16_t>(packet_buffer[5]) << 8) | packet_buffer[6];

    // Check if this is a data packet (type 1 = TABLE)
    if (type != 1) {
        return;  // Not a data packet
    }

    // Extract payload (skip 12-byte header)
    const uint8_t* payload = packet_buffer + 12;
    size_t payload_len = len - 12;

    // Parse pressure sensor messages based on packet_id
    // Match packet_id to sensor message IDs
    std::lock_guard<std::mutex> lock(pressure_mutex_);

    // Parse calibrated PT packets: [timestamp(8), channelId(1), padding(3), pressurePsi(float32,4),
    // ...] Minimum payload size = 16 bytes to read the pressurePsi field.
    constexpr size_t CAL_PT_MIN_LEN = 16;

    if (packet_id == pt_hp_message_id_ || packet_id == pt_lp_message_id_) {
        if (payload_len >= CAL_PT_MIN_LEN) {
            float psi_f;
            std::memcpy(&psi_f, payload + 12, sizeof(float));
            latest_pressures_.gn2_pressure_psi = static_cast<double>(psi_f);
            latest_pressures_.timestamp = std::chrono::steady_clock::now();
            latest_pressures_.valid = true;
        }
    } else if (packet_id == pt_fup_message_id_ || packet_id == pt_fdp_message_id_) {
        if (payload_len >= CAL_PT_MIN_LEN) {
            float psi_f;
            std::memcpy(&psi_f, payload + 12, sizeof(float));
            latest_pressures_.fuel_pressure_psi = static_cast<double>(psi_f);
            latest_pressures_.timestamp = std::chrono::steady_clock::now();
            latest_pressures_.valid = true;
        }
    } else if (packet_id == pt_oup_message_id_ || packet_id == pt_odp_message_id_) {
        if (payload_len >= CAL_PT_MIN_LEN) {
            float psi_f;
            std::memcpy(&psi_f, payload + 12, sizeof(float));
            latest_pressures_.ox_pressure_psi = static_cast<double>(psi_f);
            latest_pressures_.timestamp = std::chrono::steady_clock::now();
            latest_pressures_.valid = true;
        }
    }
}

void PressureStateMachine::checkTransitions() {
    std::lock_guard<std::mutex> lock(state_mutex_);
    SystemState current = current_state_.load();

    // Get latest pressure readings (need to unlock state_mutex_ first to avoid deadlock)
    PressureReadings pressures;
    {
        std::lock_guard<std::mutex> pressure_lock(pressure_mutex_);
        pressures = latest_pressures_;
    }

    if (!pressures.valid) {
        return;  // No valid pressure data yet
    }

    // Check abort condition
    if (abort_requested_.load()) {
        if (current != SystemState::ABORT) {
            current_state_ = SystemState::ABORT;
            state_entry_time_ = std::chrono::steady_clock::now();
            executeStateEntryActions(SystemState::ABORT);
        }
        return;
    }

    // State-specific transition checks based on diagram
    switch (current) {
        case SystemState::GN2_LOW_PRESS:
            if (pressures.gn2_pressure_psi > thresholds_.gn2_low_max_psi) {
                // Transition to GN2_VENT if pressure too high
                current_state_ = SystemState::GN2_VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::GN2_VENT);
            } else if (pressures.gn2_pressure_psi >= thresholds_.gn2_low_target_psi) {
                // Transition to FUEL_PRESS when target reached
                current_state_ = SystemState::FUEL_PRESS;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::FUEL_PRESS);
            }
            break;

        case SystemState::GN2_VENT:
            if (pressures.gn2_pressure_psi > 3000.0) {
                // Transition to VENT if pressure exceeds 3000 PSI
                current_state_ = SystemState::VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::VENT);
            } else if (pressures.gn2_pressure_psi < thresholds_.gn2_low_max_psi) {
                // Return to GN2_LOW_PRESS when pressure drops
                current_state_ = SystemState::GN2_LOW_PRESS;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::GN2_LOW_PRESS);
            }
            break;

        case SystemState::FUEL_PRESS:
            if (pressures.fuel_pressure_psi > thresholds_.fuel_max_psi) {
                // Transition to FUEL_VENT if pressure too high
                current_state_ = SystemState::FUEL_VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::FUEL_VENT);
            } else {
                // Transition to OX_PRESS when fuel pressurization complete
                // (In diagram, this happens after actions complete)
                // For now, we'll transition when pressure is near target
                if (std::abs(pressures.fuel_pressure_psi - thresholds_.fuel_target_psi) < 50.0) {
                    current_state_ = SystemState::OX_PRESS;
                    state_entry_time_ = std::chrono::steady_clock::now();
                    executeStateEntryActions(SystemState::OX_PRESS);
                }
            }
            break;

        case SystemState::FUEL_VENT:
            if (pressures.fuel_pressure_psi > 850.0) {
                // Transition to VENT if pressure exceeds 850 PSI
                current_state_ = SystemState::VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::VENT);
            } else if (pressures.fuel_pressure_psi < thresholds_.fuel_min_psi) {
                // Return to FUEL_PRESS when pressure drops
                current_state_ = SystemState::FUEL_PRESS;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::FUEL_PRESS);
            }
            break;

        case SystemState::OX_PRESS:
            if (pressures.ox_pressure_psi > thresholds_.ox_max_psi) {
                // Transition to OX_VENT if pressure too high
                current_state_ = SystemState::OX_VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::OX_VENT);
            } else {
                // Transition to GN2_HIGH_PRESS when ox pressurization complete
                if (std::abs(pressures.ox_pressure_psi - thresholds_.ox_target_psi) < 50.0) {
                    current_state_ = SystemState::GN2_HIGH_PRESS;
                    state_entry_time_ = std::chrono::steady_clock::now();
                    executeStateEntryActions(SystemState::GN2_HIGH_PRESS);
                }
            }
            break;

        case SystemState::OX_VENT:
            if (pressures.ox_pressure_psi > 1100.0) {
                // Transition to VENT if pressure exceeds 1100 PSI
                current_state_ = SystemState::VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::VENT);
            } else if (pressures.ox_pressure_psi < thresholds_.ox_min_psi) {
                // Return to OX_PRESS when pressure drops
                current_state_ = SystemState::OX_PRESS;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::OX_PRESS);
            }
            break;

        case SystemState::GN2_HIGH_PRESS:
            if (pressures.gn2_pressure_psi > thresholds_.gn2_high_max_psi) {
                // Transition to GN2_HIGH_VENT if pressure too high
                current_state_ = SystemState::GN2_HIGH_VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::GN2_HIGH_VENT);
            } else if (pressures.gn2_pressure_psi >= thresholds_.gn2_high_target_psi) {
                // Transition to CALIBRATE when target reached
                current_state_ = SystemState::CALIBRATE;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::CALIBRATE);
            }
            break;

        case SystemState::GN2_HIGH_VENT:
            if (pressures.gn2_pressure_psi > 4600.0) {
                // Transition to VENT if pressure exceeds 4600 PSI
                current_state_ = SystemState::VENT;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::VENT);
            } else if (pressures.gn2_pressure_psi < thresholds_.gn2_high_max_psi) {
                // Return to GN2_HIGH_PRESS when pressure drops
                current_state_ = SystemState::GN2_HIGH_PRESS;
                state_entry_time_ = std::chrono::steady_clock::now();
                executeStateEntryActions(SystemState::GN2_HIGH_PRESS);
            }
            break;

        default:
            break;
    }
}

void PressureStateMachine::executeStateEntryActions(SystemState state) {
    const SystemState from_state = current_state_.load();
    std::cout << "[PressureStateMachine] Entering state: " << getCurrentStateName() << std::endl;

    // Write state transition event to Elodin DB [0x43, 0x00]
    if (elodin_client_ && elodin_client_->is_connected()) {
        comms::messages::control::ControllerStateTransitionMessage st_msg;
        std::get<0>(st_msg.fields) = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                         std::chrono::system_clock::now().time_since_epoch())
                                         .count();
        std::get<1>(st_msg.fields) = static_cast<uint8_t>(from_state);
        std::get<2>(st_msg.fields) = static_cast<uint8_t>(state);
        std::get<3>(st_msg.fields) = (state == SystemState::ABORT) ? uint8_t(2)
                                     : abort_requested_.load()     ? uint8_t(2)
                                                                   : uint8_t(0);
        elodin_client_->publish(0x4300, st_msg);
    }

    switch (state) {
        case SystemState::ARMED: {
            // Actions: "mains Close", "all SOL close"
            sendActuatorCommand(ActuatorID::FUEL_MAIN, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_MAIN, CommandType::CLOSE);
            // Close all solenoids (vent and press valves)
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::FUEL_PRESS, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_PRESS, CommandType::CLOSE);
            break;
        }

        case SystemState::FUEL_FILL: {
            // Actions: "-FV OPEN", "-personnel fill tank, X L", "-personnel removes QD"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::OPEN);
            // Note: Personnel actions are manual, not automated
            break;
        }

        case SystemState::OX_FILL: {
            // Actions: "-SOL FV CLOSE", "-SOL OV OPEN", "-personnel fill tank", "-personnel
            // approves tank temp"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_VENT, CommandType::OPEN);
            // Note: Personnel actions are manual
            break;
        }

        case SystemState::GN2_LOW_PRESS: {
            // Actions: "-SOL FV PV CLOSE", "-press to 2000psi"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::PRESSURE_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::FUEL_PRESS, CommandType::OPEN);  // Start pressurization
            break;
        }

        case SystemState::GN2_VENT: {
            // Action: "open PV"
            sendActuatorCommand(ActuatorID::PRESSURE_VENT, CommandType::OPEN);
            break;
        }

        case SystemState::FUEL_PRESS: {
            // Actions: "-SOL FV PV CLOSE", "-OPEN SOL FUP", "-CLOSE OUP", "-press to 1000psi"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::PRESSURE_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::FUEL_PRESS, CommandType::OPEN);
            sendActuatorCommand(ActuatorID::LOX_PRESS, CommandType::CLOSE);
            break;
        }

        case SystemState::FUEL_VENT: {
            // Action: "open FV"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::OPEN);
            break;
        }

        case SystemState::OX_PRESS: {
            // Actions: "-SOL FV PV AND OV CLOSE", "-CLOSE FUP", "-OPEN SOL OUP", "-press to
            // 1000psi"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::PRESSURE_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::FUEL_PRESS, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_PRESS, CommandType::OPEN);
            break;
        }

        case SystemState::OX_VENT: {
            // Action: "open OV"
            sendActuatorCommand(ActuatorID::LOX_VENT, CommandType::OPEN);
            break;
        }

        case SystemState::GN2_HIGH_PRESS: {
            // Actions: "-SOL FV PV AND OV CLOSE", "-CLOSE OUP AND FUP", "-press to 4500psi"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::PRESSURE_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_VENT, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::LOX_PRESS, CommandType::CLOSE);
            sendActuatorCommand(ActuatorID::FUEL_PRESS, CommandType::CLOSE);
            // Continue pressurization to 4500 PSI
            break;
        }

        case SystemState::GN2_HIGH_VENT: {
            // Action: "open PV"
            sendActuatorCommand(ActuatorID::PRESSURE_VENT, CommandType::OPEN);
            break;
        }

        case SystemState::VENT: {
            // Actions: "open FV and OV", "open pressurant vent"
            sendActuatorCommand(ActuatorID::FUEL_VENT, CommandType::OPEN);
            sendActuatorCommand(ActuatorID::LOX_VENT, CommandType::OPEN);
            sendActuatorCommand(ActuatorID::PRESSURE_VENT, CommandType::OPEN);
            break;
        }

        case SystemState::READY: {
            // Actions: "-pressure reg starts"
            // This would start a pressure regulator (not an actuator command)
            std::cout << "[PressureStateMachine] Pressure regulator started" << std::endl;
            break;
        }

        case SystemState::FIRE: {
            // Actions: "-ignitor", "-main F and main O"
            sendActuatorCommand(ActuatorID::FUEL_MAIN, CommandType::OPEN);
            sendActuatorCommand(ActuatorID::LOX_MAIN, CommandType::OPEN);
            // Note: Ignitor would be a separate actuator
            break;
        }

        case SystemState::ABORT: {
            // Actions: "-stop pressure reg", "-fully open SOL FDP and BV ODP", "-open MAIN F and
            // MAIN O", "-open FUP and OUP"
            sendActuatorCommand(ActuatorID::FUEL_MAIN, CommandType::OPEN);
            sendActuatorCommand(ActuatorID::LOX_MAIN, CommandType::OPEN);
            sendActuatorCommand(ActuatorID::FUEL_PRESS, CommandType::OPEN);
            sendActuatorCommand(ActuatorID::LOX_PRESS, CommandType::OPEN);
            std::cout << "[PressureStateMachine] 🚨 ABORT: All valves opened for emergency venting"
                      << std::endl;
            break;
        }

        default:
            break;
    }
}

void PressureStateMachine::executeStateActions(SystemState state) {
    // Actions to perform while in state (monitoring, etc.)
    // Most states don't have continuous actions, but we could add monitoring here
}

void PressureStateMachine::sendActuatorCommand(ActuatorID actuator, CommandType command,
                                               float value) {
    // Send to Elodin (for logging/monitoring)
    if (elodin_client_ && elodin_client_->is_connected()) {
        uint16_t message_id = actuatorToMessageID(actuator);
        if (message_id != 0) {
            comms::messages::control::ActuatorCommandMessage cmd_msg;
            std::get<0>(cmd_msg.fields) = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                              std::chrono::steady_clock::now().time_since_epoch())
                                              .count();
            std::get<1>(cmd_msg.fields) = static_cast<uint8_t>(actuator);
            std::get<2>(cmd_msg.fields) = static_cast<uint8_t>(command);
            std::get<3>(cmd_msg.fields) = value;
            std::get<4>(cmd_msg.fields) = 1;  // Status: ACK

            elodin_client_->publish(message_id, cmd_msg);
        }
    }

    // Send via UDP to board (actual command)
    sendActuatorCommandUDP(actuator, command, value);
}

void PressureStateMachine::sendActuatorCommandUDP(ActuatorID actuator, CommandType command,
                                                  float value) {
    // Check if socket is valid (reused socket, like DiabloAvionics GUI)
    if (!command_socket_ || !command_socket_->is_valid()) {
        std::cerr << "[PressureStateMachine] ERROR: UDP socket not valid for actuator "
                  << static_cast<int>(actuator) << std::endl;
        return;
    }

    // Convert CommandType to actuator_state (0=OFF, 1=ON)
    // Matching DiabloAvionics GUI: actuator_state: 0 = OFF, non-zero = ON
    uint8_t actuator_state = 0;
    if (command == CommandType::OPEN || command == CommandType::PULSE) {
        actuator_state = 1;  // ON
    } else if (command == CommandType::CLOSE) {
        actuator_state = 0;  // OFF
    } else if (command == CommandType::SET_POSITION) {
        actuator_state = (value > 0.5f) ? 1 : 0;  // Threshold at 50%
    }

    // Map actuator ID to board channel (1-indexed, 1-10)
    // Matching DiabloAvionics GUI: actuator_id: 1-10 (1-indexed)
    // Actuator IDs map to channels: LOX_MAIN=1, FUEL_MAIN=2, LOX_VENT=3, etc.
    uint8_t actuator_channel =
        static_cast<uint8_t>(actuator) + 1;  // Convert 0-indexed to 1-indexed

    // Construct actuator command packet (matching DAQv2-Comms format exactly)
    Diablo::ActuatorCommand cmd;
    cmd.actuator_id = actuator_channel;
    cmd.actuator_state = actuator_state;

    std::vector<Diablo::ActuatorCommand> commands;
    commands.push_back(cmd);

    uint32_t ts_ms = static_cast<uint32_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count() &
        0xFFFFFFFF);
    uint8_t buf[512];
    size_t len = Diablo::create_actuator_command_packet(commands, ts_ms, buf, sizeof(buf));
    std::vector<uint8_t> packet(buf, buf + len);
    if (packet.empty()) {
        std::cerr << "[PressureStateMachine] ERROR: Failed to construct actuator command packet"
                  << std::endl;
        return;
    }

    // Send packet via UDP (reusing socket, like DiabloAvionics GUI)
    // Matching: self.command_sock.sendto(packet, (self.device_ip, self.device_port))
    ssize_t sent = command_socket_->send(packet.data(), packet.size());
    if (sent == static_cast<ssize_t>(packet.size())) {
        std::cout << "[PressureStateMachine] ✅ Sent UDP command to " << actuator_board_ip_ << ":"
                  << actuator_board_port_ << ": Actuator=" << static_cast<int>(actuator_channel)
                  << " -> " << (actuator_state ? "ON" : "OFF") << std::endl;
    } else {
        std::cerr << "[PressureStateMachine] ❌ Failed to send UDP command: sent " << sent << "/"
                  << packet.size() << " bytes" << " error: " << command_socket_->last_error()
                  << std::endl;
    }
}

std::pair<std::string, uint16_t> PressureStateMachine::getActuatorBoardAddress(
    ActuatorID actuator) const {
    // Map actuator to board_id from config
    // Actuators are on board_id 6 (from config_flight_daq.toml)
    constexpr uint16_t ACTUATOR_BOARD_PORT = 5005;  // Default UDP port for actuator commands

    // Get board IP from board discovery
    if (board_discovery_) {
        auto boards = board_discovery_->get_discovered_boards();
        for (const auto& board : boards) {
            // Match board_id - check if this board has actuator sensors
            // Board signature contains board_id, check if it matches ACTUATOR_BOARD_ID
            // For now, check if board has actuator sensors or is actuator type
            if (board.signature.board_type == fsw::daq_wire::kActuator) {
                return {board.current_ip, board.port > 0 ? board.port : ACTUATOR_BOARD_PORT};
            }
        }
    }

    // Fallback: Use default IP range for actuators
    // From config: actuators are on board_id 6, which maps to IP 192.168.2.206
    // (assuming IP assignment: 192.168.2.200 + board_id)
    return {"192.168.2.206", ACTUATOR_BOARD_PORT};
}

uint16_t PressureStateMachine::actuatorToMessageID(ActuatorID actuator) const {
    auto it = actuator_message_ids_.find(actuator);
    if (it != actuator_message_ids_.end()) {
        return it->second;
    }
    return 0;
}

void PressureStateMachine::registerPSMVTables() {
    if (!elodin_client_ || !elodin_client_->is_connected())
        return;

    // Local helper — mirrors ControllerService::send_msg but scoped to PSM
    auto send_vtable_msg = [this](VTableMsg msg) {
        auto buf = Msg(msg).encode_vec();
        if (!buf.empty())
            elodin_client_->send_msg({0, 0}, buf);
    };

    // Actuator command VTable: U64(8) + U8(1) + U8(1) + F32(4) + U8(1) = 15 bytes
    auto make_act_vt = []() {
        return builder::vtable({
            raw_field(0, 8, schema(PrimType::U64(), {}, component("PSM.actuator.timestamp_ns"))),
            raw_field(8, 1, schema(PrimType::U8(), {}, component("PSM.actuator.actuator_id"))),
            raw_field(9, 1, schema(PrimType::U8(), {}, component("PSM.actuator.command_type"))),
            raw_field(10, 4, schema(PrimType::F32(), {}, component("PSM.actuator.value"))),
            raw_field(14, 1, schema(PrimType::U8(), {}, component("PSM.actuator.status"))),
        });
    };

    for (uint8_t lo = 0x60; lo <= 0x66; ++lo) {
        send_vtable_msg(
            VTableMsg{.id = std::make_tuple(uint8_t(0x50), lo), .vtable = make_act_vt()});
    }

    // PSM state transition VTable [0x43, 0x00]: U64(8) + 3×U8 = 11 bytes
    auto state_trans_vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CONTROLLER.state.timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.from_state"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.to_state"))),
        raw_field(10, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.reason"))),
    });
    send_vtable_msg(
        VTableMsg{.id = std::make_tuple(uint8_t(0x43), uint8_t(0x00)), .vtable = state_trans_vt});

    std::cout << "[PressureStateMachine] ✅ Registered PSM VTables (0x5060-0x5066, 0x43)"
              << std::endl;
}

}  // namespace control
}  // namespace fsw
