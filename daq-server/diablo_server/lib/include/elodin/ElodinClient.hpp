#ifndef DAQ_ELODIN_CLIENT_HPP
#define DAQ_ELODIN_CLIENT_HPP

#include <arpa/inet.h>  // for htonl

#include <array>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "ElodinProtocol.hpp"
#include "comms/CommsMessage.hpp"
#include "transport/TCPClient.hpp"

namespace fsw {
namespace elodin {

/**
 * @brief Standalone Elodin database client
 *
 * No FSW dependencies - uses our own TCP client and protocol implementation.
 */
class ElodinClient {
public:
    ElodinClient();
    ~ElodinClient();

    /**
     * @brief Connect to Elodin database
     * @param host Database host address
     * @param port Database port (default 2240)
     * @return true if connection successful, false otherwise
     */
    bool connect(const std::string& host, uint16_t port = 2240);

    /**
     * @brief Disconnect from database
     */
    void disconnect();

    /**
     * @brief Check if connected
     */
    bool is_connected() const;

    /**
     * @brief Publish a message to a table
     * @tparam MessageType CommsMessage type
     * @param table_id Table identifier (2-byte array)
     * @param message Message to publish
     * @return true if published successfully
     */
    template <typename MessageType>
    bool publish(uint16_t message_id, const MessageType& message);

    // Legacy overload for array-based packet_id (converts to uint16_t)
    template <typename MessageType>
    bool publish(const std::array<uint8_t, 2>& table_id, const MessageType& message) {
        uint16_t msg_id = (static_cast<uint16_t>(table_id[0]) << 8) | table_id[1];
        return publish(msg_id, message);
    }

    /**
     * @brief Subscribe to all stream data from Elodin (sends a StreamFilter MSG).
     */
    bool subscribe_stream();

    /**
     * @brief Subscribe to specific tables by ID.
     * @param table_ids Vector of (hi, lo) byte pairs identifying each table.
     * @return true if all subscribe messages were sent.
     */
    bool subscribe_tables(const std::vector<std::pair<uint8_t, uint8_t>>& table_ids);

    /**
     * @brief Begin batching — subsequent publish() calls go into an internal buffer.
     * Call flush_batch() to send everything in one TCP write.
     */
    void begin_batch();

    /**
     * @brief Flush (send) the accumulated batch in a single TCP write.
     * @return true if the write succeeded (or batch was empty).
     */
    bool flush_batch();

    /**
     * @brief Returns true if we're between begin_batch() and flush_batch().
     */
    bool is_batching() const {
        return batching_;
    }

    /**
     * @brief Attempt to reconnect using the last-used host/port.
     * @return true if reconnect succeeds.
     */
    bool reconnect();

    /**
     * @brief Register a table ID with a name (for debugging/logging)
     */
    void register_table(const std::array<uint8_t, 2>& table_id, const std::string& name);

    /**
     * @brief Send a MSG packet (for VTable registration, etc.)
     * @param packet_id Packet identifier (2-byte array)
     * @param data Raw message data (already encoded with PacketHeader)
     * @return true if sent successfully
     */
    bool send_msg(const std::array<uint8_t, 2>& packet_id, const std::vector<uint8_t>& data);

    /**
     * @brief Get last error message
     */
    std::string last_error() const;

    /**
     * @brief Flush the write buffer to the database
     */
    void flush_buffer();

    /**
     * @brief Set socket receive timeout so read_packet() can yield.
     * 0 = blocking (default). Call after connect().
     */
    void set_recv_timeout_ms(int timeout_ms);

    /**
     * @brief Read incoming data packet from Elodin (non-blocking)
     * @param buffer Buffer to read into
     * @param max_len Maximum bytes to read
     * @return Number of bytes read, 0 if no data available, -1 on error
     */
    ssize_t read_data(void* buffer, size_t max_len);

    /**
     * @brief Read packet header from Elodin (12 bytes)
     * @param header_buffer Buffer to read header into (must be at least 12 bytes)
     * @return true if header read successfully, false otherwise
     */
    bool read_packet_header(uint8_t* header_buffer);

    /**
     * @brief Blocking read of exactly len bytes (for payload reads after header).
     * Unlike read_data (non-blocking), this waits until all bytes arrive.
     * Use after read_packet_header to avoid packet misalignment.
     * @return true if all bytes were read, false on error or disconnect
     */
    bool read_bytes_exact(uint8_t* buffer, size_t len);

    /**
     * @brief Read complete packet from Elodin (header + payload)
     * @param packet_buffer Buffer to read packet into
     * @param max_len Maximum buffer size
     * @return Packet length if successful, 0 if no data, -1 on error
     */
    ssize_t read_packet(uint8_t* packet_buffer, size_t max_len);

    /**
     * @brief Serialize a message for Elodin (public for testing)
     */
    template <typename MessageType>
    std::vector<uint8_t> serialize_msg(uint16_t message_id, const MessageType& msg);

private:
    std::unique_ptr<daq_comms::transport::TCPClient> socket_;
    std::mutex publish_mutex_;
    std::unordered_map<uint16_t, std::string> table_names_;
    std::string last_error_;

    // Batch accumulation buffer
    bool batching_ = false;
    std::vector<uint8_t> batch_buffer_;

    // For reconnection
    std::string last_host_;
    uint16_t last_port_ = 0;
};

// Convert uint16_t message_id to array<uint8_t, 2> for Elodin protocol
inline std::array<uint8_t, 2> message_id_to_packet_id(uint16_t message_id) {
    return {static_cast<uint8_t>((message_id >> 8) & 0xFF),
            static_cast<uint8_t>(message_id & 0xFF)};
}

// Helper function matching serialize_msg pattern
// CRITICAL: FSW uses NESTED MessageFactory structure:
//   Header = MessageFactory<len, type, packet_id, request_id>
//   ElodinMsg = MessageFactory<header, body>
// When serialized, MessageFactory does memcpy of fields in order (no byte order conversion!)
template <typename MessageType>
std::vector<uint8_t> ElodinClient::serialize_msg(uint16_t message_id, const MessageType& msg) {
    std::array<uint8_t, 2> packet_id = message_id_to_packet_id(message_id);
    constexpr size_t msg_size = MessageSize<MessageType>::value;

    // Match FSW's serialize_msg() EXACTLY:
    // Header: len (uint32_t), type (PacketType), packet_id (array<uint8_t,2>), request_id (uint8_t)
    // ElodinMsg: header (Header), body (MessageType)
    //
    // FSW's MessageFactory serialization just does memcpy of fields in order
    // NO network byte order conversion happens - Elodin expects host byte order!

    using Header =
        comms::CommsMessage<uint32_t,    // len (4 bytes) - NOT converted to network byte order!
                            PacketType,  // type (1 byte)
                            std::array<uint8_t, 2>,  // packet_id (2 bytes)
                            uint8_t>;                // request_id (1 byte)

    using ElodinMsg = comms::CommsMessage<Header, MessageType>;

    // Construct header: len = msg_size + 4 (matching FSW: msg.nbytes() + 4)
    // The +4 accounts for: type(1) + packet_id(2) + request_id(1)
    // The len field itself (4 bytes) is NOT included in this calculation
    // FSW uses PacketType::TABLE for data messages - match exactly
    Header header(msg_size + 4, PacketType::TABLE, packet_id, 0);

    // Construct nested message (matching FSW's ElodinMsg(header, msg))
    ElodinMsg elodin_msg(header, msg);

    // Serialize the nested structure (CommsMessage recursively serializes Header, then Body)
    // FSW's MessageFactory serialization uses Serializer::write() which does memcpy (host byte
    // order) Elodin expects host byte order (matching FSW's behavior) - NO network byte order
    // conversion!
    constexpr size_t header_size = 8;  // len(4) + ty(1) + id(2) + req(1)
    std::vector<uint8_t> result(header_size + msg_size);
    elodin_msg.serialize(reinterpret_cast<uint8_t*>(result.data()));

    // FSW's MessageFactory does memcpy (host byte order) and Elodin accepts it
    // So we should NOT convert to network byte order - send as-is!

    return result;
}

// Template implementation for publishing
template <typename MessageType>
bool ElodinClient::publish(uint16_t message_id, const MessageType& message) {
    if (!is_connected()) {
        last_error_ = "Not connected to Elodin database";
        return false;
    }

    std::lock_guard<std::mutex> lock(publish_mutex_);

    try {
        auto buf = serialize_msg(message_id, message);

        if (batching_) {
            // Append to batch buffer — will be flushed in flush_batch()
            batch_buffer_.insert(batch_buffer_.end(), buf.begin(), buf.end());
            return true;
        }

        // Direct write (non-batched path)
        if (!socket_->write_all(buf.data(), buf.size())) {
            last_error_ = socket_->last_error();
            return false;
        }

        return true;
    } catch (const std::exception& e) {
        last_error_ = "Publish error: " + std::string(e.what());
        return false;
    }
}

}  // namespace elodin
}  // namespace fsw

#endif  // DAQ_ELODIN_CLIENT_HPP
