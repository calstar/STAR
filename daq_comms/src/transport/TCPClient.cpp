#include "transport/TCPClient.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <iostream>

namespace daq_comms {
namespace transport {

TCPClient::TCPClient() : socket_fd_(-1), connected_(false), buffer_pos_(0) {
    write_buffer_.reserve(BUFFER_SIZE);
}

TCPClient::~TCPClient() {
    disconnect();
}

bool TCPClient::connect(const std::string& host, uint16_t port) {
    disconnect();

    socket_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_fd_ < 0) {
        last_error_ = "Failed to create socket: " + std::string(strerror(errno));
        return false;
    }

    struct sockaddr_in server_addr = {};
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(port);

    if (inet_aton(host.c_str(), &server_addr.sin_addr) == 0) {
        last_error_ = "Invalid host address: " + host;
        ::close(socket_fd_);
        socket_fd_ = -1;
        return false;
    }

    // Enable TCP keepalive
    int keepalive = 1;
    setsockopt(socket_fd_, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));

    // Disable Nagle's algorithm (TCP_NODELAY) to send messages immediately
    // This matches FSW's behavior and ensures messages are sent without delay
    int nodelay = 1;
    setsockopt(socket_fd_, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

    if (::connect(socket_fd_, reinterpret_cast<struct sockaddr*>(&server_addr),
                  sizeof(server_addr)) < 0) {
        last_error_ = "Failed to connect: " + std::string(strerror(errno));
        ::close(socket_fd_);
        socket_fd_ = -1;
        return false;
    }

    connected_ = true;
    buffer_pos_ = 0;
    return true;
}

void TCPClient::disconnect() {
    if (connected_) {
        flush();
        ::close(socket_fd_);
        socket_fd_ = -1;
        connected_ = false;
    }
}

bool TCPClient::is_connected() const {
    return connected_;
}

bool TCPClient::write_all(const void* data, size_t len) {
    if (!connected_) {
        last_error_ = "Not connected";
        return false;
    }

    std::lock_guard<std::mutex> lock(write_mutex_);
    return _write_all(data, len);
}

bool TCPClient::write_buffered(const void* data, size_t len) {
    if (!connected_) {
        last_error_ = "Not connected";
        return false;
    }

    std::lock_guard<std::mutex> lock(write_mutex_);

    const uint8_t* bytes = static_cast<const uint8_t*>(data);
    size_t remaining = len;

    while (remaining > 0) {
        size_t available = BUFFER_SIZE - buffer_pos_;
        size_t to_copy = (remaining < available) ? remaining : available;

        std::memcpy(write_buffer_.data() + buffer_pos_, bytes, to_copy);
        buffer_pos_ += to_copy;
        bytes += to_copy;
        remaining -= to_copy;

        // Auto-flush when buffer is 80% full
        if (buffer_pos_ >= (BUFFER_SIZE * 8 / 10)) {
            _flush_buffer();
        }
    }

    return true;
}

void TCPClient::flush() {
    if (!connected_) {
        return;
    }

    std::lock_guard<std::mutex> lock(write_mutex_);
    _flush_buffer();
}

std::string TCPClient::last_error() const {
    return last_error_;
}

bool TCPClient::_write_all(const void* data, size_t len) {
    const uint8_t* bytes = static_cast<const uint8_t*>(data);
    size_t total_sent = 0;

    while (total_sent < len) {
        ssize_t sent = 0;
        // Handle EINTR (interrupted system call) - retry automatically (matching FSW's
        // Socket::write) CRITICAL: Use ::write() instead of ::send() to match FSW exactly!
        do {
            sent = ::write(socket_fd_, bytes + total_sent, len - total_sent);
        } while (sent < 0 && errno == EINTR);

        if (sent < 0) {
            // EAGAIN/EWOULDBLOCK shouldn't happen on blocking socket, but handle gracefully
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                continue;
            }
            last_error_ = "Write failed: " + std::string(strerror(errno));
            std::cerr << "[TCPClient] ERROR: send() failed: " << last_error_
                      << " (sent=" << total_sent << "/" << len << ")\n";
            return false;
        }
        if (sent == 0) {
            last_error_ = "Write failed: Connection closed by peer";
            std::cerr << "[TCPClient] ERROR: Connection closed (sent=" << total_sent << "/" << len
                      << ")\n";
            return false;
        }
        total_sent += sent;
    }

    return true;
}

void TCPClient::_flush_buffer() {
    if (buffer_pos_ > 0) {
        _write_all(write_buffer_.data(), buffer_pos_);
        buffer_pos_ = 0;
    }
}

}  // namespace transport
}  // namespace daq_comms
