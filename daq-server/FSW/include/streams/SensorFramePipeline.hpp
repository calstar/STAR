#ifndef DAQ_SENSOR_FRAME_PIPELINE_HPP
#define DAQ_SENSOR_FRAME_PIPELINE_HPP

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "../../daq_comms/include/protocol/EncryptedFrame.hpp"
#include "../../daq_comms/include/transport/NetworkSocket.hpp"

namespace fsw {
namespace streams {

/**
 * @brief UDP pipeline: DAQv2-Comms board packets → internal SensorBatch.
 */
class SensorFramePipeline {
public:
    explicit SensorFramePipeline(const std::string& bind_address, uint16_t bind_port);
    ~SensorFramePipeline() = default;

    std::optional<daq_comms::protocol::SensorBatch> poll();

    const std::string& last_source_ip() const {
        return last_source_ip_;
    }

    bool is_ready() const;
    std::string last_error() const;

    ssize_t send_to(const std::string& dest_ip, uint16_t dest_port, const uint8_t* data,
                    size_t size);

    bool set_broadcast(bool enable);

    struct LastHeartbeat {
        std::vector<uint8_t> data;
        std::string source_ip;
    };
    std::optional<LastHeartbeat> get_last_heartbeat();

private:
    std::unique_ptr<daq_comms::transport::UDPSocket> socket_;
    std::vector<uint8_t> receive_buffer_;
    std::string last_error_;
    std::string last_source_ip_;

    std::vector<uint8_t> last_heartbeat_buffer_;
    std::string last_heartbeat_source_ip_;

    static constexpr size_t RECEIVE_BUFFER_SIZE = 8192;
};

}  // namespace streams
}  // namespace fsw

#endif
