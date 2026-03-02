#ifndef DAQ_SENSOR_FRAME_PIPELINE_HPP
#define DAQ_SENSOR_FRAME_PIPELINE_HPP

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "../../daq_comms/include/protocol/DiabloBoardPacketParser.hpp"
#include "../../daq_comms/include/protocol/EncryptedFrame.hpp"
#include "../../daq_comms/include/transport/NetworkSocket.hpp"

namespace fsw {
namespace streams {

/**
 * @brief High-level pipeline for receiving and processing actual DiabloAvionics board packets
 *
 * Receives actual DiabloAvionics board packet format (6-byte header, simple body)
 * over Ethernet (UDP) and converts to internal SensorBatch format for routing to Elodin.
 */
class SensorFramePipeline {
public:
    /**
     * @brief Create pipeline with UDP socket for receiving DiabloAvionics board packets
     * @param bind_address Address to bind UDP socket to
     * @param bind_port Port to bind UDP socket to
     */
    SensorFramePipeline(const std::string& bind_address, uint16_t bind_port);

    ~SensorFramePipeline() = default;

    /**
     * @brief Poll for new DiabloAvionics board packets
     * @return Sensor batch if a SENSOR_DATA packet was received, empty otherwise
     */
    std::optional<daq_comms::protocol::SensorBatch> poll();

    /**
     * @brief Get the source IP of the last received packet
     */
    const std::string& last_source_ip() const {
        return last_source_ip_;
    }

    /**
     * @brief Check if pipeline is ready
     */
    bool is_ready() const;

    /**
     * @brief Get last error message
     */
    std::string last_error() const;

    /**
     * @brief Get board packet parser (for accessing parsed packets)
     */
    daq_comms::protocol::DiabloBoardPacketParser& get_parser() {
        return board_parser_;
    }

    /**
     * @brief Enable broadcast and send packet to destination (e.g. SERVER_HEARTBEAT to
     * 255.255.255.255)
     */
    ssize_t send_to(const std::string& dest_ip, uint16_t dest_port, const uint8_t* data,
                    size_t size);

    /** @brief Enable SO_BROADCAST on the socket (required for sending to 255.255.255.255) */
    bool set_broadcast(bool enable);

    /**
     * @brief Last received BOARD_HEARTBEAT packet (valid only after poll() returned nullopt)
     * @return Packet data and source IP if last packet was a heartbeat, empty otherwise
     */
    struct LastHeartbeat {
        std::vector<uint8_t> data;
        std::string source_ip;
    };
    std::optional<LastHeartbeat> get_last_heartbeat();

private:
    std::unique_ptr<daq_comms::transport::UDPSocket> socket_;
    daq_comms::protocol::DiabloBoardPacketParser
        board_parser_;  // Actual DiabloAvionics board parser
    std::vector<uint8_t> receive_buffer_;
    std::string last_error_;
    std::string last_source_ip_;

    // When last poll() received a BOARD_HEARTBEAT, copy for main loop to process
    std::vector<uint8_t> last_heartbeat_buffer_;
    std::string last_heartbeat_source_ip_;

    static constexpr size_t MAX_PACKET_SIZE =
        512;  // DiabloAvionics max packet size (from DAQv2-Comms.h)
    static constexpr size_t RECEIVE_BUFFER_SIZE = 8192;
};

}  // namespace streams
}  // namespace fsw

#endif  // DAQ_SENSOR_FRAME_PIPELINE_HPP
