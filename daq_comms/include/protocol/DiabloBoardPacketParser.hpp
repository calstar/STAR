#ifndef DAQ_DIABLO_BOARD_PACKET_PARSER_HPP
#define DAQ_DIABLO_BOARD_PACKET_PARSER_HPP

#include <array>
#include <chrono>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace daq_comms {
namespace protocol {

/**
 * @brief Parser for actual DiabloAvionics board packets
 *
 * This matches the REAL packet format from DAQv2-Comms library:
 * - 6-byte header (packet_type, version, timestamp)
 * - Simple body structures
 * - Little-endian byte order
 * - NO magic numbers, NO checksums
 */
class DiabloBoardPacketParser {
public:
    // Packet types (matching DAQv2-Comms exactly)
    enum class PacketType : uint8_t {
        BOARD_HEARTBEAT = 1,
        SERVER_HEARTBEAT = 2,
        SENSOR_DATA = 3,
        ACTUATOR_COMMAND = 4,
        SENSOR_CONFIG = 5,
        ACTUATOR_CONFIG = 6,
        ABORT = 7,
        ABORT_DONE = 8,
        CLEAR_ABORT = 9,
        SELF_TEST = 12
    };

    // Board types (matching DAQv2-Comms)
    enum class BoardType : uint8_t {
        UNKNOWN = 0,
        PRESSURE_TRANSDUCER = 1,
        LOAD_CELL = 2,
        RTD = 3,
        THERMOCOUPLE = 4,
        ACTUATOR = 5
    };

    // Board states
    enum class BoardState : uint8_t { SETUP = 1, ACTIVE = 2, ABORT = 3, ABORT_DONE = 4 };

    // Engine states
    enum class EngineState : uint8_t {
        SAFE = 0,
        PRESSURIZING = 1,
        LOX_FILL = 2,
        FIRING = 3,
        POST_FIRE = 4
    };

    /**
     * @brief Packet header (6 bytes - matches actual format)
     */
    struct PacketHeader {
        PacketType packet_type;  // 1 byte
        uint8_t version;         // 1 byte
        uint32_t timestamp;      // 4 bytes (milliseconds, little-endian)
    };

    /**
     * @brief Board Heartbeat packet body
     *
     * Matches DAQv2-Comms: board_id is a full uint8_t (0-255).
     */
    struct BoardHeartbeat {
        BoardType board_type;      // 1 byte
        uint8_t board_id;          // 1 byte (0-255)
        EngineState engine_state;  // 1 byte
        BoardState board_state;    // 1 byte
    };

    /**
     * @brief Sensor datapoint
     */
    struct SensorDatapoint {
        uint8_t sensor_id;  // Sensor ID on board (0-indexed)
        uint32_t data;      // Sensor value (can be ADC counts or float)
    };

    /**
     * @brief Self Test Result
     */
    struct SelfTestResult {
        uint8_t sensor_id;
        uint8_t result; // 1 = good, 0 = bad
    };

    /**
     * @brief Sensor data chunk
     */
    struct SensorDataChunk {
        uint32_t timestamp;                       // Chunk timestamp (ms)
        std::vector<SensorDatapoint> datapoints;  // Sensor readings
    };

    /**
     * @brief Parsed sensor data packet
     */
    struct ParsedSensorDataPacket {
        PacketHeader header;
        uint8_t num_chunks;
        uint8_t num_sensors;
        std::vector<SensorDataChunk> chunks;
        bool is_valid;
    };

    /**
     * @brief Parsed self test packet
     */
    struct ParsedSelfTestPacket {
        PacketHeader header;
        uint8_t num_sensors;
        std::vector<SelfTestResult> results;
        bool is_valid;
    };

    /**
     * @brief Parsed board heartbeat packet
     *
     * Supports both formats:
     * - Legacy (4-byte body): board_type, board_id, engine_state, board_state
     * - New (35-byte body): firmware_hash[32], board_id, engine_state, board_state
     *   (board_type set to UNKNOWN; infer from config when available)
     */
    struct ParsedBoardHeartbeat {
        PacketHeader header;
        BoardHeartbeat heartbeat;
        std::array<uint8_t, 32> firmware_hash{};  // SHA-256 of firmware (new format only)
        bool is_valid;
    };

    DiabloBoardPacketParser();
    ~DiabloBoardPacketParser() = default;

    /**
     * @brief Parse packet from raw bytes
     * @param data Raw packet bytes (little-endian)
     * @param size Packet size
     * @return Parsed packet info
     */
    std::optional<PacketType> parse_packet_type(const uint8_t* data, size_t size) const;

    /**
     * @brief Parse board heartbeat packet
     */
    std::optional<ParsedBoardHeartbeat> parse_board_heartbeat(const uint8_t* data,
                                                              size_t size) const;

    /**
     * @brief Parse sensor data packet
     */
    std::optional<ParsedSensorDataPacket> parse_sensor_data(const uint8_t* data, size_t size) const;

    /**
     * @brief Parse self test packet
     */
    std::optional<ParsedSelfTestPacket> parse_self_test(const uint8_t* data, size_t size) const;

    /**
     * @brief Extract board signature from heartbeat
     */
    struct BoardSignature {
        BoardType board_type;
        uint8_t board_id;
        std::string mac_address;  // Will be extracted from source IP/MAC
    };

    BoardSignature extract_signature(const ParsedBoardHeartbeat& heartbeat,
                                     const std::string& source_ip) const;

    /**
     * @brief Detect sensors from sensor data packet
     */
    struct DetectedSensor {
        uint8_t sensor_id;
        BoardType board_type;  // Inferred from packet source/context
        bool is_active;
    };

    std::vector<DetectedSensor> detect_sensors(const ParsedSensorDataPacket& packet,
                                               BoardType board_type) const;

    /**
     * @brief Actuator command structure (matching DAQv2-Comms)
     */
    struct ActuatorCommand {
        uint8_t actuator_id;     // Actuator ID (1-10, 1-indexed)
        uint8_t actuator_state;  // 0 = OFF, non-zero = ON
    };

    /**
     * @brief Construct actuator command packet (matching DAQv2-Comms format)
     * @param commands Vector of actuator commands
     * @return Packet bytes (little-endian)
     */
    std::vector<uint8_t> construct_actuator_command_packet(
        const std::vector<ActuatorCommand>& commands) const;

    /**
     * @brief Calculate IP from MAC address (deterministic assignment)
     */
    static std::string calculate_ip_from_mac(const std::string& mac_address,
                                             const std::string& base_ip, uint8_t ip_range_start,
                                             uint8_t ip_range_end);

private:
    // Helper to read little-endian uint32_t
    uint32_t read_le_u32(const uint8_t* data) const {
        return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
               (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
    }
};

}  // namespace protocol
}  // namespace daq_comms

#endif  // DAQ_DIABLO_BOARD_PACKET_PARSER_HPP
