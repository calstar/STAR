#ifndef PRESSURE_STATE_MACHINE_HPP
#define PRESSURE_STATE_MACHINE_HPP

#include <atomic>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "../../daq_comms/include/comms/messages/control/ControlMessages.hpp"
#include "../../daq_comms/include/transport/NetworkSocket.hpp"
#include "config/BoardDiscovery.hpp"
#include "elodin/ElodinClient.hpp"

namespace fsw {
namespace control {

/**
 * @brief Pressure-based State Machine for Propulsion System
 *
 * Reads pressure data from Elodin and sends actuator commands based on state transitions.
 * Implements the propulsion system state machine with pressure-based transitions.
 */
class PressureStateMachine {
public:
    /**
     * @brief System states matching the state machine diagram
     */
    enum class SystemState {
        DEBUG_STATE,     // Debug mode
        IDLE,            // Idle state (central resting state)
        ARMED,           // System armed
        FUEL_FILL,       // Fuel fill state
        OX_FILL,         // Oxidizer fill state
        GN2_LOW_PRESS,   // GN2 low pressure pressurization
        GN2_VENT,        // GN2 vent state
        FUEL_PRESS,      // Fuel pressurization
        FUEL_VENT,       // Fuel vent state
        OX_PRESS,        // Oxidizer pressurization
        OX_VENT,         // Oxidizer vent state
        GN2_HIGH_PRESS,  // GN2 high pressure pressurization
        GN2_HIGH_VENT,   // GN2 high vent state
        VENT,            // General vent state (safety)
        CALIBRATE,       // Calibration state
        READY,           // Ready for fire
        FIRE,            // Fire state
        ABORT            // Abort state
    };

    /**
     * @brief Actuator identifiers matching config
     */
    enum class ActuatorID {
        LOX_MAIN = 0,      // ACTUATOR_LOX_MAIN (message_id 0x5060)
        FUEL_MAIN = 1,     // ACTUATOR_FUEL_MAIN (message_id 0x5061)
        LOX_VENT = 2,      // ACTUATOR_LOX_VENT (message_id 0x5062)
        FUEL_VENT = 3,     // ACTUATOR_FUEL_VENT (message_id 0x5063)
        LOX_PRESS = 4,     // ACTUATOR_LOX_PRESS (message_id 0x5064)
        FUEL_PRESS = 5,    // ACTUATOR_FUEL_PRESS (message_id 0x5065)
        PRESSURE_VENT = 6  // Pressure vent valve (GN2)
    };

    /**
     * @brief Command types for actuators
     */
    enum class CommandType : uint8_t { OPEN = 1, CLOSE = 2, PULSE = 3, SET_POSITION = 4 };

    /**
     * @brief Pressure sensor readings
     */
    struct PressureReadings {
        double gn2_pressure_psi = 0.0;   // GN2 pressure (from PT_HP or PT_LP)
        double fuel_pressure_psi = 0.0;  // Fuel pressure (from PT_FUP or PT_FDP)
        double ox_pressure_psi = 0.0;    // Oxidizer pressure (from PT_OUP or PT_ODP)
        std::chrono::steady_clock::time_point timestamp;
        bool valid = false;
    };

    /**
     * @brief Configuration for pressure thresholds
     */
    struct PressureThresholds {
        double gn2_low_target_psi = 2000.0;   // Target for GN2 low press
        double gn2_low_max_psi = 2500.0;      // Max before vent
        double gn2_high_target_psi = 4500.0;  // Target for GN2 high press
        double gn2_high_max_psi = 4600.0;     // Max before vent
        double fuel_target_psi = 1000.0;      // Target for fuel press
        double fuel_max_psi = 850.0;          // Max before vent (note: seems inverted in diagram)
        double fuel_min_psi = 750.0;          // Min before vent closes
        double ox_target_psi = 1000.0;        // Target for ox press
        double ox_max_psi = 1100.0;           // Max before vent
        double ox_min_psi = 950.0;            // Min before vent closes
    };

    PressureStateMachine();
    ~PressureStateMachine();

    /**
     * @brief Initialize the state machine
     * @param elodin_client Connected Elodin client for reading pressure data
     * @param board_discovery Board discovery instance for getting board IPs
     * @param thresholds Pressure thresholds configuration
     * @return true if initialization successful
     */
    bool initialize(std::shared_ptr<elodin::ElodinClient> elodin_client,
                    std::shared_ptr<config::BoardDiscovery> board_discovery,
                    const PressureThresholds& thresholds);

    /**
     * @brief Start the state machine
     */
    void start();

    /**
     * @brief Stop the state machine
     */
    void stop();

    /**
     * @brief Get current state
     */
    SystemState getCurrentState() const;

    /**
     * @brief Get current state name as string
     */
    std::string getCurrentStateName() const;

    /**
     * @brief Request transition to a specific state (manual override)
     */
    bool requestTransition(SystemState target_state);

    /**
     * @brief Request abort
     */
    void requestAbort();

    /**
     * @brief Get latest pressure readings
     */
    PressureReadings getLatestPressures() const;

private:
    /**
     * @brief Main state machine loop
     */
    void stateMachineLoop();

    /**
     * @brief Read pressure data from Elodin
     */
    void readPressureData();

    /**
     * @brief Check transition conditions based on current state and pressures
     */
    void checkTransitions();

    /**
     * @brief Execute state entry actions
     */
    void executeStateEntryActions(SystemState state);

    /**
     * @brief Execute state actions (while in state)
     */
    void executeStateActions(SystemState state);

    /**
     * @brief Send actuator command
     */
    void sendActuatorCommand(ActuatorID actuator, CommandType command, float value = 0.0f);

    /**
     * @brief Convert actuator ID to message ID from config
     */
    uint16_t actuatorToMessageID(ActuatorID actuator) const;

    /**
     * @brief Send actuator command via UDP to board
     */
    void sendActuatorCommandUDP(ActuatorID actuator, CommandType command, float value = 0.0f);

    /** @brief Register Elodin VTables for PSM actuator commands and state transitions. */
    void registerPSMVTables();

    /**
     * @brief Get board IP and port for actuator
     */
    std::pair<std::string, uint16_t> getActuatorBoardAddress(ActuatorID actuator) const;

    // State variables
    std::atomic<bool> running_;
    std::atomic<SystemState> current_state_;
    std::atomic<bool> abort_requested_;
    std::chrono::steady_clock::time_point state_entry_time_;

    // Elodin client for reading pressure data
    std::shared_ptr<elodin::ElodinClient> elodin_client_;

    // Board discovery for getting board IPs
    std::shared_ptr<config::BoardDiscovery> board_discovery_;

    // UDP socket for sending commands (reused, like DiabloAvionics GUI)
    std::unique_ptr<daq_comms::transport::UDPSocket> command_socket_;

    // Actuator board IP and port (from config or discovery)
    std::string actuator_board_ip_;
    uint16_t actuator_board_port_;

    // Pressure readings (thread-safe)
    mutable std::mutex pressure_mutex_;
    PressureReadings latest_pressures_;

    // Configuration
    PressureThresholds thresholds_;

    // Sensor message IDs — calibrated PT packets ([0x20, 0x10 + channel])
    // Calibration server writes these; they carry float32 PSI at payload offset 12.
    // Channel assignments match sensor_roles_pt_board in config.toml.
    uint16_t pt_hp_message_id_ = 0x2016;   // Calibrated PT CH6  = GN2 Regulated
    uint16_t pt_lp_message_id_ = 0x2011;   // Calibrated PT CH1  = Fuel Upstream (low-P reference)
    uint16_t pt_fup_message_id_ = 0x2011;  // Calibrated PT CH1  = Fuel Upstream
    uint16_t pt_fdp_message_id_ = 0x2013;  // Calibrated PT CH3  = Fuel Downstream
    uint16_t pt_oup_message_id_ = 0x2015;  // Calibrated PT CH5  = Ox Upstream
    uint16_t pt_odp_message_id_ = 0x2017;  // Calibrated PT CH7  = Ox Downstream

    // Actuator message IDs from config
    std::map<ActuatorID, uint16_t> actuator_message_ids_;

    // Threading
    std::thread state_machine_thread_;
    std::mutex state_mutex_;

    // Timing
    std::chrono::milliseconds state_machine_period_{100};  // 10 Hz state machine
    std::chrono::milliseconds pressure_read_period_{50};   // 20 Hz pressure reading
};

}  // namespace control
}  // namespace fsw

#endif  // PRESSURE_STATE_MACHINE_HPP
