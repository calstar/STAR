/******************************************************************************
 * @file        TCPSocket.hpp
 * @date        February 1 2025
 * @brief       TCPSocket implementation; taken from elodin example code
 ******************************************************************************/
#ifndef _TCPSOCKET_H_
#define _TCPSOCKET_H_

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <iostream>
#include <mutex>
#include <system_error>

#ifdef CICD_TEST

class DummySocket {
public:
    DummySocket(const std::string &ip, uint16_t port) {
        std::cout << "[DummySocket] Pretending to connect to " << ip << ":" << port << "\n";
    }
    void write_all_elodin(const void *data, size_t len) {
        std::cout << "[DummySocket] Simulating write of " << len << " bytes.\n";
    }

    int write_all(const void *data, size_t len, std::string msg) {
        std::clog << "[DummySocket] writing: " << msg << std::endl;
        return static_cast<int>(len);
    }

private:
    // dummy implementation
    int _write_all(const void *data, size_t len) {
        std::cout << "[DummySocket] Simulating write of " << len << " bytes.\n";
        return static_cast<int>(len);
    }
};

#define Socket DummySocket

#else

class Socket {
public:
    Socket(const char *ip, uint16_t port, size_t elodin_buf_cap = DEFAULT_ELODIN_BUF_CAP) {
        ELODIN_BUF_CAP = elodin_buf_cap;
        _elodin_buf = nullptr;  // Initialize to null first

        // Validate buffer size
        if (ELODIN_BUF_CAP == 0) {
            throw std::invalid_argument("Buffer capacity cannot be zero");
        }

        _elodin_buf = new uint8_t[ELODIN_BUF_CAP];
        if (!_elodin_buf) {
            throw std::bad_alloc();  // This should not happen with new, but be explicit
        }

        fd_ = socket(AF_INET, SOCK_STREAM, 0);
        if (fd_ < 0) {
            delete[] _elodin_buf;
            _elodin_buf = nullptr;
            throw std::system_error(errno, std::generic_category(), "Failed to create socket");
        }
        struct sockaddr_in server_addr = {};
        server_addr.sin_family = AF_INET;
        server_addr.sin_port = htons(port);
        server_addr.sin_addr.s_addr = inet_addr(ip);

        // Enable TCP keepalive to detect dead connections
        int keepalive = 1;
        if (setsockopt(fd_, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive)) < 0) {
            std::cerr << "Warning: Failed to enable TCP keepalive" << std::endl;
        }

// Set keepalive parameters (Linux-specific)
#ifdef __linux__
        int keepidle = 60;   // Start keepalive after 60 seconds of inactivity
        int keepintvl = 10;  // Send keepalive every 10 seconds
        int keepcnt = 3;     // Give up after 3 failed keepalive attempts

        setsockopt(fd_, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
        setsockopt(fd_, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
        setsockopt(fd_, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));
#endif

        // Set socket to non-blocking for better error detection
        // int flags = fcntl(fd_, F_GETFL, 0);
        // fcntl(fd_, F_SETFL, flags | O_NONBLOCK);

        if (::connect(fd_, reinterpret_cast<struct sockaddr *>(&server_addr), sizeof(server_addr)) <
            0) {
            int err = errno;
            delete[] _elodin_buf;
            _elodin_buf = nullptr;
            throw std::system_error(err, std::generic_category(),
                                    "Failed to connect " + std::string(strerror(err)));
        }
    }

    ~Socket() {
        if (fd_ >= 0) {
            close(fd_);
        }
        delete[] _elodin_buf;
        _elodin_buf = nullptr;  // Set to null to catch use-after-destruction
    }

    void write_all_elodin(const void *data, size_t len) {
        std::lock_guard<std::mutex> lock(buffer_mutex_);  // Thread safety
        const uint8_t *src = static_cast<const uint8_t *>(data);

        // Add safety check for null buffer
        if (!_elodin_buf) {
            throw std::runtime_error(
                "Socket buffer is null - socket may not be properly initialized");
        }

        while (len > 0) {
            size_t space_left = ELODIN_BUF_CAP - _elodin_buf_used;
            if (space_left == 0) {
                flush_elodin_unsafe();  // Call unsafe version since we already have the lock
                space_left = ELODIN_BUF_CAP;
            }

            size_t to_copy = std::min(len, space_left);
            // memcpy fast :<
            std::memcpy(_elodin_buf + _elodin_buf_used, src, to_copy);

            _elodin_buf_used += to_copy;
            src += to_copy;
            len -= to_copy;
        }
    }

    void flush_elodin() {
        std::lock_guard<std::mutex> lock(buffer_mutex_);  // Thread safety
        flush_elodin_unsafe();
    }

    /**
     * @note Reads exactly len bytes
     */
    void read(void *buffer, size_t len) {
        auto ptr = static_cast<uint8_t *>(buffer);
        size_t remaining = len;
        while (remaining > 0) {
            ssize_t r = ::read(fd_, ptr, remaining);
            if (r < 0) {
                throw std::system_error(errno, std::generic_category(), "Failed to read");
            } else if (r == 0) {
                throw std::runtime_error("Socket closed unexpectedly");
            }
            ptr += r;
            remaining -= r;
        }
    }

    void write_all(const void *data, size_t len, std::string msg) {
        std::clog << "Writing :" << msg << std::endl;
        _write_all(data, len);
    }

    /**
     * Overloaded write_all function that doesn't print a message
     */
    void write_all(const void *data, size_t len) {
        _write_all(data, len);
    }

private:
    void _write_all(const void *data, size_t len) {
        auto ptr = static_cast<const uint8_t *>(data);
        auto remaining = len;

        while (remaining > 0) {
            auto written = write(fd_, ptr, remaining);
            if (written < 0) {
                throw std::system_error(errno, std::generic_category(), "Failed to write");
            }
            ptr += written;
            remaining -= written;
        }
    }

    void flush_elodin_unsafe() {
        write_all(_elodin_buf, _elodin_buf_used);
        _elodin_buf_used = 0;
    }

    int fd_ = -1;

    // Default buffer size of 1024 bytes, can be overridden in constructor
    static constexpr size_t DEFAULT_ELODIN_BUF_CAP = 1024;
    size_t ELODIN_BUF_CAP;
    uint8_t *_elodin_buf;
    size_t _elodin_buf_used = 0;
    std::mutex buffer_mutex_;
};

#endif  // CICD_TEST

#endif  // _TCPSOCKET_H
