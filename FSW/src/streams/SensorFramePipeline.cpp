#include "streams/SensorFramePipeline.hpp"

#include <chrono>
#include <cstring>
#include <iostream>

namespace fsw {
namespace streams {

SensorFramePipeline::SensorFramePipeline(const std::string& bind_address, uint16_t bind_port)
    : receive_buffer_(RECEIVE_BUFFER_SIZE) {
    socket_ = std::make_unique<daq_comms::transport::UDPSocket>(bind_address, bind_port);

    if (!socket_->is_valid()) {
        last_error_ = "Failed to create UDP socket: " + socket_->last_error();
    }
}

std::optional<daq_comms::protocol::SensorBatch> SensorFramePipeline::poll() {
    if (!socket_->is_valid()) {
        last_error_ = "Socket not valid: " + socket_->last_error();
        return std::nullopt;
    }

    // Receive raw bytes with source IP tracking
    uint16_t source_port = 0;
    ssize_t received = socket_->receive_from(receive_buffer_.data(), receive_buffer_.size(),
                                             last_source_ip_, source_port);
    if (received <= 0) {
        if (received < 0 && !socket_->last_error().empty()) {
            static size_t error_count = 0;
            if (error_count++ < 5) {
                std::cerr << "[Pipeline] Socket receive error: " << socket_->last_error()
                          << std::endl;
            }
        }
        return std::nullopt;
    }

    // Parse packet type
    auto packet_type = board_parser_.parse_packet_type(receive_buffer_.data(), received);
    if (!packet_type) {
        return std::nullopt;
    }

    // Handle SENSOR_DATA packets
    if (*packet_type == daq_comms::protocol::DiabloBoardPacketParser::PacketType::SENSOR_DATA) {
        auto parsed = board_parser_.parse_sensor_data(receive_buffer_.data(), received);
        if (!parsed || !parsed->is_valid) {
            return std::nullopt;
        }

        // Convert to SensorBatch format
        daq_comms::protocol::SensorBatch batch;

        // Use chunk timestamp (convert ms to ns)
        if (!parsed->chunks.empty()) {
            batch.frame_timestamp_ns =
                static_cast<uint64_t>(parsed->chunks[0].timestamp) * 1000000ULL;
        } else {
            auto now = std::chrono::steady_clock::now();
            auto duration = now.time_since_epoch();
            batch.frame_timestamp_ns =
                std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();
        }

        batch.sequence_id = parsed->header.timestamp & 0xFFFF;  // Use lower 16 bits of timestamp
        batch.is_valid = true;

        // Convert sensor datapoints to sensor samples
        // Note: We need board_type context to know which sensor type (PT/TC/RTD/LC)
        // For now, we'll infer from packet source or use a default
        // TODO: Track board_type per IP address

        for (const auto& chunk : parsed->chunks) {
            for (const auto& dp : chunk.datapoints) {
                // Create samples - we'll need board context to know sensor type
                // For now, create PT samples as default (will be updated by board discovery)
                daq_comms::protocol::RawPTSample sample;
                sample.channel_id = dp.sensor_id;
                sample.raw_adc_counts = dp.data;  // Already uint32_t, little-endian
                sample.sample_timestamp_ms = chunk.timestamp;
                sample.status_flags = 0;  // No status flags in DiabloAvionics format
                batch.pt_samples.push_back(sample);
            }
        }

        return batch;
    }

    // Handle BOARD_HEARTBEAT packets (for board discovery)
    // These are handled separately by board discovery system
    if (*packet_type == daq_comms::protocol::DiabloBoardPacketParser::PacketType::BOARD_HEARTBEAT) {
        // Return empty batch - heartbeat handled by discovery
        return std::nullopt;
    }

    return std::nullopt;
}

bool SensorFramePipeline::is_ready() const {
    return socket_ && socket_->is_valid();
}

std::string SensorFramePipeline::last_error() const {
    return last_error_;
}

}  // namespace streams
}  // namespace fsw
