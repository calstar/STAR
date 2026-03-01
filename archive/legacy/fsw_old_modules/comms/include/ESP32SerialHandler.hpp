#ifndef ESP32_SERIAL_HANDLER_HPP
#define ESP32_SERIAL_HANDLER_HPP

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "PTMessage.hpp"
#include "Timer.hpp"

/**
 * @brief Structure matching the Arduino SampleRecord format
 *
 * This matches the packed struct from your Arduino code:
 * struct SampleRecord {
 *   uint32_t t_us;
 *   uint8_t  channel;
 *   int32_t  volt_reader;
 *   float    voltage;
 *   uint32_t read_time_us;
 *   float    samples_per_second;
 *   uint32_t sent_us;
 * };
 */
#pragma pack(push, 1)
struct ESP32SampleRecord {
    uint32_t t_us;             // timestamp in microseconds
    uint8_t channel;           // sensor channel (0-9 for PT sensors)
    int32_t volt_reader;       // raw ADC reading
    float voltage;             // converted voltage
    uint32_t read_time_us;     // read time in microseconds
    float samples_per_second;  // calculated sample rate
    uint32_t sent_us;          // sent timestamp
};
#pragma pack(pop)

/**
 * @brief Configuration for ESP32 serial communication
 */
struct ESP32Config {
    std::string device_path;  // e.g., "/dev/ttyUSB0" or "COM3"
    int baud_rate;            // e.g., 115200
    size_t max_buffer_size;   // maximum buffer size for incoming data
    uint32_t timeout_ms;      // timeout for serial operations
    bool enable_binary_mode;  // true for binary, false for text
    size_t max_sensors;       // maximum number of sensors (default 10)
};

/**
 * @brief Callback function type for PT sensor data
 * @param sensor_id The PT sensor channel ID (0-8)
 * @param raw_voltage_v Raw voltage reading in Volts
 * @param timestamp Timestamp in nanoseconds
 * @param pt_location PT location enum value
 */
using PTDataCallback = std::function<void(uint8_t sensor_id, double raw_voltage_v,
                                          uint64_t timestamp, uint8_t pt_location)>;

/**
 * @brief ESP32 Serial Communication Handler
 *
 * Handles serial communication with ESP32 devices, parsing incoming sensor data
 * and converting it to standardized message formats. Supports dynamic sensor
 * detection and observation matrix building.
 */
class ESP32SerialHandler {
public:
    /**
     * @brief Constructor
     * @param config Configuration for serial communication
     */
    explicit ESP32SerialHandler(const ESP32Config& config);

    /**
     * @brief Destructor
     */
    ~ESP32SerialHandler();

    /**
     * @brief Start the serial handler
     * @return true if successful, false otherwise
     */
    bool start();

    /**
     * @brief Stop the serial handler
     */
    void stop();

    /**
     * @brief Check if handler is running
     * @return true if running, false otherwise
     */
    bool isRunning() const;

    /**
     * @brief Register callback for PT sensor data
     * @param callback Function to call when PT sensor data is received
     */
    void registerPTCallback(PTDataCallback callback);

    /**
     * @brief Get list of active sensors
     * @return Vector of sensor IDs that have sent data recently
     */
    std::vector<uint8_t> getActiveSensors() const;

    /**
     * @brief Get latest data for a specific sensor
     * @param sensor_id Sensor ID to query
     * @return Pointer to latest PTMessage, or nullptr if not available
     */
    std::shared_ptr<PTMessage> getLatestSensorData(uint8_t sensor_id) const;

    /**
     * @brief Get all recent sensor data
     * @param max_age_ms Maximum age of data to include (milliseconds)
     * @return Map of sensor_id -> latest PTMessage
     */
    std::map<uint8_t, std::shared_ptr<PTMessage>> getAllRecentSensorData(
        uint32_t max_age_ms = 1000) const;

    /**
     * @brief Build observation matrix for sensor fusion
     * @param sensor_ids Vector of sensor IDs to include in matrix
     * @return Vector of sensor data for observation matrix
     */
    std::vector<std::shared_ptr<PTMessage>> buildObservationMatrix(
        const std::vector<uint8_t>& sensor_ids) const;

    /**
     * @brief Get statistics about received data
     * @return Map of sensor_id -> {packet_count, last_seen_ms, avg_sample_rate}
     */
    std::map<uint8_t, std::map<std::string, double>> getSensorStatistics() const;

private:
    ESP32Config config_;
    std::atomic<bool> running_;
    std::thread worker_thread_;
    mutable std::mutex data_mutex_;
    std::condition_variable cv_;

    // Serial communication
    int serial_fd_;
    std::queue<uint8_t> incoming_buffer_;
    std::mutex buffer_mutex_;

    // Sensor data storage
    std::map<uint8_t, std::shared_ptr<PTMessage>> latest_sensor_data_;
    std::map<uint8_t, uint64_t> last_seen_timestamp_;
    std::map<uint8_t, uint32_t> packet_counts_;
    std::map<uint8_t, double> avg_sample_rates_;

    // Callbacks
    PTDataCallback pt_callback_;

    /**
     * @brief Main worker thread function
     */
    void workerThread();

    /**
     * @brief Open serial port
     * @return true if successful, false otherwise
     */
    bool openSerialPort();

    /**
     * @brief Close serial port
     */
    void closeSerialPort();

    /**
     * @brief Read data from serial port
     * @param buffer Buffer to read into
     * @param max_bytes Maximum bytes to read
     * @return Number of bytes read, or -1 on error
     */
    int readSerialData(uint8_t* buffer, size_t max_bytes);

    /**
     * @brief Parse incoming binary data
     * @param data Raw data buffer
     * @param size Size of data buffer
     */
    void parseBinaryData(const uint8_t* data, size_t size);

    /**
     * @brief Parse incoming text data (for debugging)
     * @param data Text data buffer
     * @param size Size of data buffer
     */
    void parseTextData(const char* data, size_t size);

    /**
     * @brief Process a single sample record
     * @param record Sample record from ESP32
     */
    void processSampleRecord(const ESP32SampleRecord& record);

    /**
     * @brief Convert ESP32 sample to PTMessage
     * @param record ESP32 sample record
     * @return Converted PTMessage
     */
    std::shared_ptr<PTMessage> convertToPTMessage(const ESP32SampleRecord& record) const;

    /**
     * @brief Update sensor statistics
     * @param sensor_id Sensor ID
     * @param sample_rate Current sample rate
     */
    void updateSensorStatistics(uint8_t sensor_id, double sample_rate);

    /**
     * @brief Check if sensor data is recent
     * @param timestamp Sensor timestamp
     * @param max_age_ms Maximum age in milliseconds
     * @return true if data is recent, false otherwise
     */
    bool isDataRecent(uint64_t timestamp, uint32_t max_age_ms) const;

    /**
     * @brief Map sensor channel to PT location
     * @param sensor_channel Sensor channel (0-8)
     * @return PT location enum value
     */
    uint8_t mapSensorToPTLocation(uint8_t sensor_channel) const;
};

/**
 * @brief Factory function to create ESP32 handler with default config
 * @param device_path Serial device path
 * @param baud_rate Baud rate (default 115200)
 * @return Shared pointer to ESP32 handler
 */
std::shared_ptr<ESP32SerialHandler> createESP32Handler(const std::string& device_path,
                                                       int baud_rate = 115200);

#endif  // ESP32_SERIAL_HANDLER_HPP
