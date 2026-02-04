#ifndef DAQ_NETWORK_SOCKET_HPP
#define DAQ_NETWORK_SOCKET_HPP

#include <cstdint>
#include <string>

namespace daq_comms {
namespace transport {

/**
 * @brief Abstract base for network socket operations
 *
 * Provides a clean interface for UDP/TCP socket operations
 * without exposing platform-specific details.
 */
class NetworkSocket {
public:
    virtual ~NetworkSocket() = default;

    /**
     * @brief Receive data from the socket
     * @param buffer Buffer to store received data
     * @param max_size Maximum bytes to receive
     * @return Number of bytes received, or -1 on error
     */
    virtual ssize_t receive(uint8_t* buffer, size_t max_size) = 0;

    /**
     * @brief Send data through the socket
     * @param data Data to send
     * @param size Number of bytes to send
     * @return Number of bytes sent, or -1 on error
     */
    virtual ssize_t send(const uint8_t* data, size_t size) = 0;

    /**
     * @brief Check if socket is valid and ready
     */
    virtual bool is_valid() const = 0;

    /**
     * @brief Get the last error message
     */
    virtual std::string last_error() const = 0;
};

/**
 * @brief UDP socket implementation
 */
class UDPSocket : public NetworkSocket {
public:
    /**
     * @brief Create UDP socket bound to local address
     * @param bind_address Local address to bind to (e.g., "0.0.0.0")
     * @param bind_port Local port to bind to
     */
    UDPSocket(const std::string& bind_address, uint16_t bind_port);

    /**
     * @brief Create UDP socket for sending to remote address
     * @param remote_address Remote address to send to
     * @param remote_port Remote port to send to
     */
    UDPSocket(const std::string& remote_address, uint16_t remote_port, bool is_sender);

    ~UDPSocket() override;

    ssize_t receive(uint8_t* buffer, size_t max_size) override;
    ssize_t send(const uint8_t* data, size_t size) override;
    bool is_valid() const override;
    std::string last_error() const override;

    /**
     * @brief Receive with source address information
     * @param buffer Buffer to store received data
     * @param max_size Maximum bytes to receive
     * @param source_address Output parameter for source IP
     * @param source_port Output parameter for source port
     * @return Number of bytes received, or -1 on error
     */
    ssize_t receive_from(uint8_t* buffer, size_t max_size, std::string& source_address,
                         uint16_t& source_port);

private:
    int socket_fd_;
    bool is_bound_;
    std::string remote_address_;
    uint16_t remote_port_;
    std::string last_error_;

    void setup_socket();
};

/**
 * @brief TCP socket implementation (for Elodin connection)
 */
class TCPSocket : public NetworkSocket {
public:
    /**
     * @brief Create TCP socket connected to remote address
     * @param remote_address Remote address to connect to
     * @param remote_port Remote port to connect to
     */
    TCPSocket(const std::string& remote_address, uint16_t remote_port);

    ~TCPSocket() override;

    ssize_t receive(uint8_t* buffer, size_t max_size) override;
    ssize_t send(const uint8_t* data, size_t size) override;
    bool is_valid() const override;
    std::string last_error() const override;

private:
    int socket_fd_;
    std::string last_error_;

    void setup_socket(const std::string& remote_address, uint16_t remote_port);
};

}  // namespace transport
}  // namespace daq_comms

#endif  // DAQ_NETWORK_SOCKET_HPP
