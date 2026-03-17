#include "protocol/DiabloBoardPacketParser.hpp"

#include <algorithm>
#include <cstring>
#include <iomanip>
#include <sstream>

namespace daq_comms {
namespace protocol {

DiabloBoardPacketParser::DiabloBoardPacketParser() {
}

std::optional<DiabloBoardPacketParser::PacketType> DiabloBoardPacketParser::parse_packet_type(
    const uint8_t* data, size_t size) const {
    if (size < 1) {
        return std::nullopt;
    }

    uint8_t type_byte = data[0];
    if (type_byte >= 1 && type_byte <= 9) {
        return static_cast<PacketType>(type_byte);
    }

    return std::nullopt;
}

std::optional<DiabloBoardPacketParser::ParsedBoardHeartbeat>
DiabloBoardPacketParser::parse_board_heartbeat(const uint8_t* data, size_t size) const {
    constexpr size_t HEADER_SIZE = 6;
    constexpr size_t BODY_LEGACY = 4;  // board_type, board_id, engine_state, board_state
    constexpr size_t BODY_NEW = 35;    // firmware_hash[32], board_id, engine_state, board_state

    if (size < HEADER_SIZE + BODY_LEGACY) {
        return std::nullopt;
    }

    ParsedBoardHeartbeat result;

    // Parse header (little-endian)
    result.header.packet_type = static_cast<PacketType>(data[0]);
    result.header.version = data[1];
    result.header.timestamp = read_le_u32(data + 2);

    if (result.header.packet_type != PacketType::BOARD_HEARTBEAT) {
        return std::nullopt;
    }

    if (size >= HEADER_SIZE + BODY_NEW) {
        // New format: firmware_hash[32], board_id, engine_state, board_state
        std::memcpy(result.firmware_hash.data(), data + HEADER_SIZE, 32);
        result.heartbeat.board_type = BoardType::UNKNOWN;  // Not in packet; infer from config
        result.heartbeat.board_id = data[HEADER_SIZE + 32];
        result.heartbeat.engine_state = static_cast<EngineState>(data[HEADER_SIZE + 33]);
        result.heartbeat.board_state = static_cast<BoardState>(data[HEADER_SIZE + 34]);
    } else {
        // Legacy format: board_type, board_id, engine_state, board_state
        result.heartbeat.board_type = static_cast<BoardType>(data[6]);
        result.heartbeat.board_id = data[7];
        result.heartbeat.engine_state = static_cast<EngineState>(data[8]);
        result.heartbeat.board_state = static_cast<BoardState>(data[9]);
    }

    result.is_valid = true;
    return result;
}

std::optional<DiabloBoardPacketParser::ParsedSensorDataPacket>
DiabloBoardPacketParser::parse_sensor_data(const uint8_t* data, size_t size) const {
    constexpr size_t HEADER_SIZE = 6;
    constexpr size_t BODY_HEADER_SIZE = 2;

    if (size < HEADER_SIZE + BODY_HEADER_SIZE) {
        return std::nullopt;
    }

    ParsedSensorDataPacket result;

    // Parse header
    result.header.packet_type = static_cast<PacketType>(data[0]);
    result.header.version = data[1];
    result.header.timestamp = read_le_u32(data + 2);

    // Verify packet type
    if (result.header.packet_type != PacketType::SENSOR_DATA) {
        return std::nullopt;
    }

    // Parse body header
    result.num_chunks = data[6];
    result.num_sensors = data[7];
    if (result.num_sensors == 0 || result.num_sensors > 32) {
        result.is_valid = false;
        return result;  // Sanity: corrupt num_sensors
    }
    if (result.num_chunks == 0 || result.num_chunks > 64) {
        result.is_valid = false;
        return result;  // Sanity: corrupt num_chunks
    }

    // Validate total packet size before parsing (matches DAQv2-Comms parse_sensor_data_packet)
    const size_t per_chunk_size = 4 + (static_cast<size_t>(result.num_sensors) * 5);
    const size_t expected_size =
        HEADER_SIZE + BODY_HEADER_SIZE + (static_cast<size_t>(result.num_chunks) * per_chunk_size);
    if (size < expected_size) {
        result.is_valid = false;
        return result;  // Truncated or corrupted packet
    }

    // Parse chunks
    size_t offset = HEADER_SIZE + BODY_HEADER_SIZE;

    for (uint8_t c = 0; c < result.num_chunks; ++c) {
        if (offset + 4 > size) {
            result.is_valid = false;
            return result;  // Not enough data
        }

        SensorDataChunk chunk;
        chunk.timestamp = read_le_u32(data + offset);
        offset += 4;

        // Parse datapoints for this chunk
        for (uint8_t s = 0; s < result.num_sensors; ++s) {
            if (offset + 5 > size) {
                result.is_valid = false;
                return result;  // Not enough data
            }

            SensorDatapoint dp;
            dp.sensor_id = data[offset++];
            dp.data = read_le_u32(data + offset);
            offset += 4;

            chunk.datapoints.push_back(dp);
        }

        result.chunks.push_back(chunk);
    }

    result.is_valid = (result.chunks.size() == result.num_chunks);
    return result;
}

DiabloBoardPacketParser::BoardSignature DiabloBoardPacketParser::extract_signature(
    const ParsedBoardHeartbeat& heartbeat, const std::string& source_ip) const {
    BoardSignature sig;
    sig.board_type = heartbeat.heartbeat.board_type;
    sig.board_id = heartbeat.heartbeat.board_id;
    sig.mac_address = "unknown";  // MAC will be extracted from network layer

    return sig;
}

std::vector<DiabloBoardPacketParser::DetectedSensor> DiabloBoardPacketParser::detect_sensors(
    const ParsedSensorDataPacket& packet, BoardType board_type) const {
    std::vector<DetectedSensor> sensors;

    if (!packet.is_valid || packet.chunks.empty()) {
        return sensors;
    }

    // Extract unique sensor IDs from first chunk
    std::map<uint8_t, bool> sensor_ids;
    for (const auto& dp : packet.chunks[0].datapoints) {
        sensor_ids[dp.sensor_id] = (dp.data != 0);  // Active if non-zero
    }

    for (const auto& [sensor_id, is_active] : sensor_ids) {
        DetectedSensor sensor;
        sensor.sensor_id = sensor_id;
        sensor.board_type = board_type;
        sensor.is_active = is_active;
        sensors.push_back(sensor);
    }

    return sensors;
}

std::string DiabloBoardPacketParser::calculate_ip_from_mac(const std::string& mac_address,
                                                           const std::string& base_ip,
                                                           uint8_t ip_range_start,
                                                           uint8_t ip_range_end) {
    // Parse MAC address (format: "aa:bb:cc:dd:ee:ff")
    std::istringstream mac_stream(mac_address);
    std::string byte_str;
    uint32_t mac_hash = 0;
    int byte_count = 0;

    while (std::getline(mac_stream, byte_str, ':') && byte_count < 6) {
        uint8_t byte_val = static_cast<uint8_t>(std::stoul(byte_str, nullptr, 16));
        mac_hash = (mac_hash << 8) | byte_val;
        byte_count++;
    }

    // Use MAC hash to get consistent IP in range
    uint8_t ip_octet = ip_range_start + (mac_hash % (ip_range_end - ip_range_start + 1));

    // Parse base IP
    size_t last_dot = base_ip.rfind('.');
    std::string base = base_ip.substr(0, last_dot);

    return base + "." + std::to_string(ip_octet);
}

std::vector<uint8_t> DiabloBoardPacketParser::construct_actuator_command_packet(
    const std::vector<ActuatorCommand>& commands) const {
    if (commands.empty() || commands.size() > 255) {
        return {};
    }

    // Packet structure (matching DAQv2-Comms exactly):
    // Header: [packet_type(1)][version(1)][timestamp(4)] = 6 bytes
    // Body: [num_commands(1)] = 1 byte
    // Commands: [actuator_id(1)][actuator_state(1)] * num_commands = 2 bytes each

    constexpr size_t HEADER_SIZE = 6;
    constexpr size_t BODY_SIZE = 1;
    constexpr size_t COMMAND_SIZE = 2;

    size_t packet_size = HEADER_SIZE + BODY_SIZE + (commands.size() * COMMAND_SIZE);
    std::vector<uint8_t> packet(packet_size);
    size_t offset = 0;

    // Packet header (little-endian)
    packet[offset++] = static_cast<uint8_t>(PacketType::ACTUATOR_COMMAND);  // packet_type
    packet[offset++] = 0;  // version (DIABLO_COMMS_VERSION = 0, matching DAQv2-Comms and GUI)

    // Timestamp (32-bit, milliseconds, little-endian)
    uint32_t timestamp_ms =
        static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::steady_clock::now().time_since_epoch())
                                  .count() &
                              0xFFFFFFFF);
    packet[offset++] = static_cast<uint8_t>(timestamp_ms & 0xFF);
    packet[offset++] = static_cast<uint8_t>((timestamp_ms >> 8) & 0xFF);
    packet[offset++] = static_cast<uint8_t>((timestamp_ms >> 16) & 0xFF);
    packet[offset++] = static_cast<uint8_t>((timestamp_ms >> 24) & 0xFF);

    // Packet body
    packet[offset++] = static_cast<uint8_t>(commands.size());  // num_commands

    // Actuator commands
    for (const auto& cmd : commands) {
        packet[offset++] = cmd.actuator_id;     // actuator_id (1-indexed, 1-10)
        packet[offset++] = cmd.actuator_state;  // actuator_state (0=OFF, non-zero=ON)
    }

    return packet;
}

}  // namespace protocol
}  // namespace daq_comms
