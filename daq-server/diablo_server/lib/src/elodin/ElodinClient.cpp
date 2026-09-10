#include "elodin/ElodinClient.hpp"

#include <algorithm>
#include <cstring>
#include <iostream>

namespace fsw {
namespace elodin {

ElodinClient::ElodinClient() {
    socket_ = std::make_unique<daq_comms::transport::TCPClient>();
}

ElodinClient::~ElodinClient() {
    disconnect();
}

bool ElodinClient::connect(const std::string& host, uint16_t port) {
    std::lock_guard<std::mutex> lock(publish_mutex_);
    return connect_locked(host, port);
}

bool ElodinClient::connect_locked(const std::string& host, uint16_t port) {
    disconnect_locked();

    std::cout << "[ElodinClient] Connecting to Elodin database at " << host << ":" << port << "..."
              << std::endl;

    // Remember the target BEFORE attempting, not after succeeding. reconnect() keys off these, so
    // recording them only on success meant a service whose FIRST connect failed could never retry
    // ("No previous connection to reconnect to") and stayed dead for the life of the process.
    last_host_ = host;
    last_port_ = port;

    if (!socket_->connect(host, port)) {
        last_error_ = socket_->last_error();
        std::cerr << "[ElodinClient] ❌ Connection failed: " << last_error_ << std::endl;
        return false;
    }

    std::cout << "[ElodinClient] ✅ Connected to Elodin database at " << host << ":" << port
              << std::endl;
    return true;
}

bool ElodinClient::reconnect() {
    std::lock_guard<std::mutex> lock(publish_mutex_);
    if (last_host_.empty() || last_port_ == 0) {
        last_error_ = "No previous connection to reconnect to";
        return false;
    }
    std::cout << "[ElodinClient] Attempting reconnect to " << last_host_ << ":" << last_port_
              << "..." << std::endl;
    return connect_locked(last_host_, last_port_);
}

void ElodinClient::disconnect() {
    std::lock_guard<std::mutex> lock(publish_mutex_);
    disconnect_locked();
}

void ElodinClient::disconnect_locked() {
    if (socket_ && socket_->is_connected()) {
        std::cout << "[ElodinClient] Disconnecting from Elodin database..." << std::endl;
        socket_->flush();
        socket_->disconnect();
        std::cout << "[ElodinClient] ✅ Disconnected" << std::endl;
    }
}

bool ElodinClient::is_connected() const {
    return socket_ && socket_->is_connected();
}

void ElodinClient::register_table(const std::array<uint8_t, 2>& table_id, const std::string& name) {
    uint16_t id = (static_cast<uint16_t>(table_id[0]) << 8) | table_id[1];
    table_names_[id] = name;
}

std::string ElodinClient::last_error() const {
    return last_error_;
}

void ElodinClient::flush_buffer() {
    if (socket_ && socket_->is_connected()) {
        socket_->flush();
    }
}

void ElodinClient::set_recv_timeout_ms(int timeout_ms) {
    if (socket_)
        socket_->set_recv_timeout_ms(timeout_ms);
}

bool ElodinClient::subscribe_tables(const std::vector<std::pair<uint8_t, uint8_t>>& table_ids) {
    std::array<uint8_t, 2> msgstream_id = {0x11, 0x0d};
    bool ok = true;

    for (const auto& [hi, lo] : table_ids) {
        std::vector<uint8_t> data(10, 0x00);
        uint32_t len = 2 + 4;
        std::memcpy(data.data(), &len, 4);
        data[4] = static_cast<uint8_t>(fsw::elodin::PacketType::MSG);
        data[5] = msgstream_id[0];
        data[6] = msgstream_id[1];
        data[7] = 0x00;
        data[8] = hi;
        data[9] = lo;
        // Was fire-and-forget returning true unconditionally, which made every
        // `if (!subscribe_...())` error path in the callers dead code.
        if (!send_msg(msgstream_id, data))
            ok = false;
    }

    return ok;
}

void ElodinClient::begin_batch() {
    batching_ = true;
    batch_buffer_.clear();
    batch_buffer_.reserve(4096);  // pre-allocate ~4KB
}

bool ElodinClient::flush_batch() {
    batching_ = false;
    if (batch_buffer_.empty()) {
        return true;  // nothing to send
    }
    if (!is_connected()) {
        last_error_ = "Not connected to Elodin database";
        batch_buffer_.clear();
        return false;
    }

    std::lock_guard<std::mutex> lock(publish_mutex_);
    bool ok = socket_->write_all(batch_buffer_.data(), batch_buffer_.size());
    if (!ok) {
        last_error_ = socket_->last_error();
    }
    batch_buffer_.clear();
    return ok;
}

ssize_t ElodinClient::read_data(void* buffer, size_t max_len) {
    if (!is_connected()) {
        last_error_ = "Not connected to Elodin database";
        return -1;
    }

    std::lock_guard<std::mutex> lock(publish_mutex_);
    return socket_->read(buffer, max_len);
}

bool ElodinClient::read_packet_header(uint8_t* header_buffer) {
    if (!is_connected()) {
        last_error_ = "Not connected to Elodin database";
        return false;
    }

    std::lock_guard<std::mutex> lock(publish_mutex_);
    return socket_->read_exact(header_buffer, 8);
}

bool ElodinClient::read_bytes_exact(uint8_t* buffer, size_t len) {
    if (!is_connected()) {
        last_error_ = "Not connected to Elodin database";
        return false;
    }
    std::lock_guard<std::mutex> lock(publish_mutex_);
    return socket_->read_exact(buffer, len);
}

ssize_t ElodinClient::read_packet(uint8_t* packet_buffer, size_t max_len) {
    if (!is_connected()) {
        last_error_ = "Not connected to Elodin database";
        return -1;
    }

    if (max_len < 8) {
        last_error_ = "Buffer too small for packet header";
        return -1;
    }

    std::lock_guard<std::mutex> lock(publish_mutex_);

    // Read packet header (8 bytes)
    if (!socket_->read_exact(packet_buffer, 8)) {
        last_error_ = socket_->last_error();
        // SO_RCVTIMEO fired — yield without treating as a connection error
        if (last_error_ == "TIMEOUT")
            return 0;
        return -1;
    }

    // Header layout: len(4) | ty(1)@4 | packet_id(2 BE)@5 | request_id(1)@7. Only the length is
    // consumed — nothing here matches a reply to the request that asked for it, and the other three
    // fields were decoded into locals that were never read (GCC -Wunused-variable, cppcheck
    // unreadVariable). The layout stays documented above rather than in dead assignments.
    // memcpy, not a uint32_t* cast: packet_buffer is caller-supplied and carries no alignment
    // guarantee.
    uint32_t packet_len;
    std::memcpy(&packet_len, packet_buffer, sizeof(packet_len));

    // A malformed length is unrecoverable — there is no way to know where the next packet starts.
    if (packet_len < 4) {
        last_error_ = "Invalid packet length: " + std::to_string(packet_len);
        socket_->disconnect();
        return -1;
    }

    // Read payload (packet_len - 4 bytes)
    size_t payload_len = packet_len - 4;

    // Note the bound: this writes 8 + (packet_len - 4) = packet_len + 4 bytes, so the check has to
    // be against max_len - 4. It used to be `packet_len > max_len`, which let packet_len == max_len
    // through and overran the caller's buffer by 4 bytes (confirmed with a guard page: the kernel
    // returned EFAULT at exactly that boundary). max_len >= 8 is already guaranteed above.
    if (packet_len + 4 > max_len) {
        // Drain and skip rather than abandoning the body in the socket. The old code returned -1
        // here having consumed the 8-byte header but not the payload, so every subsequent read
        // parsed payload bytes as a header — the connection was silently and permanently dead
        // while is_connected() still reported true and the caller looped. Losing one packet is a
        // recoverable cost; losing stream framing is not.
        std::cerr << "[ElodinClient] packet " << packet_len << "B exceeds " << max_len
                  << "B buffer — skipping it" << std::endl;
        uint8_t scratch[1024];
        size_t remaining = payload_len;
        while (remaining > 0) {
            const size_t chunk = std::min(remaining, sizeof(scratch));
            if (!socket_->read_exact(scratch, chunk)) {
                // Could not resynchronize; the stream is unusable, so force a reconnect.
                last_error_ = "Failed draining oversized packet: " + socket_->last_error();
                socket_->disconnect();
                return -1;
            }
            remaining -= chunk;
        }
        last_error_ = "Skipped oversized packet: " + std::to_string(packet_len);
        return 0;  // "nothing usable this round" — what every caller already does on 0
    }

    if (payload_len > 0) {
        if (!socket_->read_exact(packet_buffer + 8, payload_len)) {
            last_error_ = socket_->last_error();
            return -1;
        }
    }

    return static_cast<ssize_t>(packet_len + 4);
}

bool ElodinClient::send_msg(const std::array<uint8_t, 2>& /* packet_id */,
                            const std::vector<uint8_t>& data) {
    if (!is_connected()) {
        last_error_ = "Not connected to Elodin database";
        return false;
    }

    std::lock_guard<std::mutex> lock(publish_mutex_);

    try {
        // Match FSW exactly: Socket::write() writes directly, no buffering
        // FSW: LocalSock->write(buf.data(), buf.size());
        // Our equivalent: write_all() which calls send() directly
        if (!socket_->write_all(data.data(), data.size())) {
            last_error_ = socket_->last_error();
            std::cerr << "[ElodinClient] ERROR: write_all failed: " << last_error_ << "\n";
            return false;
        }

        static size_t send_count = 0;
        send_count++;
        std::cout << "[ElodinClient] ✅ Sent registration message #" << send_count
                  << ", size=" << data.size() << " bytes" << std::endl;

        return true;
    } catch (const std::exception& e) {
        last_error_ = "Send MSG error: " + std::string(e.what());
        std::cerr << "[ElodinClient] ERROR sending registration: " << last_error_ << "\n";
        return false;
    }
}

}  // namespace elodin
}  // namespace fsw
