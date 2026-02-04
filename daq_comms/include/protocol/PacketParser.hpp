#ifndef DAQ_PACKET_PARSER_HPP
#define DAQ_PACKET_PARSER_HPP

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "EncryptedFrame.hpp"
#include "comms/CommsMessage.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"

namespace daq_comms {
namespace protocol {

/**
 * @brief Unified Packet Parser for Sensor Data and Commands
 *
 * Inspired by DiabloAvionics packet protocol patterns, this parser handles:
 * - Incoming sensor data packets (from embedded systems)
 * - Outgoing command packets (to embedded systems)
 * - Packet validation and error handling
 * - Sequence tracking and loss detection
 * - Integration with CommsMessage serialization
 */
class PacketParser {
public:
    // Packet structure constants (matching DiabloAvionics FSW PacketProtocol exactly)
    static constexpr uint16_t PACKET_HEADER_SIZE = 26;  // Full header including checksum
    static constexpr uint16_t HEADER_DATA_SIZE = 24;    // Header data (before checksum)
    static constexpr uint16_t MAX_PACKET_SIZE = 1024;
    static constexpr uint32_t MAGIC_NUMBER = 0xDEADBEEF;
    static constexpr uint16_t PROTOCOL_VERSION = 0x0001;

    // Packet types
    enum class PacketType : uint8_t {
        SENSOR_DATA = 0x01,          // Sensor data from embedded systems
        CONTROL_COMMAND = 0x02,      // Control commands to embedded systems
        STATUS_UPDATE = 0x03,        // Status/health updates
        CALIBRATION_REQUEST = 0x04,  // Calibration data requests
        HEARTBEAT = 0x05,            // Heartbeat/keepalive
        ERROR_REPORT = 0x06,         // Error reporting
        ACK = 0x07                   // Acknowledgment
    };

    // Packet priority levels
    enum class Priority : uint8_t {
        CRITICAL = 0x01,  // Safety-critical data
        HIGH = 0x02,      // Control commands
        NORMAL = 0x03,    // Regular sensor data
        LOW = 0x04        // Logging data
    };

    // Sensor types (matching our sensor system)
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

    /**
     * @brief Packet header structure (matching DiabloAvionics FSW PacketProtocol exactly)
     *
     * Layout (26 bytes total):
     * - magic_number: 4 bytes (0xDEADBEEF)
     * - protocol_version: 2 bytes (0x0001)
     * - packet_type: 1 byte
     * - priority: 1 byte
     * - payload_size: 2 bytes
     * - sensor_count: 2 bytes
     * - sequence_number: 4 bytes
     * - timestamp_ns: 8 bytes
     * - checksum: 2 bytes (CRC16)
     */
    struct PacketHeader {
        uint32_t magic_number;      // Magic number for validation (0xDEADBEEF)
        uint16_t protocol_version;  // Protocol version (0x0001)
        uint8_t packet_type;        // PacketType enum value
        uint8_t priority;           // Priority enum value
        uint16_t payload_size;      // Size of payload in bytes
        uint16_t sensor_count;      // Number of sensors/items in packet
        uint32_t sequence_number;   // Sequence number for ordering
        uint64_t timestamp_ns;      // Timestamp in nanoseconds
        uint16_t checksum;          // CRC16 checksum (matches FSW)

        // Validation
        bool is_valid() const {
            return magic_number == MAGIC_NUMBER && protocol_version == PROTOCOL_VERSION &&
                   payload_size <= MAX_PACKET_SIZE;
        }
    };

    /**
     * @brief Parsed sensor data entry
     */
    struct SensorDataEntry {
        SensorType sensor_type;
        uint8_t sensor_id;              // Channel/sensor ID
        uint16_t data_size;             // Size of sensor data
        std::vector<uint8_t> raw_data;  // Raw sensor data bytes
        uint64_t timestamp_ns;          // Sensor timestamp
        uint8_t quality;                // Data quality (0-255)
    };

    /**
     * @brief Complete parsed packet
     */
    struct ParsedPacket {
        PacketHeader header;
        std::vector<SensorDataEntry> sensor_data;
        std::vector<uint8_t> raw_packet;  // Full raw packet data
        bool is_valid;
        std::chrono::steady_clock::time_point received_time;
        std::string error_message;
    };

    /**
     * @brief Packet statistics
     */
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

    PacketParser();
    ~PacketParser() = default;

    /**
     * @brief Parse incoming packet from raw bytes
     * @param data Raw packet bytes
     * @param size Number of bytes available
     * @return Parsed packet if successful, empty otherwise
     */
    std::optional<ParsedPacket> parse_packet(const uint8_t* data, size_t size);

    /**
     * @brief Parse packet from vector
     */
    std::optional<ParsedPacket> parse_packet(const std::vector<uint8_t>& data);

    /**
     * @brief Construct sensor data packet
     * @param sensor_data Vector of sensor data entries
     * @param priority Packet priority
     * @return Constructed packet bytes
     */
    std::vector<uint8_t> construct_sensor_packet(const std::vector<SensorDataEntry>& sensor_data,
                                                 Priority priority = Priority::NORMAL);

    /**
     * @brief Construct control command packet
     * @param command_type Command type identifier
     * @param command_data Command data bytes
     * @param priority Packet priority
     * @return Constructed packet bytes
     */
    std::vector<uint8_t> construct_command_packet(uint8_t command_type,
                                                  const std::vector<uint8_t>& command_data,
                                                  Priority priority = Priority::HIGH);

    /**
     * @brief Construct calibration request packet
     * @param sensor_type Sensor type to calibrate
     * @param sensor_id Sensor ID
     * @param calibration_data Calibration parameters
     * @return Constructed packet bytes
     */
    std::vector<uint8_t> construct_calibration_request(SensorType sensor_type, uint8_t sensor_id,
                                                       const std::vector<double>& calibration_data);

    /**
     * @brief Validate parsed packet (including checksum)
     */
    bool validate_packet(const ParsedPacket& packet) const;

    /**
     * @brief Enable/disable checksum validation
     */
    void set_checksum_validation(bool enabled) {
        checksum_validation_enabled_ = enabled;
    }

    /**
     * @brief Get statistics
     */
    PacketStats get_stats() const {
        return stats_;
    }

    /**
     * @brief Reset statistics
     */
    void reset_stats();

    /**
     * @brief Get next sequence number (for outgoing packets)
     */
    uint32_t get_next_sequence() {
        return next_sequence_++;
    }

    /**
     * @brief Check if parser is healthy
     */
    bool is_healthy() const {
        return healthy_;
    }

    /**
     * @brief Get active errors
     */
    std::vector<std::string> get_active_errors() const {
        return active_errors_;
    }

private:
    // Packet parsing helpers
    bool parse_header(const uint8_t* data, size_t size, size_t& offset, PacketHeader& header) const;
    bool parse_sensor_data(const uint8_t* data, size_t size, size_t& offset,
                           SensorDataEntry& entry) const;

    // Packet construction helpers
    void add_header_to_packet(std::vector<uint8_t>& packet, PacketType type, Priority priority,
                              uint16_t payload_size, uint16_t sensor_count);
    void add_sensor_entry_to_packet(std::vector<uint8_t>& packet,
                                    const SensorDataEntry& entry) const;

    // Validation helpers
    uint16_t calculate_checksum(const uint8_t* data, size_t size) const;
    bool validate_sequence(uint32_t sequence);

    // Error handling
    void handle_malformed_packet(const std::string& error);
    void clear_errors();

    // State
    std::atomic<bool> healthy_;
    std::atomic<bool> checksum_validation_enabled_;
    std::vector<std::string> active_errors_;
    std::atomic<uint32_t> next_sequence_;
    std::atomic<uint32_t> expected_sequence_;
    PacketStats stats_;
    std::mutex stats_mutex_;
};

/**
 * @brief Helper class to convert ParsedPacket to CommsMessage format
 *
 * This bridges the packet parser output to our CommsMessage system
 */
class PacketToCommsMessageConverter {
public:
    /**
     * @brief Convert sensor data entry to CommsMessage
     * @param entry Sensor data entry from parser
     * @param receive_timestamp_ns Receive timestamp
     * @return Pair of (packet_id, CommsMessage) or empty if conversion fails
     */
    template <typename MessageType>
    std::optional<std::pair<std::array<uint8_t, 2>, MessageType>> convert_sensor_entry(
        const PacketParser::SensorDataEntry& entry, uint64_t receive_timestamp_ns) const;

    /**
     * @brief Convert PT sensor entry to RawPTMessage
     */
    std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawPTMessage>>
    convert_pt_entry(const PacketParser::SensorDataEntry& entry,
                     uint64_t receive_timestamp_ns) const;

    /**
     * @brief Convert TC sensor entry to RawTCMessage
     */
    std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawTCMessage>>
    convert_tc_entry(const PacketParser::SensorDataEntry& entry,
                     uint64_t receive_timestamp_ns) const;

    /**
     * @brief Convert RTD sensor entry to RawRTDMessage
     */
    std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawRTDMessage>>
    convert_rtd_entry(const PacketParser::SensorDataEntry& entry,
                      uint64_t receive_timestamp_ns) const;

    /**
     * @brief Convert LC sensor entry to RawLCMessage
     */
    std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawLCMessage>>
    convert_lc_entry(const PacketParser::SensorDataEntry& entry,
                     uint64_t receive_timestamp_ns) const;
};

}  // namespace protocol
}  // namespace daq_comms

#endif  // DAQ_PACKET_PARSER_HPP
