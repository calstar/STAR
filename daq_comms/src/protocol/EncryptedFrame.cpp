#include "protocol/EncryptedFrame.hpp"

#include <cstring>
#include <algorithm>
#include <iostream>
#include <iomanip>
#include <arpa/inet.h>

namespace daq_comms {
namespace protocol {

FrameDecoder::FrameDecoder() 
    : expected_sequence_id_(0) {
    stats_ = Stats{};
    
    // Default development key (should be replaced with real key management)
    uint8_t default_key[] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                             0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10};
    set_decryption_key(default_key, sizeof(default_key));
}

void FrameDecoder::set_decryption_key(const uint8_t* key, size_t key_length) {
    decryption_key_.assign(key, key + key_length);
}

std::optional<SensorFrame> FrameDecoder::decode_frame(const uint8_t* data, size_t size) {
    if (size < FrameHeader::HEADER_SIZE) {
        static size_t small_packet_count = 0;
        if (small_packet_count++ < 3) {
            std::cerr << "[Decoder] Packet too small: " << size << " < " << FrameHeader::HEADER_SIZE << "\n";
        }
        return std::nullopt;
    }

    // Find magic byte (simple sync, could be improved with better framing)
    size_t header_offset = 0;
    bool found_magic = false;
    for (size_t i = 0; i <= size - FrameHeader::HEADER_SIZE; ++i) {
        if (data[i] == FrameHeader::MAGIC_BYTE) {
            header_offset = i;
            found_magic = true;
            break;
        }
    }

    if (!found_magic) {
        static size_t no_magic_count = 0;
        if (no_magic_count++ < 3) {
            std::cerr << "[Decoder] No magic byte found. First bytes: ";
            for (size_t i = 0; i < std::min(size, size_t(16)); ++i) {
                std::cerr << std::hex << std::setw(2) << std::setfill('0') 
                          << static_cast<int>(data[i]) << " ";
            }
            std::cerr << std::dec << "\n";
        }
        return std::nullopt;
    }

    // Parse header (handle endianness)
    FrameHeader header;
    std::memcpy(&header, data + header_offset, sizeof(FrameHeader));
    
    // Convert from network byte order
    header.sequence_id = ntohs(header.sequence_id);
    header.timestamp_ms = ntohl(header.timestamp_ms);
    header.payload_size = ntohs(header.payload_size);
    header.crc32 = ntohl(header.crc32);

    // Validate header
    if (!validate_header(header)) {
        stats_.frames_dropped++;
        return std::nullopt;
    }

    // Check sequence ID for loss detection
    if (expected_sequence_id_ != 0) {
        uint16_t gap = (header.sequence_id >= expected_sequence_id_) 
            ? (header.sequence_id - expected_sequence_id_)
            : (65535 - expected_sequence_id_ + header.sequence_id + 1);
        if (gap > 1) {
            stats_.sequence_gaps += (gap - 1);
        }
    }
    expected_sequence_id_ = header.sequence_id + 1;

    // Extract encrypted payload
    size_t payload_offset = header_offset + FrameHeader::HEADER_SIZE;
    if (size < payload_offset + header.payload_size) {
        stats_.frames_dropped++;
        return std::nullopt;
    }

    SensorFrame frame;
    frame.header = header;
    frame.receive_timestamp_ns = 0; // TODO: Get actual receive time
    frame.source_address = "";
    frame.source_port = 0;

    // Decrypt payload
    frame.decrypted_payload.resize(header.payload_size);
    if (!decrypt_payload(data + payload_offset, header.payload_size, frame.decrypted_payload)) {
        stats_.decryption_failures++;
        return std::nullopt;
    }

    stats_.frames_decoded++;
    stats_.last_sequence_id = header.sequence_id;
    
    return frame;
}

std::optional<SensorBatch> FrameDecoder::unpack_payload(const SensorFrame& frame) {
    SensorBatch batch;
    batch.frame_timestamp_ns = frame.receive_timestamp_ns;
    batch.sequence_id = frame.header.sequence_id;
    batch.is_valid = false;

    const uint8_t* payload = frame.decrypted_payload.data();
    size_t payload_size = frame.decrypted_payload.size();
    size_t offset = 0;

    // Unpack sensor samples based on payload structure
    // Continue until we've consumed all payload bytes
    while (offset < payload_size) {
        if (offset + 1 > payload_size) {
            // End of payload, but we haven't consumed all bytes - might be padding
            break;
        }
        
        uint8_t sensor_type = payload[offset++];
        
        switch (sensor_type) {
            case 0x01: { // PT sensor
                if (offset + 9 > payload_size) {
                    break; // Not enough data, stop unpacking
                }
                RawPTSample sample;
                sample.channel_id = payload[offset++];
                uint32_t raw_adc;
                std::memcpy(&raw_adc, payload + offset, 4);
                sample.raw_adc_counts = ntohl(raw_adc);
                offset += 4;
                uint32_t timestamp;
                std::memcpy(&timestamp, payload + offset, 4);
                sample.sample_timestamp_ms = ntohl(timestamp);
                offset += 4;
                sample.status_flags = payload[offset++];
                batch.pt_samples.push_back(sample);
                break;
            }
            case 0x02: { // TC sensor
                if (offset + 9 > payload_size) {
                    break;
                }
                RawTCSample sample;
                sample.channel_id = payload[offset++];
                uint32_t raw_adc;
                std::memcpy(&raw_adc, payload + offset, 4);
                sample.raw_adc_counts = ntohl(raw_adc);
                offset += 4;
                uint32_t timestamp;
                std::memcpy(&timestamp, payload + offset, 4);
                sample.sample_timestamp_ms = ntohl(timestamp);
                offset += 4;
                sample.status_flags = payload[offset++];
                batch.tc_samples.push_back(sample);
                break;
            }
            case 0x03: { // RTD sensor
                if (offset + 9 > payload_size) {
                    break;
                }
                RawRTDSample sample;
                sample.channel_id = payload[offset++];
                uint32_t raw_resistance;
                std::memcpy(&raw_resistance, payload + offset, 4);
                sample.raw_resistance_counts = ntohl(raw_resistance);
                offset += 4;
                uint32_t timestamp;
                std::memcpy(&timestamp, payload + offset, 4);
                sample.sample_timestamp_ms = ntohl(timestamp);
                offset += 4;
                sample.status_flags = payload[offset++];
                batch.rtd_samples.push_back(sample);
                break;
            }
            case 0x04: { // LC sensor
                if (offset + 9 > payload_size) {
                    break;
                }
                RawLCSample sample;
                sample.channel_id = payload[offset++];
                uint32_t raw_adc;
                std::memcpy(&raw_adc, payload + offset, 4);
                sample.raw_adc_counts = ntohl(raw_adc);
                offset += 4;
                uint32_t timestamp;
                std::memcpy(&timestamp, payload + offset, 4);
                sample.sample_timestamp_ms = ntohl(timestamp);
                offset += 4;
                sample.status_flags = payload[offset++];
                batch.lc_samples.push_back(sample);
                break;
            }
            default:
                // Unknown sensor type, skip this sample
                break;
        }
    }

    batch.is_valid = true;
    return batch;
}

bool FrameDecoder::validate_header(const FrameHeader& header) const {
    if (header.magic != FrameHeader::MAGIC_BYTE) {
        return false;
    }
    if (header.version != FrameHeader::PROTOCOL_VERSION) {
        return false;
    }
    if (header.payload_size > 4096) { // Reasonable max payload size
        return false;
    }
    
    // CRC validation would go here
    // For now, skip CRC check in development
    
    return true;
}

bool FrameDecoder::decrypt_payload(const uint8_t* encrypted, size_t encrypted_size,
                                   std::vector<uint8_t>& decrypted) const {
    if (decryption_key_.empty()) {
        return false;
    }

    decrypted.resize(encrypted_size);
    simple_xor_decrypt(encrypted, decrypted.data(), encrypted_size);
    return true;
}

void FrameDecoder::simple_xor_decrypt(const uint8_t* input, uint8_t* output, size_t size) const {
    for (size_t i = 0; i < size; ++i) {
        output[i] = input[i] ^ decryption_key_[i % decryption_key_.size()];
    }
}

uint32_t FrameDecoder::compute_crc32(const uint8_t* data, size_t size) const {
    // Simple CRC32 implementation (can be replaced with optimized version)
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (int j = 0; j < 8; ++j) {
            crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    return ~crc;
}

} // namespace protocol
} // namespace daq_comms

