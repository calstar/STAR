#include "streams/SensorFramePipeline.hpp"

#include <chrono>
#include <cstring>
#include <iostream>

#include "DiabloEnums.h"
#include "DiabloPacketUtils.h"
#include "DiabloPackets.h"

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

    if (received < static_cast<ssize_t>(sizeof(Diablo::PacketHeader))) {
        return std::nullopt;
    }

    Diablo::PacketHeader peek{};
    std::memcpy(&peek, receive_buffer_.data(), sizeof(peek));

    if (peek.packet_type == Diablo::PacketType::SENSOR_DATA) {
        Diablo::PacketHeader sensor_header;
        std::vector<Diablo::SensorDataChunkCollection> chunks;
        if (!Diablo::parse_sensor_data_packet(receive_buffer_.data(), static_cast<size_t>(received),
                                              sensor_header, chunks)) {
            static size_t parse_fail_count = 0;
            if (++parse_fail_count <= 10 || parse_fail_count % 500 == 0) {
                std::cerr << "[Pipeline] SENSOR_DATA parse failed #" << parse_fail_count
                          << " (size=" << received << ") from " << last_source_ip_ << std::endl;
            }
            return std::nullopt;
        }

        daq_comms::protocol::SensorBatch batch;
        if (!chunks.empty()) {
            batch.frame_timestamp_ns = static_cast<uint64_t>(chunks[0].timestamp) * 1000000ULL;
        } else {
            auto now = std::chrono::steady_clock::now();
            batch.frame_timestamp_ns =
                std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch())
                    .count();
        }
        batch.sequence_id = sensor_header.timestamp & 0xFFFF;
        batch.is_valid = true;

        for (const auto& chunk : chunks) {
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

    if (peek.packet_type == Diablo::PacketType::SELF_TEST) {
        Diablo::PacketHeader st_header;
        uint8_t adc_good = 0;
        std::vector<Diablo::SelfTestResult> st_results;
        if (!Diablo::parse_self_test_packet(receive_buffer_.data(), static_cast<size_t>(received),
                                            st_header, adc_good, st_results)) {
            std::cerr << "[Pipeline] SELF_TEST parse failed from " << last_source_ip_ << std::endl;
            return std::nullopt;
        }

        daq_comms::protocol::SensorBatch batch;
        auto now = std::chrono::steady_clock::now();
        batch.frame_timestamp_ns =
            std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch()).count();
        batch.sequence_id = st_header.timestamp & 0xFFFF;
        batch.is_valid = true;

        daq_comms::protocol::ParsedSelfTestPacket parsed;
        parsed.packet_type = static_cast<uint8_t>(st_header.packet_type);
        parsed.version = st_header.version;
        parsed.timestamp = st_header.timestamp;
        parsed.adc_good = adc_good;
        parsed.num_sensors = static_cast<uint8_t>(st_results.size());
        parsed.is_valid = true;
        for (const auto& r : st_results) {
            parsed.results.push_back({r.sensor_id, r.result});
        }
        batch.self_tests.push_back(std::move(parsed));
        return batch;
    }

    if (peek.packet_type == Diablo::PacketType::BOARD_HEARTBEAT) {
        last_heartbeat_buffer_.assign(receive_buffer_.data(),
                                      receive_buffer_.data() + static_cast<size_t>(received));
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
