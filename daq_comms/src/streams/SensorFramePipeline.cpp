#include "streams/SensorFramePipeline.hpp"

#include <iostream>
#include <chrono>

namespace daq_comms {
namespace streams {

SensorFramePipeline::SensorFramePipeline(const std::string& bind_address, uint16_t bind_port)
    : receive_buffer_(RECEIVE_BUFFER_SIZE) {
    socket_ = std::make_unique<transport::UDPSocket>(bind_address, bind_port);
    
    if (!socket_->is_valid()) {
        last_error_ = "Failed to create UDP socket: " + socket_->last_error();
    }
}

std::optional<protocol::SensorBatch> SensorFramePipeline::poll() {
    if (!socket_->is_valid()) {
        last_error_ = "Socket not valid: " + socket_->last_error();
        return std::nullopt;
    }

    // Receive raw bytes
    ssize_t received = socket_->receive(receive_buffer_.data(), receive_buffer_.size());
    if (received <= 0) {
        return std::nullopt; // No data available (non-blocking)
    }
    
    // Debug: log first few packets received
    static size_t packet_count = 0;
    if (packet_count < 5) {
        std::cout << "[Pipeline] Received packet " << (packet_count + 1) 
                  << ", size: " << received << " bytes\n";
        packet_count++;
    }

    // Get receive timestamp
    auto now = std::chrono::steady_clock::now();
    auto duration = now.time_since_epoch();
    uint64_t receive_timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();

    // Decode frame
    auto frame = decoder_.decode_frame(receive_buffer_.data(), received);
    if (!frame.has_value()) {
        return std::nullopt;
    }

    // Set receive timestamp
    frame.value().receive_timestamp_ns = receive_timestamp_ns;

    // Unpack payload into sensor samples
    auto batch = decoder_.unpack_payload(frame.value());
    if (!batch.has_value()) {
        return std::nullopt;
    }

    // Set frame timestamp in batch
    batch.value().frame_timestamp_ns = receive_timestamp_ns;

    return batch;
}

bool SensorFramePipeline::is_ready() const {
    return socket_ && socket_->is_valid();
}

std::string SensorFramePipeline::last_error() const {
    return last_error_;
}

protocol::FrameDecoder::Stats SensorFramePipeline::get_stats() const {
    return decoder_.get_stats();
}

} // namespace streams
} // namespace daq_comms

