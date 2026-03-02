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

    // TCP keepalive
    int keepalive = 1;
    setsockopt(socket_fd_, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));

    // TCP_NODELAY — send immediately, no Nagle buffering
    int nodelay = 1;
    setsockopt(socket_fd_, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

    // Large send buffer (1 MB) — gives headroom before backpressure
    int sndbuf = 1024 * 1024;
    setsockopt(socket_fd_, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));

    // Write timeout 5s — avoid dropping batches on brief backpressure; drain in daq_bridge keeps
    // recv side clear
    struct timeval tv;
    tv.tv_sec = 5;
    tv.tv_usec = 0;
    setsockopt(socket_fd_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

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
        do {
            sent = ::write(socket_fd_, bytes + total_sent, len - total_sent);
        } while (sent < 0 && errno == EINTR);

        if (sent < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                // SO_SNDTIMEO fired — Elodin is backpressuring.
                // Drop this write rather than blocking the UDP pipeline.
                last_error_ = "Write timeout (backpressure)";
                return false;
            }
            last_error_ = "Write failed: " + std::string(strerror(errno));
            connected_ = false;  // Mark dead so main loop can reconnect
            return false;
        }
        if (sent == 0) {
            last_error_ = "Connection closed by peer";
            connected_ = false;
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

ssize_t TCPClient::read(void* buffer, size_t max_len) {
    if (!connected_) {
        last_error_ = "Not connected";
        return -1;
    }

    // Set socket to non-blocking for this read
    int flags = fcntl(socket_fd_, F_GETFL, 0);
    fcntl(socket_fd_, F_SETFL, flags | O_NONBLOCK);

    ssize_t received = ::read(socket_fd_, buffer, max_len);

    // Restore blocking mode
    fcntl(socket_fd_, F_SETFL, flags);

    if (received < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return 0;  // No data available (non-blocking)
        }
        last_error_ = "Read failed: " + std::string(strerror(errno));
        return -1;
    }

    return received;
}

bool TCPClient::read_exact(void* buffer, size_t len) {
    if (!connected_) {
        last_error_ = "Not connected";
        return false;
    }

    // Match external FSW Socket::read() - reads exactly len bytes (blocking)
    uint8_t* ptr = static_cast<uint8_t*>(buffer);
    size_t remaining = len;

    while (remaining > 0) {
        ssize_t r = ::read(socket_fd_, ptr, remaining);
        if (r < 0) {
            if (errno == EINTR) {
                continue;  // Retry on interrupt
            }
            last_error_ = "Read failed: " + std::string(strerror(errno));
            return false;
        } else if (r == 0) {
            last_error_ = "Socket closed unexpectedly";
            return false;
        }
        ptr += r;
        remaining -= r;
    }

    return true;
}

}  // namespace transport
}  // namespace daq_comms
