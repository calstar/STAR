#ifndef DAQ_SENSOR_FRAME_PIPELINE_HPP
#define DAQ_SENSOR_FRAME_PIPELINE_HPP

#include "protocol/EncryptedFrame.hpp"
#include "transport/NetworkSocket.hpp"
#include <memory>
#include <optional>
#include <vector>

namespace daq_comms {
namespace streams {

/**
 * @brief High-level pipeline for receiving and processing sensor frames
 * 
 * Combines transport, protocol decoding, and stream management
 * into a single easy-to-use API.
 */
class SensorFramePipeline {
public:
    /**
     * @brief Create pipeline with UDP socket for receiving frames
     * @param bind_address Address to bind UDP socket to
     * @param bind_port Port to bind UDP socket to
     */
    SensorFramePipeline(const std::string& bind_address, uint16_t bind_port);
    
    ~SensorFramePipeline() = default;

    /**
     * @brief Poll for new sensor frames
     * @return Sensor batch if a complete frame was received, empty otherwise
     */
    std::optional<protocol::SensorBatch> poll();

    /**
     * @brief Check if pipeline is ready
     */
    bool is_ready() const;

    /**
     * @brief Get last error message
     */
    std::string last_error() const;

    /**
     * @brief Get decoder statistics
     */
    protocol::FrameDecoder::Stats get_stats() const;

private:
    std::unique_ptr<transport::UDPSocket> socket_;
    protocol::FrameDecoder decoder_;
    std::vector<uint8_t> receive_buffer_;
    std::string last_error_;
    
    static constexpr size_t MAX_FRAME_SIZE = 4096;
    static constexpr size_t RECEIVE_BUFFER_SIZE = 8192;
};

} // namespace streams
} // namespace daq_comms

#endif // DAQ_SENSOR_FRAME_PIPELINE_HPP



