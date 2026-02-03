#ifndef DAQ_TCP_CLIENT_HPP
#define DAQ_TCP_CLIENT_HPP

#include <string>
#include <cstdint>
#include <memory>
#include <vector>
#include <mutex>

namespace daq_comms {
namespace transport {

/**
 * @brief Simple TCP client for Elodin database connection
 * 
 * Standalone implementation without FSW dependencies.
 */
class TCPClient {
public:
    TCPClient();
    ~TCPClient();

    /**
     * @brief Connect to TCP server
     * @param host Server hostname or IP address
     * @param port Server port
     * @return true if connection successful, false otherwise
     */
    bool connect(const std::string& host, uint16_t port);

    /**
     * @brief Disconnect from server
     */
    void disconnect();

    /**
     * @brief Check if connected
     */
    bool is_connected() const;

    /**
     * @brief Write data directly (for VTable registration)
     * @param data Data to write
     * @param len Length of data
     * @return true if successful
     */
    bool write_all(const void* data, size_t len);

    /**
     * @brief Write data with buffering (for data publishing)
     * @param data Data to write
     * @param len Length of data
     * @return true if successful
     */
    bool write_buffered(const void* data, size_t len);

    /**
     * @brief Flush buffered data
     */
    void flush();

    /**
     * @brief Get last error message
     */
    std::string last_error() const;

private:
    int socket_fd_;
    bool connected_;
    std::string last_error_;
    
    // Buffering for efficient writes
    static constexpr size_t BUFFER_SIZE = 8192;
    std::vector<uint8_t> write_buffer_;
    size_t buffer_pos_;
    std::mutex write_mutex_;
    
    bool _write_all(const void* data, size_t len);
    void _flush_buffer();
};

} // namespace transport
} // namespace daq_comms

#endif // DAQ_TCP_CLIENT_HPP



