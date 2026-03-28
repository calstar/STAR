#include "elodin/ElodinClient.hpp"

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
    disconnect();

    std::cout << "[ElodinClient] Connecting to Elodin database at " << host << ":" << port << "..."
              << std::endl;

    if (!socket_->connect(host, port)) {
        last_error_ = socket_->last_error();
        std::cerr << "[ElodinClient] ❌ Connection failed: " << last_error_ << std::endl;
        return false;
    }

    last_host_ = host;
    last_port_ = port;
    std::cout << "[ElodinClient] ✅ Connected to Elodin database at " << host << ":" << port
              << std::endl;
    return true;
}

bool ElodinClient::reconnect() {
    if (last_host_.empty() || last_port_ == 0) {
        last_error_ = "No previous connection to reconnect to";
        return false;
    }
    std::cout << "[ElodinClient] Attempting reconnect to " << last_host_ << ":" << last_port_
              << "..." << std::endl;
    return connect(last_host_, last_port_);
}

void ElodinClient::disconnect() {
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

bool ElodinClient::subscribe_stream() {
    // VTableStream packet: 8-byte header + 2-byte Postcard payload ([hi, lo])
    // packetId for VTableStream = FNV-1a("VTableStream") = [0x11, 0x0d]
    std::array<uint8_t, 2> msgstream_id = {0x11, 0x0d};

    auto subscribe = [&](uint8_t hi, uint8_t lo) {
        // Correct format: 8-byte header + 2-byte payload = 10 bytes total
        // len field = payload_bytes(2) + header_after_len(4) = 6
        std::vector<uint8_t> data(10, 0x00);
        uint32_t len = 2 + 4;  // 2 payload bytes + 4 (ty + packetId + requestId)
        std::memcpy(data.data(), &len, 4);
        data[4] = static_cast<uint8_t>(fsw::elodin::PacketType::MSG);
        data[5] = msgstream_id[0];
        data[6] = msgstream_id[1];
        data[7] = 0x00;
        // Postcard payload: just the 2 ID bytes, no extra padding
        data[8] = hi;
        data[9] = lo;

        send_msg(msgstream_id, data);
    };

    // Subscribe to RAW sensor VTables only — calibrated output is published by us,
    // no need to subscribe (and re-receiving our own output wastes bandwidth).
    // PT Raw (0x20, 0x01-0x0E) — channels 1-10 (LP) + 11-14 (HP)
    for (uint8_t ch = 1; ch <= 14; ++ch)
        subscribe(0x20, ch);
    // TC Raw (0x21, 0x01-0x10)
    for (uint8_t ch = 1; ch <= 0x10; ++ch)
        subscribe(0x21, ch);
    // RTD Raw (0x22, 0x01-0x10)
    for (uint8_t ch = 1; ch <= 0x10; ++ch)
        subscribe(0x22, ch);
    // LC Raw (0x23, 0x01-0x10)
    for (uint8_t ch = 1; ch <= 0x10; ++ch)
        subscribe(0x23, ch);

    return true;
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
        return -1;
    }

    // Parse header: len(4), ty(1), packet_id(2), request_id(1)
    uint32_t packet_len = *reinterpret_cast<uint32_t*>(packet_buffer);
    uint8_t packet_type = packet_buffer[4];
    uint16_t packet_id = (static_cast<uint16_t>(packet_buffer[5]) << 8) | packet_buffer[6];
    uint8_t request_id = packet_buffer[7];

    // Validate packet length (must have at least the rest of the 8-byte header)
    if (packet_len < 4 || packet_len > max_len) {
        last_error_ = "Invalid packet length: " + std::to_string(packet_len);
        return -1;
    }

    // Read payload (packet_len - 4 bytes)
    size_t payload_len = packet_len - 4;
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
