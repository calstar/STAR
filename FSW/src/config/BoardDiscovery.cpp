#include "config/BoardDiscovery.hpp"

#include "DiabloPacketUtils.h"
#include "DiabloPackets.h"
#include "fsw/BoardTypeWire.hpp"
#include "util/IpFromMac.hpp"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>

#include <algorithm>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <sstream>

namespace fsw {
namespace config {

BoardDiscovery::BoardDiscovery()
    : ip_range_start_(100),
      ip_range_end_(200),
      discovery_active_(false),
      current_mode_(DiscoveryMode::HYBRID) {
    stats_ = DiscoveryStats{};
}

bool BoardDiscovery::initialize(const std::string& network_interface, const std::string& base_ip,
                                uint8_t ip_range_start, uint8_t ip_range_end) {
    network_interface_ = network_interface;
    base_ip_ = base_ip;
    ip_range_start_ = ip_range_start;
    ip_range_end_ = ip_range_end;

    std::cout << "[BoardDiscovery] Initialized on interface: " << network_interface_ << std::endl;
    std::cout << "[BoardDiscovery] IP range: " << base_ip_ << "." << (int)ip_range_start_ << "-"
              << (int)ip_range_end_ << std::endl;

    return true;
}

void BoardDiscovery::set_static_ip_for_board(uint8_t board_id, const std::string& ip) {
    static_ip_overrides_[board_id] = ip;
}

void BoardDiscovery::start_discovery(DiscoveryMode mode) {
    current_mode_ = mode;
    discovery_active_ = true;

    std::cout << "[BoardDiscovery] Starting discovery (mode="
              << (mode == DiscoveryMode::PASSIVE  ? "PASSIVE"
                  : mode == DiscoveryMode::ACTIVE ? "ACTIVE"
                                                  : "HYBRID")
              << ")" << std::endl;

    if (mode == DiscoveryMode::ACTIVE || mode == DiscoveryMode::HYBRID) {
        scan_network();
    }

    if (mode == DiscoveryMode::PASSIVE || mode == DiscoveryMode::HYBRID) {
        listen_for_announcements();
    }
}

void BoardDiscovery::stop_discovery() {
    discovery_active_ = false;
    std::cout << "[BoardDiscovery] Discovery stopped" << std::endl;
}

void BoardDiscovery::process_board_announcement(const uint8_t* data, size_t size,
                                                const std::string& source_ip) {
    Diablo::PacketHeader hdr;
    Diablo::BoardHeartbeatPacket hb;
    if (!Diablo::parse_board_heartbeat_packet(data, size, hdr, hb)) {
        return;
    }

    BoardSignature signature;
    signature.board_id = static_cast<uint32_t>(hb.board_id);
    signature.board_type = daq_wire::kUnknown;
    signature.hardware_version = 0;
    signature.firmware_version = hdr.version;
    signature.serial_number = hb.board_id;

    DiscoveredBoard board;
    board.signature = signature;
    board.current_ip = source_ip;
    board.last_seen = std::chrono::steady_clock::now();
    board.is_configured = false;
    board.port = 5005;  // Default DiabloAvionics port

    // MAC address will be extracted from network layer or calculated from IP
    // For now, use IP-based hash
    std::hash<std::string> hasher;
    uint32_t ip_hash = static_cast<uint32_t>(hasher(source_ip));
    std::ostringstream mac;
    mac << std::hex << std::setw(2) << std::setfill('0') << ((ip_hash >> 16) & 0xFF) << ":"
        << std::hex << std::setw(2) << std::setfill('0') << ((ip_hash >> 8) & 0xFF) << ":"
        << std::hex << std::setw(2) << std::setfill('0') << (ip_hash & 0xFF) << ":" << std::hex
        << std::setw(2) << std::setfill('0') << ((ip_hash >> 24) & 0xFF) << ":" << std::hex
        << std::setw(2) << std::setfill('0') << ((signature.board_id >> 8) & 0xFF) << ":"
        << std::hex << std::setw(2) << std::setfill('0') << (signature.board_id & 0xFF);
    board.mac_address = mac.str();

    add_or_update_board(board);

    // Assign IP: prefer config static IP (192.168.2.21 for board_id 21) over hash-derived
    uint8_t board_id_octet = hb.board_id;
    if (signature_to_ip_.find(signature) == signature_to_ip_.end()) {
        std::string assigned_ip;
        auto it = static_ip_overrides_.find(board_id_octet);
        if (it != static_ip_overrides_.end()) {
            assigned_ip = it->second;
        } else {
            assigned_ip = util::calculate_ip_from_mac(board.mac_address, base_ip_, ip_range_start_,
                                                      ip_range_end_);
        }
        if (is_ip_available(assigned_ip)) {
            signature_to_ip_[signature] = assigned_ip;
            ip_to_signature_[assigned_ip] = signature;
            board.current_ip = assigned_ip;
            std::cout << "[BoardDiscovery] Assigned IP " << assigned_ip << " to "
                      << signature.to_string() << " (MAC: " << board.mac_address << ")"
                      << std::endl;
        }
    }

    stats_.boards_discovered++;
    stats_.last_discovery = std::chrono::steady_clock::now();

    // Notify callbacks
    for (const auto& callback : discovery_callbacks_) {
        callback(board);
    }
}

void BoardDiscovery::process_sensor_data(const uint8_t* data, size_t size,
                                         const std::string& source_ip) {
    Diablo::PacketHeader hdr;
    std::vector<Diablo::SensorDataChunkCollection> chunks;
    if (!Diablo::parse_sensor_data_packet(data, size, hdr, chunks) || chunks.empty()) {
        return;
    }

    auto it = ip_to_signature_.find(source_ip);
    uint8_t board_type_wire = daq_wire::kPressureTransducer;

    if (it != ip_to_signature_.end()) {
        board_type_wire = discovered_boards_[it->second].signature.board_type;
        if (board_type_wire == daq_wire::kUnknown) {
            board_type_wire = daq_wire::kPressureTransducer;
        }
    }

    std::map<uint8_t, bool> sensor_ids;
    for (const auto& dp : chunks[0].datapoints) {
        sensor_ids[dp.sensor_id] = (dp.data != 0);
    }
    if (sensor_ids.empty()) {
        return;
    }

    std::vector<SensorInfo> sensors;
    for (const auto& [sensor_id, is_active] : sensor_ids) {
        SensorInfo info;
        info.sensor_type = board_type_wire;
        info.channel_id = sensor_id;
        info.sensor_count = 1;
        info.is_active = is_active;
        info.quality = is_active ? 255 : 0;
        sensors.push_back(info);
    }

    if (it != ip_to_signature_.end()) {
        auto& board = discovered_boards_[it->second];
        board.sensors = sensors;
        board.active_sensors = sensors.size();
        board.last_seen = std::chrono::steady_clock::now();
        stats_.sensors_detected += sensors.size();
    } else {
        BoardSignature sig;
        std::hash<std::string> hasher;
        sig.board_id = static_cast<uint32_t>(hasher(source_ip));
        sig.board_type = board_type_wire;
        sig.hardware_version = 0;
        sig.firmware_version = 0;
        sig.serial_number = 0;

        DiscoveredBoard board;
        board.signature = sig;
        board.current_ip = source_ip;
        board.sensors = sensors;
        board.last_seen = std::chrono::steady_clock::now();
        board.is_configured = false;
        board.port = 5005;
        board.max_sensors = sensors.size();
        board.active_sensors = sensors.size();

        add_or_update_board(board);
        stats_.boards_discovered++;
    }
}

std::vector<SensorInfo> BoardDiscovery::detect_sensors_from_packet(const uint8_t* data,
                                                                   size_t size) const {
    std::vector<SensorInfo> sensors;
    Diablo::PacketHeader hdr;
    std::vector<Diablo::SensorDataChunkCollection> chunks;
    if (!Diablo::parse_sensor_data_packet(data, size, hdr, chunks) || chunks.empty()) {
        return sensors;
    }
    std::map<uint8_t, bool> sensor_ids;
    for (const auto& dp : chunks[0].datapoints) {
        sensor_ids[dp.sensor_id] = (dp.data != 0);
    }
    for (const auto& [sensor_id, is_active] : sensor_ids) {
        SensorInfo info;
        info.sensor_type = 0;
        info.channel_id = sensor_id;
        info.sensor_count = 1;
        info.is_active = is_active;
        info.quality = is_active ? 255 : 0;
        sensors.push_back(info);
    }
    return sensors;
}

BoardDiscovery::BoardType BoardDiscovery::detect_board_type(
    const std::vector<SensorInfo>& sensors) const {
    if (sensors.empty()) {
        return BoardType::UNKNOWN;
    }

    // Count sensor types
    std::map<uint8_t, size_t> type_counts;
    for (const auto& sensor : sensors) {
        type_counts[sensor.sensor_type]++;
    }

    if (type_counts.size() == 1) {
        // Single sensor type board (matching DiabloAvionics BoardType enum)
        switch (type_counts.begin()->first) {
            case 1:
                return BoardType::PT_BOARD;  // PRESSURE_TRANSDUCER = 1
            case 2:
                return BoardType::LC_BOARD;  // LOAD_CELL = 2
            case 3:
                return BoardType::RTD_BOARD;  // RTD = 3
            case 4:
                return BoardType::TC_BOARD;  // THERMOCOUPLE = 4
            case 5:
                return BoardType::MIXED_BOARD;  // ACTUATOR = 5 (repurposed)
            default:
                return BoardType::UNKNOWN;
        }
    } else {
        // Mixed sensor types
        return BoardType::MIXED_BOARD;
    }
}

std::optional<std::string> BoardDiscovery::assign_ip(const BoardSignature& signature) {
    // Calculate IP based on signature (deterministic assignment)
    std::string ip = calculate_ip_from_signature(signature);

    if (is_ip_available(ip)) {
        signature_to_ip_[signature] = ip;
        ip_to_signature_[ip] = signature;

        // Update board
        auto it = discovered_boards_.find(signature);
        if (it != discovered_boards_.end()) {
            it->second.current_ip = ip;
        }

        stats_.ip_assignments++;
        return ip;
    }

    return std::nullopt;
}

std::string BoardDiscovery::calculate_ip_from_signature(const BoardSignature& signature) const {
    // Use MAC address if available, otherwise fall back to board_id hash
    // This will be called after MAC is set in process_board_announcement
    // For now, use board_id hash (MAC-based assignment happens in process_board_announcement)
    uint32_t hash = signature.board_id;
    uint8_t ip_octet = ip_range_start_ + (hash % (ip_range_end_ - ip_range_start_ + 1));

    // Parse base IP
    size_t last_dot = base_ip_.rfind('.');
    std::string base = base_ip_.substr(0, last_dot);

    return base + "." + std::to_string(ip_octet);
}

bool BoardDiscovery::is_ip_available(const std::string& ip) const {
    // Check if IP is already assigned
    return ip_to_signature_.find(ip) == ip_to_signature_.end();
}

void BoardDiscovery::add_or_update_board(const DiscoveredBoard& board) {
    std::lock_guard<std::mutex> lock(boards_mutex_);

    auto it = discovered_boards_.find(board.signature);
    if (it == discovered_boards_.end()) {
        discovered_boards_[board.signature] = board;
    } else {
        // Update existing board
        it->second.last_seen = board.last_seen;
        if (!board.sensors.empty()) {
            it->second.sensors = board.sensors;
            it->second.active_sensors = board.sensors.size();
        }
        if (!board.current_ip.empty()) {
            it->second.current_ip = board.current_ip;
        }
    }
}

std::vector<DiscoveredBoard> BoardDiscovery::get_discovered_boards() {
    std::lock_guard<std::mutex> lock(boards_mutex_);

    std::vector<DiscoveredBoard> boards;
    for (const auto& [sig, board] : discovered_boards_) {
        boards.push_back(board);
    }
    return boards;
}

std::optional<DiscoveredBoard> BoardDiscovery::get_board_by_ip(const std::string& ip) {
    std::lock_guard<std::mutex> lock(boards_mutex_);
    auto it = ip_to_signature_.find(ip);
    if (it == ip_to_signature_.end())
        return std::nullopt;
    auto board_it = discovered_boards_.find(it->second);
    if (board_it == discovered_boards_.end())
        return std::nullopt;
    return board_it->second;
}

std::map<std::string, std::map<std::string, std::string>> BoardDiscovery::generate_config() {
    std::lock_guard<std::mutex> lock(boards_mutex_);

    std::map<std::string, std::map<std::string, std::string>> config;

    // Generate board configurations
    size_t board_idx = 0;
    for (const auto& [sig, board] : discovered_boards_) {
        std::string board_key = "board_" + std::to_string(board_idx++);
        config[board_key] = generate_board_config(board);

        // Generate sensor configs for this board
        auto sensor_config = generate_sensor_config(board.sensors);
        if (!sensor_config.empty()) {
            config[board_key + ".sensors"] = sensor_config;
        }
    }

    return config;
}

std::map<std::string, std::string> BoardDiscovery::generate_board_config(
    const DiscoveredBoard& board) const {
    std::map<std::string, std::string> config;

    config["ip"] = board.current_ip;
    config["port"] = std::to_string(board.port);
    config["mac_address"] = board.mac_address;
    config["board_id"] = "0x" + std::to_string(board.signature.board_id);
    config["board_type"] = std::to_string(board.signature.board_type);
    config["max_sensors"] = std::to_string(board.max_sensors);
    config["active_sensors"] = std::to_string(board.active_sensors);

    return config;
}

std::map<std::string, std::string> BoardDiscovery::generate_sensor_config(
    const std::vector<SensorInfo>& sensors) const {
    std::map<std::string, std::string> config;

    // Group sensors by type
    std::map<uint8_t, std::vector<SensorInfo>> sensors_by_type;
    for (const auto& sensor : sensors) {
        sensors_by_type[sensor.sensor_type].push_back(sensor);
    }

    for (const auto& [type, sensor_list] : sensors_by_type) {
        std::string type_name;
        switch (type) {
            case 0x01:
                type_name = "pt";
                break;
            case 0x02:
                type_name = "tc";
                break;
            case 0x03:
                type_name = "rtd";
                break;
            case 0x04:
                type_name = "lc";
                break;
            default:
                type_name = "unknown_" + std::to_string(type);
                break;
        }

        config[type_name + "_enabled"] = "true";
        config[type_name + "_count"] = std::to_string(sensor_list.size());

        // Generate channel list
        std::string channels;
        for (size_t i = 0; i < sensor_list.size(); ++i) {
            if (i > 0)
                channels += ",";
            channels += std::to_string(sensor_list[i].channel_id);
        }
        config[type_name + "_channels"] = channels;
    }

    return config;
}

void BoardDiscovery::scan_network() {
    // TODO: Implement active network scanning
    std::cout << "[BoardDiscovery] Scanning network..." << std::endl;
}

void BoardDiscovery::listen_for_announcements() {
    // TODO: Implement passive listening for board announcements
    std::cout << "[BoardDiscovery] Listening for board announcements..." << std::endl;
}

void BoardDiscovery::register_discovery_callback(
    std::function<void(const DiscoveredBoard&)> callback) {
    discovery_callbacks_.push_back(callback);
}

}  // namespace config
}  // namespace fsw
