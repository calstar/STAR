#ifndef COMMUNICATION_PROTOCOL_HPP
#define COMMUNICATION_PROTOCOL_HPP

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

/**
 * @brief Communication Protocol System
 *
 * Handles communication between engine controller and ground station,
 * telemetry streaming, and inter-system communication
 */
class CommunicationProtocol {
public:
    enum class MessageType {
        // Engine control messages
        ENGINE_COMMAND,
        VALVE_COMMAND,
        THRUST_COMMAND,
        ABORT_COMMAND,

        // Status and telemetry
        ENGINE_STATUS,
        SENSOR_DATA,
        SYSTEM_HEALTH,
        CALIBRATION_STATUS,

        // Configuration
        CONFIG_UPDATE,
        PARAMETER_SET,
        CALIBRATION_DATA,

        // Safety and monitoring
        SAFETY_ALERT,
        FAULT_REPORT,
        HEARTBEAT,

        // Data logging
        LOG_DATA,
        EVENT_LOG,
        PERFORMANCE_DATA
    };

    enum class Priority {
        CRITICAL,  // Emergency abort, safety alerts
        HIGH,      // Engine commands, fault reports
        NORMAL,    // Status updates, telemetry
        LOW        // Logging, non-critical data
    };

    enum class ProtocolType {
        UDP_TELEMETRY,  // High-frequency telemetry streaming
        TCP_CONTROL,    // Reliable command and control
        UDP_DISCOVERY,  // Service discovery and heartbeat
        SERIAL_DEBUG,   // Debug and maintenance interface
        CAN_BUS         // Hardware interface communication
    };

    struct Message {
        MessageType type;
        Priority priority;
        std::vector<uint8_t> payload;
        std::chrono::steady_clock::time_point timestamp;
        uint32_t sequence_number;
        bool requires_acknowledgment;
        std::string source_id;
        std::string destination_id;
    };

    struct CommunicationConfig {
        struct NetworkConfig {
            std::string ground_station_ip;
            uint16_t ground_station_port;
            std::string local_ip;
            uint16_t telemetry_port;
            uint16_t control_port;
            uint16_t discovery_port;
            uint32_t max_packet_size;
            uint32_t buffer_size;
        };

        struct TelemetryConfig {
            std::vector<MessageType> telemetry_types;
            std::chrono::milliseconds telemetry_rate;
            bool enable_compression;
            bool enable_encryption;
            double data_quality_threshold;
        };

        struct ReliabilityConfig {
            uint32_t max_retransmissions;
            std::chrono::milliseconds ack_timeout;
            std::chrono::milliseconds heartbeat_interval;
            bool enable_sequence_numbering;
            bool enable_checksum_validation;
        };

        NetworkConfig network;
        TelemetryConfig telemetry;
        ReliabilityConfig reliability;
    };

    CommunicationProtocol();
    ~CommunicationProtocol();

    // Main interface
    bool initialize(const CommunicationConfig& config);
    void run();
    void stop();

    // Message transmission
    bool sendMessage(const Message& message);
    bool sendMessageAsync(const Message& message);
    bool broadcastMessage(const Message& message, ProtocolType protocol);

    // Message reception
    void registerMessageHandler(MessageType type, std::function<void(const Message&)> handler);
    void unregisterMessageHandler(MessageType type);

    // Telemetry streaming
    bool startTelemetryStream();
    bool stopTelemetryStream();
    bool addTelemetryData(const std::string& data_name, const std::vector<uint8_t>& data);
    bool removeTelemetryData(const std::string& data_name);

    // Connection management
    bool connectToGroundStation();
    bool disconnectFromGroundStation();
    bool isConnectedToGroundStation() const;
    std::vector<std::string> getConnectedClients() const;

    // Status and monitoring
    CommunicationConfig getConfig() const;
    bool updateConfig(const CommunicationConfig& config);
    std::map<MessageType, uint32_t> getMessageStatistics() const;
    double getConnectionQuality() const;

    // Heartbeat and discovery
    void sendHeartbeat();
    void discoverServices();
    std::vector<std::string> getDiscoveredServices() const;

private:
    void communicationLoop();
    void telemetryLoop();
    void discoveryLoop();
    void processIncomingMessages();
    void processOutgoingMessages();
    void handleMessageAcknowledgment(const Message& message);
    void handleHeartbeat();

    // Protocol-specific handlers
    void handleUDPTelemetry();
    void handleTCPControl();
    void handleUDPDiscovery();
    void handleSerialDebug();
    void handleCANBus();

    // Message processing
    bool validateMessage(const Message& message) const;
    bool compressMessage(Message& message) const;
    bool encryptMessage(Message& message) const;
    bool decompressMessage(Message& message) const;
    bool decryptMessage(Message& message) const;

    // Network management
    bool initializeNetworkInterfaces();
    bool shutdownNetworkInterfaces();
    void handleNetworkError(const std::string& error);

    // Configuration
    CommunicationConfig config_;
    std::map<MessageType, std::function<void(const Message&)>> message_handlers_;

    // Network state
    std::atomic<bool> ground_station_connected_;
    std::atomic<bool> telemetry_streaming_;
    std::vector<std::string> connected_clients_;
    std::vector<std::string> discovered_services_;

    // Message queues
    std::queue<Message> outgoing_queue_;
    std::queue<Message> incoming_queue_;
    std::map<uint32_t, Message> pending_acknowledgments_;

    // Telemetry data
    std::map<std::string, std::vector<uint8_t>> telemetry_data_;
    std::vector<std::string> telemetry_data_order_;

    // Statistics
    std::map<MessageType, uint32_t> message_statistics_;
    std::atomic<uint32_t> total_messages_sent_;
    std::atomic<uint32_t> total_messages_received_;
    std::atomic<uint32_t> failed_messages_;

    // Threading
    std::atomic<bool> running_;
    std::thread communication_thread_;
    std::thread telemetry_thread_;
    std::thread discovery_thread_;
    std::mutex outgoing_mutex_;
    std::mutex incoming_mutex_;
    std::mutex telemetry_mutex_;
    std::mutex config_mutex_;

    // Timing
    std::chrono::milliseconds communication_period_{10};  // 100 Hz communication
    std::chrono::milliseconds telemetry_period_{50};      // 20 Hz telemetry
    std::chrono::milliseconds discovery_period_{1000};    // 1 Hz discovery
    std::chrono::steady_clock::time_point last_heartbeat_;
    std::chrono::steady_clock::time_point last_discovery_;
};

/**
 * @brief Telemetry Data Manager
 *
 * Manages high-frequency telemetry data streaming with compression and buffering
 */
class TelemetryManager {
public:
    struct TelemetryChannel {
        std::string name;
        std::string description;
        std::string data_type;                  // "double", "int32", "bool", etc.
        size_t data_size;                       // Size of data element in bytes
        std::chrono::milliseconds sample_rate;  // Sampling rate
        bool enable_compression;
        bool enable_buffering;
        size_t buffer_size;
        CommunicationProtocol::Priority priority;
    };

    TelemetryManager();
    ~TelemetryManager();

    bool initialize(const std::vector<TelemetryChannel>& channels);
    void run();
    void stop();

    // Data streaming
    bool addData(const std::string& channel_name, const std::vector<uint8_t>& data);
    bool addData(const std::string& channel_name, double value);
    bool addData(const std::string& channel_name, int32_t value);
    bool addData(const std::string& channel_name, bool value);

    // Channel management
    bool addChannel(const TelemetryChannel& channel);
    bool removeChannel(const std::string& channel_name);
    bool updateChannel(const TelemetryChannel& channel);

    // Configuration
    std::vector<TelemetryChannel> getChannels() const;
    TelemetryChannel getChannel(const std::string& channel_name) const;

    // Statistics
    std::map<std::string, uint64_t> getChannelStatistics() const;
    double getDataRate() const;
    double getCompressionRatio() const;

private:
    void telemetryLoop();
    void processChannel(const TelemetryChannel& channel);
    void compressAndSend(const std::string& channel_name, const std::vector<uint8_t>& data);

    std::vector<TelemetryChannel> channels_;
    std::map<std::string, std::queue<std::vector<uint8_t>>> channel_buffers_;
    std::map<std::string, uint64_t> channel_statistics_;

    std::atomic<bool> running_;
    std::thread telemetry_thread_;
    std::mutex channels_mutex_;
    std::mutex buffers_mutex_;

    std::chrono::milliseconds telemetry_period_{20};  // 50 Hz telemetry processing
};

/**
 * @brief Command and Control Interface
 *
 * Handles incoming commands from ground station with validation and execution
 */
class CommandInterface {
public:
    enum class CommandType {
        ENGINE_START,
        ENGINE_STOP,
        ENGINE_ABORT,
        SET_THRUST,
        SET_MIXTURE_RATIO,
        VALVE_CONTROL,
        CALIBRATION_START,
        CALIBRATION_STOP,
        CONFIG_UPDATE,
        SYSTEM_RESET
    };

    struct Command {
        CommandType type;
        std::map<std::string, std::string> parameters;
        std::chrono::steady_clock::time_point timestamp;
        std::string source;
        uint32_t command_id;
        bool requires_confirmation;
    };

    CommandInterface();
    ~CommandInterface();

    bool initialize();
    void run();
    void stop();

    // Command handling
    bool processCommand(const Command& command);
    void registerCommandHandler(CommandType type, std::function<bool(const Command&)> handler);
    void unregisterCommandHandler(CommandType type);

    // Command validation
    bool validateCommand(const Command& command) const;
    bool checkCommandPermissions(const Command& command, const std::string& source) const;

    // Command history
    std::vector<Command> getCommandHistory() const;
    std::vector<Command> getCommandHistory(CommandType type) const;

private:
    void commandLoop();
    void executeCommand(const Command& command);

    std::map<CommandType, std::function<bool(const Command&)>> command_handlers_;
    std::vector<Command> command_history_;

    std::atomic<bool> running_;
    std::thread command_thread_;
    std::mutex handlers_mutex_;
    std::mutex history_mutex_;

    std::chrono::milliseconds command_period_{100};  // 10 Hz command processing
};

#endif  // COMMUNICATION_PROTOCOL_HPP
