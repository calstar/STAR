#ifndef DAQ_BOARD_DISCOVERY_HPP
#define DAQ_BOARD_DISCOVERY_HPP

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace fsw {
namespace config {

/**
 * @brief Board signature/identifier structure
 *
 * Each board has a unique signature used for identification and IP assignment
 */
struct BoardSignature {
    uint32_t board_id;         // Unique board ID (MAC address hash or serial number)
    uint8_t board_type;        // Board type (PT, TC, RTD, LC, etc.)
    uint8_t hardware_version;  // Hardware revision
    uint8_t firmware_version;  // Firmware version
    uint16_t serial_number;    // Board serial number

    // Comparison operators for map/set usage
    bool operator<(const BoardSignature& other) const {
        if (board_id != other.board_id)
            return board_id < other.board_id;
        if (board_type != other.board_type)
            return board_type < other.board_type;
        return serial_number < other.serial_number;
    }

    bool operator==(const BoardSignature& other) const {
        return board_id == other.board_id && board_type == other.board_type &&
               hardware_version == other.hardware_version &&
               firmware_version == other.firmware_version && serial_number == other.serial_number;
    }

    // Convert to string for logging
    std::string to_string() const {
        return "Board{id=0x" + std::to_string(board_id) + ", type=" + std::to_string(board_type) +
               ", hw=" + std::to_string(hardware_version) +
               ", fw=" + std::to_string(firmware_version) +
               ", sn=" + std::to_string(serial_number) + "}";
    }
};

/**
 * @brief Detected sensor information from board
 */
struct SensorInfo {
    uint8_t sensor_type;   // Sensor type (PT, TC, RTD, LC)
    uint8_t channel_id;    // Channel ID on board
    uint8_t sensor_count;  // Number of sensors of this type
    bool is_active;        // Whether sensor is currently active
    uint8_t quality;       // Data quality (0-255)
    std::string location;  // Physical location (if known)
};

/**
 * @brief Discovered board information
 */
struct DiscoveredBoard {
    BoardSignature signature;
    std::string current_ip;           // Current IP address (if assigned)
    std::string mac_address;          // MAC address
    std::vector<SensorInfo> sensors;  // Detected sensors
    std::chrono::steady_clock::time_point last_seen;
    bool is_configured;  // Whether board has been configured
    uint16_t port;       // Communication port

    // Board capabilities
    uint8_t max_sensors;           // Maximum sensors board supports
    uint8_t active_sensors;        // Currently active sensors
    bool supports_dynamic_config;  // Can board accept config updates?
};

/**
 * @brief Board Discovery and Configuration Manager
 *
 * Discovers boards on the network, detects sensors, and assigns IP addresses
 * based on board signatures. Automatically updates configuration based on
 * discovered hardware.
 */
class BoardDiscovery {
public:
    // Board types (matching sensor types)
    enum class BoardType : uint8_t {
        PT_BOARD = 0x01,
        TC_BOARD = 0x02,
        RTD_BOARD = 0x03,
        LC_BOARD = 0x04,
        MIXED_BOARD = 0x05,  // Board with multiple sensor types
        UNKNOWN = 0xFF
    };

    // Discovery modes
    enum class DiscoveryMode {
        PASSIVE,  // Listen for board announcements
        ACTIVE,   // Actively scan network
        HYBRID    // Both passive and active
    };

    BoardDiscovery();
    ~BoardDiscovery() = default;

    /**
     * @brief Initialize discovery system
     * @param network_interface Network interface to use (e.g., "eth0", "wlan0")
     * @param base_ip Base IP address for assignment (e.g., "192.168.1.0")
     * @param ip_range_start Starting IP in range (e.g., 100)
     * @param ip_range_end Ending IP in range (e.g., 200)
     */
    bool initialize(const std::string& network_interface, const std::string& base_ip,
                    uint8_t ip_range_start = 100, uint8_t ip_range_end = 200);

    /**
     * @brief Set static IP for board_id (from config). Overrides hash-based assignment.
     * E.g. set_static_ip_for_board(21, "192.168.2.21") so pt_board uses canonical IP.
     */
    void set_static_ip_for_board(uint8_t board_id, const std::string& ip);

    /**
     * @brief Start discovery process
     * @param mode Discovery mode to use
     */
    void start_discovery(DiscoveryMode mode = DiscoveryMode::HYBRID);

    /**
     * @brief Stop discovery process
     */
    void stop_discovery();

    /**
     * @brief Process incoming board announcement packet
     * @param data Packet data
     * @param size Packet size
     * @param source_ip Source IP address
     */
    void process_board_announcement(const uint8_t* data, size_t size, const std::string& source_ip);

    /**
     * @brief Process sensor data packet to detect sensors
     * @param data Packet data
     * @param size Packet size
     * @param source_ip Source IP address
     */
    void process_sensor_data(const uint8_t* data, size_t size, const std::string& source_ip);

    /**
     * @brief Get all discovered boards
     */
    std::vector<DiscoveredBoard> get_discovered_boards();

    /**
     * @brief Get board by signature
     */
    std::optional<DiscoveredBoard> get_board(const BoardSignature& signature);

    /**
     * @brief Get board by IP address
     */
    std::optional<DiscoveredBoard> get_board_by_ip(const std::string& ip);

    /**
     * @brief Assign IP address to board based on signature
     * @param signature Board signature
     * @return Assigned IP address, or empty if assignment failed
     */
    std::optional<std::string> assign_ip(const BoardSignature& signature);

    /**
     * @brief Generate configuration from discovered boards
     * @return Configuration map ready to be written to TOML
     */
    std::map<std::string, std::map<std::string, std::string>> generate_config();

    /**
     * @brief Update configuration file with discovered boards
     * @param config_path Path to config file
     * @return true if update successful
     */
    bool update_config_file(const std::string& config_path) const;

    /**
     * @brief Register callback for board discovery events
     */
    void register_discovery_callback(std::function<void(const DiscoveredBoard&)> callback);

    /**
     * @brief Get statistics
     */
    struct DiscoveryStats {
        size_t boards_discovered;
        size_t boards_configured;
        size_t sensors_detected;
        size_t ip_assignments;
        std::chrono::steady_clock::time_point last_discovery;
    };

    DiscoveryStats get_stats() const {
        return stats_;
    }

private:
    // IP assignment based on board signature
    std::string calculate_ip_from_signature(const BoardSignature& signature) const;
    bool is_ip_available(const std::string& ip) const;

    // Sensor detection from packet data
    std::vector<SensorInfo> detect_sensors_from_packet(const uint8_t* data, size_t size) const;
    BoardType detect_board_type(const std::vector<SensorInfo>& sensors) const;

    // Board management
    void add_or_update_board(const DiscoveredBoard& board);
    void remove_stale_boards(std::chrono::seconds timeout = std::chrono::seconds(30));

    // Configuration generation
    std::map<std::string, std::string> generate_board_config(const DiscoveredBoard& board) const;
    std::map<std::string, std::string> generate_sensor_config(
        const std::vector<SensorInfo>& sensors) const;

    // Network discovery
    void scan_network();
    void listen_for_announcements();

    // State
    std::map<BoardSignature, DiscoveredBoard> discovered_boards_;
    std::map<std::string, BoardSignature> ip_to_signature_;  // IP -> signature mapping
    std::map<BoardSignature, std::string> signature_to_ip_;  // signature -> IP mapping

    std::string network_interface_;
    std::string base_ip_;
    uint8_t ip_range_start_;
    uint8_t ip_range_end_;
    std::map<uint8_t, std::string> static_ip_overrides_;  // board_id → config IP

    std::atomic<bool> discovery_active_;
    DiscoveryMode current_mode_;

    std::vector<std::function<void(const DiscoveredBoard&)>> discovery_callbacks_;

    DiscoveryStats stats_;
    std::mutex boards_mutex_;
};

/**
 * @brief Dynamic Configuration Manager
 *
 * Manages configuration that updates based on discovered hardware
 */
class DynamicConfigManager {
public:
    DynamicConfigManager();
    ~DynamicConfigManager() = default;

    /**
     * @brief Load base configuration
     */
    bool load_base_config(const std::string& config_path);

    /**
     * @brief Update configuration with discovered boards
     */
    bool update_with_boards(const std::vector<DiscoveredBoard>& boards);

    /**
     * @brief Save updated configuration
     */
    bool save_config(const std::string& output_path) const;

    /**
     * @brief Get current configuration
     */
    std::map<std::string, std::map<std::string, std::string>> get_config() const {
        return config_;
    }

private:
    std::map<std::string, std::map<std::string, std::string>> config_;
    std::string base_config_path_;
};

}  // namespace config
}  // namespace fsw

#endif  // DAQ_BOARD_DISCOVERY_HPP
