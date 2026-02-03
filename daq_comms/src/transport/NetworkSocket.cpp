#include "transport/NetworkSocket.hpp"

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <cstring>
#include <cerrno>

namespace daq_comms {
namespace transport {

// UDP Socket Implementation
UDPSocket::UDPSocket(const std::string& bind_address, uint16_t bind_port)
    : socket_fd_(-1), is_bound_(true), remote_port_(0) {
    socket_fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (socket_fd_ < 0) {
        last_error_ = "Failed to create UDP socket: " + std::string(strerror(errno));
        return;
    }

    struct sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(bind_port);
    
    if (bind_address == "0.0.0.0" || bind_address.empty()) {
        addr.sin_addr.s_addr = INADDR_ANY;
    } else {
        if (inet_aton(bind_address.c_str(), &addr.sin_addr) == 0) {
            last_error_ = "Invalid bind address: " + bind_address;
            close(socket_fd_);
            socket_fd_ = -1;
            return;
        }
    }

    if (bind(socket_fd_, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        last_error_ = "Failed to bind UDP socket: " + std::string(strerror(errno));
        close(socket_fd_);
        socket_fd_ = -1;
        return;
    }

    // Set socket to non-blocking for better control
    int flags = fcntl(socket_fd_, F_GETFL, 0);
    fcntl(socket_fd_, F_SETFL, flags | O_NONBLOCK);
}

UDPSocket::UDPSocket(const std::string& remote_address, uint16_t remote_port, bool is_sender)
    : socket_fd_(-1), is_bound_(false), remote_address_(remote_address), remote_port_(remote_port) {
    socket_fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (socket_fd_ < 0) {
        last_error_ = "Failed to create UDP socket: " + std::string(strerror(errno));
        return;
    }

    // Set socket to non-blocking
    int flags = fcntl(socket_fd_, F_GETFL, 0);
    fcntl(socket_fd_, F_SETFL, flags | O_NONBLOCK);
}

UDPSocket::~UDPSocket() {
    if (socket_fd_ >= 0) {
        close(socket_fd_);
    }
}

ssize_t UDPSocket::receive(uint8_t* buffer, size_t max_size) {
    if (socket_fd_ < 0) {
        last_error_ = "Socket not initialized";
        return -1;
    }

    ssize_t received = recvfrom(socket_fd_, buffer, max_size, 0, nullptr, nullptr);
    if (received < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return 0; // No data available (non-blocking)
        }
        last_error_ = "Receive error: " + std::string(strerror(errno));
        return -1;
    }
    return received;
}

ssize_t UDPSocket::receive_from(uint8_t* buffer, size_t max_size,
                                std::string& source_address, uint16_t& source_port) {
    if (socket_fd_ < 0) {
        last_error_ = "Socket not initialized";
        return -1;
    }

    struct sockaddr_in addr = {};
    socklen_t addr_len = sizeof(addr);
    
    ssize_t received = recvfrom(socket_fd_, buffer, max_size, 0,
                                reinterpret_cast<struct sockaddr*>(&addr), &addr_len);
    if (received < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return 0;
        }
        last_error_ = "Receive error: " + std::string(strerror(errno));
        return -1;
    }

    source_address = inet_ntoa(addr.sin_addr);
    source_port = ntohs(addr.sin_port);
    return received;
}

ssize_t UDPSocket::send(const uint8_t* data, size_t size) {
    if (socket_fd_ < 0) {
        last_error_ = "Socket not initialized";
        return -1;
    }

    if (!is_bound_ && !remote_address_.empty()) {
        // Send to specific remote address
        struct sockaddr_in addr = {};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(remote_port_);
        if (inet_aton(remote_address_.c_str(), &addr.sin_addr) == 0) {
            last_error_ = "Invalid remote address: " + remote_address_;
            return -1;
        }
        
        ssize_t sent = sendto(socket_fd_, data, size, 0,
                              reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr));
        if (sent < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                return 0;
            }
            last_error_ = "Send error: " + std::string(strerror(errno));
            return -1;
        }
        return sent;
    } else {
        // Socket is bound, use send (shouldn't happen for UDP sender)
        last_error_ = "Cannot send on bound UDP socket without destination";
        return -1;
    }
}

bool UDPSocket::is_valid() const {
    return socket_fd_ >= 0;
}

std::string UDPSocket::last_error() const {
    return last_error_;
}

// TCP Socket Implementation
TCPSocket::TCPSocket(const std::string& remote_address, uint16_t remote_port)
    : socket_fd_(-1) {
    setup_socket(remote_address, remote_port);
}

TCPSocket::~TCPSocket() {
    if (socket_fd_ >= 0) {
        close(socket_fd_);
    }
}

void TCPSocket::setup_socket(const std::string& remote_address, uint16_t remote_port) {
    socket_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_fd_ < 0) {
        last_error_ = "Failed to create TCP socket: " + std::string(strerror(errno));
        return;
    }

    struct sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(remote_port);
    
    if (inet_aton(remote_address.c_str(), &addr.sin_addr) == 0) {
        last_error_ = "Invalid remote address: " + remote_address;
        close(socket_fd_);
        socket_fd_ = -1;
        return;
    }

    if (connect(socket_fd_, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        last_error_ = "Failed to connect TCP socket: " + std::string(strerror(errno));
        close(socket_fd_);
        socket_fd_ = -1;
        return;
    }

    // Enable TCP keepalive
    int keepalive = 1;
    setsockopt(socket_fd_, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
}

ssize_t TCPSocket::receive(uint8_t* buffer, size_t max_size) {
    if (socket_fd_ < 0) {
        last_error_ = "Socket not initialized";
        return -1;
    }

    ssize_t received = recv(socket_fd_, buffer, max_size, 0);
    if (received < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return 0;
        }
        last_error_ = "Receive error: " + std::string(strerror(errno));
        return -1;
    } else if (received == 0) {
        last_error_ = "Connection closed by peer";
        return -1;
    }
    return received;
}

ssize_t TCPSocket::send(const uint8_t* data, size_t size) {
    if (socket_fd_ < 0) {
        last_error_ = "Socket not initialized";
        return -1;
    }

    ssize_t sent = ::send(socket_fd_, data, size, 0);
    if (sent < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return 0;
        }
        last_error_ = "Send error: " + std::string(strerror(errno));
        return -1;
    }
    return sent;
}

bool TCPSocket::is_valid() const {
    return socket_fd_ >= 0;
}

std::string TCPSocket::last_error() const {
    return last_error_;
}

} // namespace transport
} // namespace daq_comms

