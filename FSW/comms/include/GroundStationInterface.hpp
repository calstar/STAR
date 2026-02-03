/**
 * @file GroundStationInterface.hpp
 * @brief Interface for bidirectional communication with Ground Station GUI
 * 
 * Handles:
 * - Receiving commands from ground station (actuation, state transitions)
 * - Sending telemetry to ground station (sensor data, status, health)
 */

#ifndef GROUND_STATION_INTERFACE_HPP
#define GROUND_STATION_INTERFACE_HPP

#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>
#include <netinet/in.h>
#include <sys/socket.h>

#include "CommunicationProtocol.hpp"
#include "TCPSocket.hpp"

/**
 * @brief Ground Station Communication Interface
 * 
 * Provides bidirectional TCP communication with ground station:
 * - Command port: Receives commands from ground station
 * - Telemetry port: Sends real-time telemetry to ground station
 */
class GroundStationInterface {
public:
    enum class MessageType {
        // Commands (from ground station)
        ENGINE_COMMAND = 0,
        VALVE_COMMAND = 1,
        THRUST_COMMAND = 2,
        ABORT_COMMAND = 3,
        STATE_TRANSITION = 4,
        CONFIG_UPDATE = 5,
        PARAMETER_SET = 6,
        CALIBRATION_DATA = 7,
        
        // Telemetry (to ground station)
        ENGINE_STATUS = 100,
        SENSOR_DATA = 101,
        SYSTEM_HEALTH = 102,
        CALIBRATION_STATUS = 103,
        NAVIGATION_STATE = 104,
        HEARTBEAT = 105,
        SAFETY_ALERT = 106,
        FAULT_REPORT = 107
    };
    
    enum class CommandType {
        ENGINE_START = 0,
        ENGINE_STOP = 1,
        ENGINE_ABORT = 2,
        SET_THRUST = 3,
        SET_MIXTURE_RATIO = 4,
        VALVE_CONTROL = 5,
        CALIBRATION_START = 6,
        CALIBRATION_STOP = 7,
        CONFIG_UPDATE = 8,
        SYSTEM_RESET = 9
    };
    
    enum class Priority {
        CRITICAL = 0,
        HIGH = 1,
        NORMAL = 2,
        LOW = 3
    };
    
    struct Command {
        CommandType command_type;
        std::map<std::string, double> parameters;
        double timestamp;
        uint32_t command_id;
        bool requires_confirmation;
        std::string source;
    };
    
    struct TelemetryPacket {
        MessageType message_type;
        Priority priority;
        std::map<std::string, double> data;
        double timestamp;
        uint32_t sequence_number;
    };
    
    struct Config {
        std::string listen_address = "0.0.0.0";
        uint16_t command_port = 2241;
        uint16_t telemetry_port = 2242;
        int max_clients = 5;
        size_t telemetry_buffer_size = 1000;
        std::chrono::milliseconds heartbeat_interval{1000};
        std::chrono::milliseconds command_timeout{5000};
        bool enable_command_validation = true;
    };
    
    GroundStationInterface(const Config& config);
    ~GroundStationInterface();
    
    // Lifecycle
    bool initialize();
    bool start();
    void stop();
    
    // Command handling
    void registerCommandHandler(CommandType type, std::function<bool(const Command&)> handler);
    void unregisterCommandHandler(CommandType type);
    
    // Telemetry sending
    bool sendTelemetry(const TelemetryPacket& telemetry);
    bool sendSensorData(const std::map<std::string, double>& sensor_data);
    bool sendEngineStatus(const std::map<std::string, double>& status);
    bool sendSystemHealth(const std::map<std::string, double>& health);
    bool sendHeartbeat();
    bool sendSafetyAlert(const std::string& alert_message, Priority priority = Priority::CRITICAL);
    
    // Status
    bool isConnected() const { return clients_connected_ > 0; }
    int getConnectedClients() const { return clients_connected_; }
    uint32_t getCommandsReceived() const { return commands_received_; }
    uint32_t getTelemetrySent() const { return telemetry_sent_; }
    
    // Statistics
    struct Statistics {
        uint32_t commands_received;
        uint32_t commands_executed;
        uint32_t commands_failed;
        uint32_t telemetry_sent;
        uint32_t telemetry_failed;
        uint32_t clients_connected;
        uint32_t total_connections;
        std::chrono::steady_clock::time_point last_command_time;
        std::chrono::steady_clock::time_point last_telemetry_time;
    };
    
    Statistics getStatistics() const;

private:
    // Configuration
    Config config_;
    
    // Network sockets
    int command_server_socket_;
    int telemetry_server_socket_;
    std::vector<int> client_sockets_;
    std::mutex client_sockets_mutex_;
    
    // Threading
    std::atomic<bool> running_;
    std::thread command_listen_thread_;
    std::thread command_process_thread_;
    std::thread telemetry_send_thread_;
    std::thread heartbeat_thread_;
    
    // Command handling
    std::map<CommandType, std::function<bool(const Command&)>> command_handlers_;
    std::queue<Command> incoming_commands_;
    std::mutex commands_mutex_;
    std::condition_variable commands_cv_;
    
    // Telemetry handling
    std::queue<TelemetryPacket> outgoing_telemetry_;
    std::mutex telemetry_mutex_;
    std::condition_variable telemetry_cv_;
    
    // Statistics
    std::atomic<uint32_t> commands_received_;
    std::atomic<uint32_t> commands_executed_;
    std::atomic<uint32_t> commands_failed_;
    std::atomic<uint32_t> telemetry_sent_;
    std::atomic<uint32_t> telemetry_failed_;
    std::atomic<int> clients_connected_;
    std::atomic<uint32_t> total_connections_;
    std::atomic<uint32_t> sequence_number_;
    
    // Timing
    std::chrono::steady_clock::time_point last_command_time_;
    std::chrono::steady_clock::time_point last_telemetry_time_;
    std::mutex timing_mutex_;
    
    // Thread functions
    void commandListenLoop();
    void commandProcessLoop();
    void telemetrySendLoop();
    void heartbeatLoop();
    
    // Socket management
    bool createServerSocket(int& socket_fd, uint16_t port);
    void acceptClients(int server_socket);
    void removeDisconnectedClients();
    bool sendToAllClients(const std::vector<uint8_t>& data);
    
    // Packet serialization
    std::vector<uint8_t> serializeTelemetry(const TelemetryPacket& telemetry);
    Command deserializeCommand(const std::vector<uint8_t>& data);
    
    // Command validation
    bool validateCommand(const Command& command) const;
    void executeCommand(const Command& command);
    
    // Logging
    void logCommand(const Command& command);
    void logTelemetry(const TelemetryPacket& telemetry);
};

/**
 * @brief Helper class to integrate ground station with existing FSW components
 */
class FSWGroundStationBridge {
public:
    FSWGroundStationBridge(std::shared_ptr<GroundStationInterface> gs_interface);
    ~FSWGroundStationBridge();
    
    // Setup handlers for FSW components
    void setupStateMachineHandlers(/* StateMachine* state_machine */);
    void setupEngineControlHandlers(/* EngineController* engine_controller */);
    void setupValveControlHandlers(/* ValveController* valve_controller */);
    
    // Telemetry update functions (called by FSW components)
    void updateSensorTelemetry(const std::map<std::string, double>& sensor_data);
    void updateEngineStatus(const std::map<std::string, double>& status);
    void updateSystemHealth(const std::map<std::string, double>& health);
    
    // Start/stop telemetry streaming
    void startTelemetryStreaming(std::chrono::milliseconds interval = std::chrono::milliseconds(100));
    void stopTelemetryStreaming();

private:
    std::shared_ptr<GroundStationInterface> gs_interface_;
    
    // Telemetry streaming
    std::atomic<bool> streaming_active_;
    std::thread streaming_thread_;
    std::chrono::milliseconds streaming_interval_;
    
    // Latest telemetry data
    std::map<std::string, double> latest_sensor_data_;
    std::map<std::string, double> latest_engine_status_;
    std::map<std::string, double> latest_system_health_;
    mutable std::mutex data_mutex_;
    
    // Thread functions
    void telemetryStreamingLoop();
};

#endif // GROUND_STATION_INTERFACE_HPP

