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
        static size_t unknown_type_count = 0;
        if (++unknown_type_count <= 5 || unknown_type_count % 200 == 0) {
            uint8_t fb = received > 0 ? receive_buffer_[0] : 0;
            std::cerr << "[Pipeline] Unknown packet type #" << unknown_type_count
                      << " (first_byte=" << static_cast<int>(fb) << ", size=" << received
                      << ") from " << last_source_ip_ << " — expected 1=HEARTBEAT 3=SENSOR_DATA"
                      << std::endl;
        }
        return std::nullopt;
    }

    // Handle SENSOR_DATA packets
    if (*packet_type == daq_comms::protocol::DiabloBoardPacketParser::PacketType::SENSOR_DATA) {
        auto parsed = board_parser_.parse_sensor_data(receive_buffer_.data(), received);
        if (!parsed || !parsed->is_valid) {
            static size_t parse_fail_count = 0;
            if (++parse_fail_count <= 10 || parse_fail_count % 500 == 0) {
                std::cerr << "[Pipeline] SENSOR_DATA parse failed #" << parse_fail_count
                          << " (size=" << received
                          << ", valid=" << (parsed ? parsed->is_valid : false) << ") from "
                          << last_source_ip_ << std::endl;
            }
            return std::nullopt;
        }

        // Convert to SensorBatch format — emit every chunk so we get full rate (amortized data).
        daq_comms::protocol::SensorBatch batch;

        if (!parsed->chunks.empty()) {
            batch.frame_timestamp_ns =
                static_cast<uint64_t>(parsed->chunks[0].timestamp) * 1000000ULL;
        } else {
            auto now = std::chrono::steady_clock::now();
            batch.frame_timestamp_ns =
                std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch())
                    .count();
        }

        batch.sequence_id = parsed->header.timestamp & 0xFFFF;
        batch.is_valid = true;

        for (const auto& chunk : parsed->chunks) {
            for (const auto& dp : chunk.datapoints) {
                daq_comms::protocol::RawPTSample sample;
                sample.channel_id = dp.sensor_id;
                sample.raw_adc_counts = dp.data;
                sample.sample_timestamp_ms = chunk.timestamp;
                sample.status_flags = 0;
                batch.pt_samples.push_back(sample);
            }
        }

        return batch;
    }

    // Handle BOARD_HEARTBEAT packets (for board discovery + config broadcast)
    if (*packet_type == daq_comms::protocol::DiabloBoardPacketParser::PacketType::BOARD_HEARTBEAT) {
        last_heartbeat_buffer_.assign(receive_buffer_.data(), receive_buffer_.data() + received);
        last_heartbeat_source_ip_ = last_source_ip_;
        return std::nullopt;
    }

    return std::nullopt;
}

bool SensorFramePipeline::set_broadcast(bool enable) {
    if (!socket_ || !socket_->is_valid())
        return false;
    return socket_->set_broadcast(enable);
}

ssize_t SensorFramePipeline::send_to(const std::string& dest_ip, uint16_t dest_port,
                                     const uint8_t* data, size_t size) {
    if (!socket_ || !socket_->is_valid())
        return -1;
    return socket_->send_to(dest_ip, dest_port, data, size);
}

std::optional<SensorFramePipeline::LastHeartbeat> SensorFramePipeline::get_last_heartbeat() {
    if (last_heartbeat_buffer_.empty()) {
        return std::nullopt;
    }
    LastHeartbeat out;
    out.data = std::move(last_heartbeat_buffer_);
    out.source_ip = std::move(last_heartbeat_source_ip_);
    last_heartbeat_buffer_.clear();
    last_heartbeat_source_ip_.clear();
    return out;
}

bool SensorFramePipeline::is_ready() const {
    return socket_ && socket_->is_valid();
}

std::string SensorFramePipeline::last_error() const {
    return last_error_;
}

}  // namespace streams
}  // namespace fsw
