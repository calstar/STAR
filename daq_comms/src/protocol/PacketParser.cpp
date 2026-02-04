#include "protocol/PacketParser.hpp"

#include <arpa/inet.h>

#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>

namespace daq_comms {
namespace protocol {

PacketParser::PacketParser()
    : healthy_(true), checksum_validation_enabled_(true), next_sequence_(1), expected_sequence_(1) {
    stats_ = PacketStats{};
    stats_.last_reset = std::chrono::steady_clock::now();
}

std::optional<PacketParser::ParsedPacket> PacketParser::parse_packet(const uint8_t* data,
                                                                     size_t size) {
    if (size < PACKET_HEADER_SIZE) {
        handle_malformed_packet("Packet too small: " + std::to_string(size) + " < " +
                                std::to_string(PACKET_HEADER_SIZE));
        return std::nullopt;
    }

    // Validate checksum if enabled
    if (checksum_validation_enabled_) {
        uint16_t calculated_checksum = calculate_checksum(data, HEADER_DATA_SIZE);
        uint16_t received_checksum;
        std::memcpy(&received_checksum, data + HEADER_DATA_SIZE, 2);
        received_checksum = ntohs(received_checksum);

        if (calculated_checksum != received_checksum) {
            handle_malformed_packet(
                "Checksum mismatch: calculated=" + std::to_string(calculated_checksum) +
                ", received=" + std::to_string(received_checksum));
            stats_.checksum_errors++;
            // Continue parsing anyway, but mark as invalid
        }
    }

    ParsedPacket packet;
    packet.received_time = std::chrono::steady_clock::now();
    packet.raw_packet.assign(data, data + size);
    packet.is_valid = false;

    size_t offset = 0;

    // Parse header
    PacketHeader header;
    if (!parse_header(data, size, offset, header)) {
        handle_malformed_packet("Failed to parse packet header");
        return std::nullopt;
    }

    if (!header.is_valid()) {
        handle_malformed_packet(
            "Invalid packet header (magic=" + std::to_string(header.magic_number) +
            ", version=" + std::to_string(header.protocol_version) + ")");
        return std::nullopt;
    }

    packet.header = header;

    // Validate sequence number
    if (!validate_sequence(header.sequence_number)) {
        stats_.sequence_errors++;
    }

    // Parse sensor data entries
    for (uint16_t i = 0; i < header.sensor_count; ++i) {
        if (offset >= size) {
            handle_malformed_packet("Not enough data for sensor entry #" + std::to_string(i));
            break;
        }

        SensorDataEntry entry;
        if (!parse_sensor_data(data, size, offset, entry)) {
            handle_malformed_packet("Failed to parse sensor entry #" + std::to_string(i));
            break;
        }

        packet.sensor_data.push_back(entry);

        // Update statistics
        {
            std::lock_guard<std::mutex> lock(stats_mutex_);
            stats_.sensor_packet_counts[entry.sensor_type]++;
        }
    }

    // Validate payload size matches
    size_t expected_payload_size = offset - PACKET_HEADER_SIZE;
    if (expected_payload_size != header.payload_size) {
        handle_malformed_packet("Payload size mismatch: expected " +
                                std::to_string(header.payload_size) + ", parsed " +
                                std::to_string(expected_payload_size));
    }

    // Validate checksum if enabled
    if (checksum_validation_enabled_ && packet.is_valid) {
        uint16_t calculated_checksum =
            calculate_checksum(packet.raw_packet.data(), HEADER_DATA_SIZE);
        if (calculated_checksum != header.checksum) {
            stats_.checksum_errors++;
            packet.is_valid = false;
            packet.error_message = "Checksum validation failed";
        }
    }

    packet.is_valid = (packet.sensor_data.size() == header.sensor_count);

    if (packet.is_valid) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.total_packets_received++;
    } else {
        stats_.malformed_packets++;
    }

    return packet;
}

std::optional<PacketParser::ParsedPacket> PacketParser::parse_packet(
    const std::vector<uint8_t>& data) {
    return parse_packet(data.data(), data.size());
}

bool PacketParser::parse_header(const uint8_t* data, size_t size, size_t& offset,
                                PacketHeader& header) const {
    if (offset + PACKET_HEADER_SIZE > size) {
        return false;
    }

    // Parse header fields (network byte order, matching FSW exactly)
    std::memcpy(&header.magic_number, data + offset, 4);
    offset += 4;
    header.magic_number = ntohl(header.magic_number);

    std::memcpy(&header.protocol_version, data + offset, 2);
    offset += 2;
    header.protocol_version = ntohs(header.protocol_version);

    header.packet_type = data[offset++];
    header.priority = data[offset++];

    std::memcpy(&header.payload_size, data + offset, 2);
    offset += 2;
    header.payload_size = ntohs(header.payload_size);

    std::memcpy(&header.sensor_count, data + offset, 2);
    offset += 2;
    header.sensor_count = ntohs(header.sensor_count);

    std::memcpy(&header.sequence_number, data + offset, 4);
    offset += 4;
    header.sequence_number = ntohl(header.sequence_number);

    std::memcpy(&header.timestamp_ns, data + offset, 8);
    offset += 8;
    // Note: uint64_t network byte order conversion (if needed)
    // For now, assume little-endian host

    // Parse checksum (last 2 bytes of header)
    std::memcpy(&header.checksum, data + offset, 2);
    offset += 2;
    header.checksum = ntohs(header.checksum);

    return true;
}

bool PacketParser::parse_sensor_data(const uint8_t* data, size_t size, size_t& offset,
                                     SensorDataEntry& entry) const {
    if (offset + 1 > size) {
        return false;
    }

    entry.sensor_type = static_cast<SensorType>(data[offset++]);

    if (offset + 1 > size) {
        return false;
    }
    entry.sensor_id = data[offset++];

    if (offset + 2 > size) {
        return false;
    }
    uint16_t data_size;
    std::memcpy(&data_size, data + offset, 2);
    offset += 2;
    entry.data_size = ntohs(data_size);

    if (offset + entry.data_size > size) {
        return false;
    }

    entry.raw_data.assign(data + offset, data + offset + entry.data_size);
    offset += entry.data_size;

    if (offset + 8 > size) {
        return false;
    }
    std::memcpy(&entry.timestamp_ns, data + offset, 8);
    offset += 8;

    if (offset + 1 > size) {
        return false;
    }
    entry.quality = data[offset++];

    return true;
}

std::vector<uint8_t> PacketParser::construct_sensor_packet(
    const std::vector<SensorDataEntry>& sensor_data, Priority priority) {
    std::vector<uint8_t> packet;

    // Calculate payload size
    uint16_t payload_size = 0;
    for (const auto& entry : sensor_data) {
        payload_size += 1;                // sensor_type
        payload_size += 1;                // sensor_id
        payload_size += 2;                // data_size
        payload_size += entry.data_size;  // raw_data
        payload_size += 8;                // timestamp_ns
        payload_size += 1;                // quality
    }

    // Add header
    add_header_to_packet(packet, PacketType::SENSOR_DATA, priority, payload_size,
                         static_cast<uint16_t>(sensor_data.size()));

    // Add sensor entries
    for (const auto& entry : sensor_data) {
        add_sensor_entry_to_packet(packet, entry);
    }

    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.total_packets_sent++;
    }

    return packet;
}

std::vector<uint8_t> PacketParser::construct_command_packet(
    uint8_t command_type, const std::vector<uint8_t>& command_data, Priority priority) {
    std::vector<uint8_t> packet;

    // Command packet payload: [command_type (1)] + [command_data]
    uint16_t payload_size = 1 + static_cast<uint16_t>(command_data.size());

    // Add header
    add_header_to_packet(packet, PacketType::CONTROL_COMMAND, priority, payload_size, 1);

    // Add command type
    packet.push_back(command_type);

    // Add command data
    packet.insert(packet.end(), command_data.begin(), command_data.end());

    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.total_packets_sent++;
    }

    return packet;
}

std::vector<uint8_t> PacketParser::construct_calibration_request(
    SensorType sensor_type, uint8_t sensor_id, const std::vector<double>& calibration_data) {
    std::vector<uint8_t> command_data;

    // Calibration request format: [sensor_type (1)] + [sensor_id (1)] + [calibration_data (8*N)]
    command_data.push_back(static_cast<uint8_t>(sensor_type));
    command_data.push_back(sensor_id);

    for (double value : calibration_data) {
        uint8_t bytes[8];
        std::memcpy(bytes, &value, 8);
        command_data.insert(command_data.end(), bytes, bytes + 8);
    }

    return construct_command_packet(0x01, command_data,
                                    Priority::HIGH);  // 0x01 = calibration command
}

void PacketParser::add_header_to_packet(std::vector<uint8_t>& packet, PacketType type,
                                        Priority priority, uint16_t payload_size,
                                        uint16_t sensor_count) {
    // Reserve space for header (without checksum first)
    size_t header_start = packet.size();
    packet.resize(packet.size() + HEADER_DATA_SIZE);

    uint32_t sequence = get_next_sequence();
    auto now = std::chrono::steady_clock::now();
    auto duration = now.time_since_epoch();
    uint64_t timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();

    // Write header fields (network byte order, matching FSW exactly)
    uint32_t magic = htonl(MAGIC_NUMBER);
    std::memcpy(packet.data() + header_start, &magic, 4);
    header_start += 4;

    uint16_t version = htons(PROTOCOL_VERSION);
    std::memcpy(packet.data() + header_start, &version, 2);
    header_start += 2;

    packet[header_start++] = static_cast<uint8_t>(type);
    packet[header_start++] = static_cast<uint8_t>(priority);

    uint16_t payload_size_net = htons(payload_size);
    std::memcpy(packet.data() + header_start, &payload_size_net, 2);
    header_start += 2;

    uint16_t sensor_count_net = htons(sensor_count);
    std::memcpy(packet.data() + header_start, &sensor_count_net, 2);
    header_start += 2;

    uint32_t sequence_net = htonl(sequence);
    std::memcpy(packet.data() + header_start, &sequence_net, 4);
    header_start += 4;

    std::memcpy(packet.data() + header_start, &timestamp_ns, 8);
    header_start += 8;

    // Calculate and append checksum (CRC16 of header data)
    uint16_t checksum =
        calculate_checksum(packet.data() + (packet.size() - HEADER_DATA_SIZE), HEADER_DATA_SIZE);
    uint16_t checksum_net = htons(checksum);
    packet.resize(packet.size() + 2);  // Add space for checksum
    std::memcpy(packet.data() + header_start, &checksum_net, 2);
}

void PacketParser::add_sensor_entry_to_packet(std::vector<uint8_t>& packet,
                                              const SensorDataEntry& entry) const {
    packet.push_back(static_cast<uint8_t>(entry.sensor_type));
    packet.push_back(entry.sensor_id);

    uint16_t data_size_net = htons(entry.data_size);
    uint8_t size_bytes[2];
    std::memcpy(size_bytes, &data_size_net, 2);
    packet.insert(packet.end(), size_bytes, size_bytes + 2);

    packet.insert(packet.end(), entry.raw_data.begin(), entry.raw_data.end());

    uint8_t timestamp_bytes[8];
    std::memcpy(timestamp_bytes, &entry.timestamp_ns, 8);
    packet.insert(packet.end(), timestamp_bytes, timestamp_bytes + 8);

    packet.push_back(entry.quality);
}

bool PacketParser::validate_packet(const ParsedPacket& packet) const {
    if (!packet.is_valid) {
        return false;
    }

    if (!packet.header.is_valid()) {
        return false;
    }

    if (packet.sensor_data.size() != packet.header.sensor_count) {
        return false;
    }

    // Validate checksum if enabled
    if (checksum_validation_enabled_) {
        uint16_t calculated_checksum =
            calculate_checksum(packet.raw_packet.data(), HEADER_DATA_SIZE);
        if (calculated_checksum != packet.header.checksum) {
            return false;
        }
    }

    return true;
}

bool PacketParser::validate_sequence(uint32_t sequence) {
    if (expected_sequence_ == 0) {
        expected_sequence_ = sequence + 1;
        return true;
    }

    if (sequence == expected_sequence_) {
        expected_sequence_++;
        return true;
    }

    // Sequence mismatch
    return false;
}

void PacketParser::handle_malformed_packet(const std::string& error) {
    active_errors_.push_back(error);
    stats_.malformed_packets++;

    // Keep only last 10 errors
    if (active_errors_.size() > 10) {
        active_errors_.erase(active_errors_.begin());
    }
}

void PacketParser::clear_errors() {
    active_errors_.clear();
}

void PacketParser::reset_stats() {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    stats_ = PacketStats{};
    stats_.last_reset = std::chrono::steady_clock::now();
}

uint16_t PacketParser::calculate_checksum(const uint8_t* data, size_t size) const {
    // CRC16-CCITT implementation (matching FSW PacketProtocol)
    // Polynomial: 0x1021, Initial value: 0xFFFF
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < size; ++i) {
        crc ^= (static_cast<uint16_t>(data[i]) << 8);
        for (int j = 0; j < 8; ++j) {
            if (crc & 0x8000) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    return crc;
}

// PacketToCommsMessageConverter implementations
std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawPTMessage>>
PacketToCommsMessageConverter::convert_pt_entry(const PacketParser::SensorDataEntry& entry,
                                                uint64_t receive_timestamp_ns) const {
    if (entry.sensor_type != PacketParser::SensorType::PRESSURE_TRANSDUCER) {
        return std::nullopt;
    }

    if (entry.raw_data.size() < 9) {  // channel_id(1) + raw_adc(4) + timestamp(4) + flags(1)
        return std::nullopt;
    }

    comms::messages::sensor::RawPTMessage msg;

    size_t offset = 0;
    uint8_t channel_id = entry.raw_data[offset++];

    uint32_t raw_adc;
    std::memcpy(&raw_adc, entry.raw_data.data() + offset, 4);
    offset += 4;
    raw_adc = ntohl(raw_adc);  // Convert from network byte order if needed

    uint32_t sample_timestamp_ms;
    std::memcpy(&sample_timestamp_ms, entry.raw_data.data() + offset, 4);
    offset += 4;
    sample_timestamp_ms = ntohl(sample_timestamp_ms);

    uint8_t status_flags = entry.raw_data[offset++];

    msg.setField<0>(receive_timestamp_ns);
    msg.setField<1>(channel_id);
    msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding
    msg.setField<3>(raw_adc);
    msg.setField<4>(sample_timestamp_ms);
    msg.setField<5>(status_flags);

    std::array<uint8_t, 2> packet_id = {0x20, 0x00};  // PT packet ID
    return std::make_pair(packet_id, msg);
}

std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawTCMessage>>
PacketToCommsMessageConverter::convert_tc_entry(const PacketParser::SensorDataEntry& entry,
                                                uint64_t receive_timestamp_ns) const {
    if (entry.sensor_type != PacketParser::SensorType::THERMOCOUPLE) {
        return std::nullopt;
    }

    if (entry.raw_data.size() < 9) {
        return std::nullopt;
    }

    comms::messages::sensor::RawTCMessage msg;

    size_t offset = 0;
    uint8_t channel_id = entry.raw_data[offset++];

    uint32_t raw_adc;
    std::memcpy(&raw_adc, entry.raw_data.data() + offset, 4);
    offset += 4;
    raw_adc = ntohl(raw_adc);

    uint32_t sample_timestamp_ms;
    std::memcpy(&sample_timestamp_ms, entry.raw_data.data() + offset, 4);
    offset += 4;
    sample_timestamp_ms = ntohl(sample_timestamp_ms);

    uint8_t status_flags = entry.raw_data[offset++];

    msg.setField<0>(receive_timestamp_ns);
    msg.setField<1>(channel_id);
    msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding
    msg.setField<3>(raw_adc);
    msg.setField<4>(sample_timestamp_ms);
    msg.setField<5>(status_flags);

    std::array<uint8_t, 2> packet_id = {0x21, 0x00};  // TC packet ID
    return std::make_pair(packet_id, msg);
}

std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawRTDMessage>>
PacketToCommsMessageConverter::convert_rtd_entry(const PacketParser::SensorDataEntry& entry,
                                                 uint64_t receive_timestamp_ns) const {
    if (entry.sensor_type != PacketParser::SensorType::RTD_TEMPERATURE) {
        return std::nullopt;
    }

    if (entry.raw_data.size() < 9) {
        return std::nullopt;
    }

    comms::messages::sensor::RawRTDMessage msg;

    size_t offset = 0;
    uint8_t channel_id = entry.raw_data[offset++];

    uint32_t raw_resistance;
    std::memcpy(&raw_resistance, entry.raw_data.data() + offset, 4);
    offset += 4;
    raw_resistance = ntohl(raw_resistance);

    uint32_t sample_timestamp_ms;
    std::memcpy(&sample_timestamp_ms, entry.raw_data.data() + offset, 4);
    offset += 4;
    sample_timestamp_ms = ntohl(sample_timestamp_ms);

    uint8_t status_flags = entry.raw_data[offset++];

    msg.setField<0>(receive_timestamp_ns);
    msg.setField<1>(channel_id);
    msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding
    msg.setField<3>(raw_resistance);
    msg.setField<4>(sample_timestamp_ms);
    msg.setField<5>(status_flags);

    std::array<uint8_t, 2> packet_id = {0x22, 0x00};  // RTD packet ID
    return std::make_pair(packet_id, msg);
}

std::optional<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawLCMessage>>
PacketToCommsMessageConverter::convert_lc_entry(const PacketParser::SensorDataEntry& entry,
                                                uint64_t receive_timestamp_ns) const {
    if (entry.sensor_type != PacketParser::SensorType::LOAD_CELL) {
        return std::nullopt;
    }

    if (entry.raw_data.size() < 9) {
        return std::nullopt;
    }

    comms::messages::sensor::RawLCMessage msg;

    size_t offset = 0;
    uint8_t channel_id = entry.raw_data[offset++];

    uint32_t raw_adc;
    std::memcpy(&raw_adc, entry.raw_data.data() + offset, 4);
    offset += 4;
    raw_adc = ntohl(raw_adc);

    uint32_t sample_timestamp_ms;
    std::memcpy(&sample_timestamp_ms, entry.raw_data.data() + offset, 4);
    offset += 4;
    sample_timestamp_ms = ntohl(sample_timestamp_ms);

    uint8_t status_flags = entry.raw_data[offset++];

    msg.setField<0>(receive_timestamp_ns);
    msg.setField<1>(channel_id);
    msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding
    msg.setField<3>(raw_adc);
    msg.setField<4>(sample_timestamp_ms);
    msg.setField<5>(status_flags);

    std::array<uint8_t, 2> packet_id = {0x23, 0x00};  // LC packet ID
    return std::make_pair(packet_id, msg);
}

}  // namespace protocol
}  // namespace daq_comms
