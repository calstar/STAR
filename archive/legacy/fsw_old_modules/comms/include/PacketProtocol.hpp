#ifndef PACKET_PROTOCOL_HPP
#define PACKET_PROTOCOL_HPP

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

/**
 * @brief Jetson Sensor Data Packet Protocol
 *
 * Handles packet construction, deconstruction, and routing for sensor data
 * coming from Jetson over Ethernet. All sensor data (PTs, TCs, load cells,
 * IMU, GPS, etc.) comes in unified packets that need to be deconstructed
 * and routed to appropriate subsystems.
 */
class PacketProtocol {
public:
    // Packet structure constants
    static constexpr uint16_t PACKET_HEADER_SIZE = 16;
    static constexpr uint16_t MAX_PACKET_SIZE = 1024;
    static constexpr uint32_t MAGIC_NUMBER = 0xDEADBEEF;
    static constexpr uint16_t PROTOCOL_VERSION = 0x0001;

    // Sensor types from Jetson
    enum class SensorType : uint8_t {
        PRESSURE_TRANSDUCER = 0x01,
        THERMOCOUPLE = 0x02,
        RTD_TEMPERATURE = 0x03,
        LOAD_CELL = 0x04,
        IMU_ACCELEROMETER = 0x05,
        IMU_GYROSCOPE = 0x06,
        IMU_MAGNETOMETER = 0x07,
        GPS_POSITION = 0x08,
        GPS_VELOCITY = 0x09,
        BAROMETER = 0x0A,
        ENCODER = 0x0B,
        FLOW_METER = 0x0C,
        VALVE_POSITION = 0x0D,
        SYSTEM_STATUS = 0x0E,
        CALIBRATION_DATA = 0x0F
    };

    // Packet types
    enum class PacketType : uint8_t {
        SENSOR_DATA = 0x01,
        CONTROL_COMMAND = 0x02,
        STATUS_UPDATE = 0x03,
        CALIBRATION_REQUEST = 0x04,
        HEARTBEAT = 0x05,
        ERROR_REPORT = 0x06
    };

    // Packet priority levels
    enum class Priority : uint8_t {
        CRITICAL = 0x01,  // Safety-critical data
        HIGH = 0x02,      // Control commands
        NORMAL = 0x03,    // Regular sensor data
        LOW = 0x04        // Logging data
    };

    // Packet header structure
    struct PacketHeader {
        uint32_t magic_number;      // Magic number for validation
        uint16_t protocol_version;  // Protocol version
        uint8_t packet_type;        // PacketType
        uint8_t priority;           // Priority
        uint16_t payload_size;      // Size of payload in bytes
        uint16_t sensor_count;      // Number of sensors in packet
        uint32_t sequence_number;   // Sequence number for ordering
        uint64_t timestamp_ns;      // Timestamp in nanoseconds
        uint16_t checksum;          // CRC16 checksum
    };

    // Individual sensor data structure
    struct SensorData {
        uint8_t sensor_type;        // SensorType
        uint8_t sensor_id;          // Unique sensor ID
        uint16_t data_size;         // Size of sensor data
        std::vector<uint8_t> data;  // Raw sensor data
        uint64_t timestamp_ns;      // Sensor timestamp
        uint8_t quality;            // Data quality (0-255)
    };

    // Complete packet structure
    struct Packet {
        PacketHeader header;
        std::vector<SensorData> sensors;
        std::vector<uint8_t> raw_data;  // Raw packet data
        bool valid;                     // Packet validity
        std::chrono::steady_clock::time_point received_time;
    };

    // Packet statistics
    struct PacketStats {
        uint64_t total_packets_received;
        uint64_t total_packets_sent;
        uint64_t packets_dropped;
        uint64_t checksum_errors;
        uint64_t sequence_errors;
        uint64_t malformed_packets;
        std::map<SensorType, uint64_t> sensor_packet_counts;
        std::chrono::steady_clock::time_point last_reset;
    };

    PacketProtocol();
    ~PacketProtocol();

    // Main interface
    bool initialize(uint16_t listen_port = 2244);
    void run();
    void stop();

    // Packet construction (for sending to Jetson)
    std::vector<uint8_t> constructPacket(PacketType type, Priority priority,
                                         const std::vector<SensorData>& sensors);

    std::vector<uint8_t> constructControlPacket(uint8_t valve_id, double position,
                                                double rate_limit, bool emergency_close);

    std::vector<uint8_t> constructCalibrationRequest(SensorType sensor_type, uint8_t sensor_id,
                                                     const std::vector<double>& calibration_data);

    // Packet deconstruction (for receiving from Jetson)
    bool deconstructPacket(const std::vector<uint8_t>& raw_data, Packet& packet);
    bool validatePacket(const Packet& packet) const;

    // Packet routing and processing
    void registerSensorHandler(SensorType sensor_type,
                               std::function<void(const SensorData&)> handler);

    void processPacket(const Packet& packet);
    void routeSensorData(const SensorData& sensor_data);

    // Statistics and monitoring
    PacketStats getStatistics() const;
    void resetStatistics();
    double getPacketRate() const;
    double getDataRate() const;

    // Network interface
    bool startListening();
    bool stopListening();
    bool sendPacket(const std::vector<uint8_t>& packet_data, const std::string& destination_ip,
                    uint16_t port);

    // Error handling
    bool isHealthy() const;
    std::vector<std::string> getActiveErrors() const;
    void clearErrors();

private:
    void packetProcessingLoop();
    void networkLoop();
    void processIncomingData();
    void handleMalformedPacket(const std::vector<uint8_t>& data);

    // Packet construction helpers
    uint16_t calculateChecksum(const std::vector<uint8_t>& data) const;
    void addSensorToPacket(std::vector<uint8_t>& packet_data, const SensorData& sensor_data);

    // Packet deconstruction helpers
    bool parseHeader(const std::vector<uint8_t>& data, size_t& offset, PacketHeader& header) const;
    bool parseSensorData(const std::vector<uint8_t>& data, size_t& offset,
                         SensorData& sensor_data) const;

    // Network management
    bool initializeNetworkInterface();
    void handleNetworkError(const std::string& error);

    // Configuration
    uint16_t listen_port_;
    std::string jetson_ip_;
    uint16_t jetson_port_;

    // Network state
    std::atomic<bool> listening_;
    std::atomic<bool> healthy_;
    std::vector<std::string> active_errors_;

    // Packet processing
    std::map<SensorType, std::function<void(const SensorData&)>> sensor_handlers_;
    std::queue<Packet> incoming_packets_;
    std::queue<std::vector<uint8_t>> outgoing_packets_;

    // Statistics
    PacketStats stats_;
    std::atomic<uint32_t> sequence_expected_;

    // Threading
    std::atomic<bool> running_;
    std::thread packet_thread_;
    std::thread network_thread_;
    std::mutex packets_mutex_;
    std::mutex handlers_mutex_;
    std::mutex stats_mutex_;

    // Timing
    std::chrono::milliseconds packet_period_{5};   // 200 Hz packet processing
    std::chrono::milliseconds network_period_{1};  // 1000 Hz network processing
    std::chrono::steady_clock::time_point last_stats_update_;
};

/**
 * @brief Sensor Data Router
 *
 * Routes deconstructed sensor data to appropriate subsystems
 */
class SensorDataRouter {
public:
    struct RoutingConfig {
        bool route_to_control_system;
        bool route_to_navigation_system;
        bool route_to_calibration_system;
        bool route_to_state_machine;
        bool route_to_telemetry;
        bool enable_data_logging;
        std::map<PacketProtocol::SensorType, bool> sensor_routing_enabled;
    };

    SensorDataRouter();
    ~SensorDataRouter();

    bool initialize(const RoutingConfig& config);
    void routeSensorData(const PacketProtocol::SensorData& sensor_data);

    // Subsystem registration
    void registerControlSystem(std::function<void(const PacketProtocol::SensorData&)> handler);
    void registerNavigationSystem(std::function<void(const PacketProtocol::SensorData&)> handler);
    void registerCalibrationSystem(std::function<void(const PacketProtocol::SensorData&)> handler);
    void registerStateMachine(std::function<void(const PacketProtocol::SensorData&)> handler);
    void registerTelemetrySystem(std::function<void(const PacketProtocol::SensorData&)> handler);

    // Configuration
    RoutingConfig getConfig() const;
    bool updateConfig(const RoutingConfig& config);

private:
    void determineRouting(const PacketProtocol::SensorData& sensor_data);
    void logSensorData(const PacketProtocol::SensorData& sensor_data);

    RoutingConfig config_;

    // Subsystem handlers
    std::function<void(const PacketProtocol::SensorData&)> control_handler_;
    std::function<void(const PacketProtocol::SensorData&)> navigation_handler_;
    std::function<void(const PacketProtocol::SensorData&)> calibration_handler_;
    std::function<void(const PacketProtocol::SensorData&)> state_handler_;
    std::function<void(const PacketProtocol::SensorData&)> telemetry_handler_;

    std::mutex config_mutex_;
    std::mutex handlers_mutex_;
};

/**
 * @brief Control Command Packet Builder
 *
 * Constructs control command packets for sending to Jetson
 */
class ControlCommandBuilder {
public:
    struct ValveCommand {
        uint8_t valve_id;
        double position;    // 0.0 to 1.0
        double rate_limit;  // Position change rate
        bool emergency_close;
        uint32_t command_id;
        std::chrono::steady_clock::time_point timestamp;
    };

    struct EngineCommand {
        double thrust_demand;         // N
        double mixture_ratio_demand;  // O/F ratio
        bool ignition_request;
        bool abort_request;
        uint32_t command_id;
        std::chrono::steady_clock::time_point timestamp;
    };

    ControlCommandBuilder();
    ~ControlCommandBuilder();

    std::vector<uint8_t> buildValveCommandPacket(const ValveCommand& command);
    std::vector<uint8_t> buildEngineCommandPacket(const EngineCommand& command);
    std::vector<uint8_t> buildCalibrationRequestPacket(PacketProtocol::SensorType sensor_type,
                                                       uint8_t sensor_id,
                                                       const std::vector<double>& data);

    // Batch command building
    std::vector<uint8_t> buildBatchCommandPacket(const std::vector<ValveCommand>& valve_commands,
                                                 const EngineCommand& engine_command);

private:
    uint32_t next_command_id_;
    std::mutex command_id_mutex_;

    uint32_t getNextCommandId();
};

#endif  // PACKET_PROTOCOL_HPP
