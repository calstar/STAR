#include "ESP32SerialHandler.hpp"

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>

ESP32SerialHandler::ESP32SerialHandler(const ESP32Config& config)
    : config_(config), running_(false), serial_fd_(-1) {
}

ESP32SerialHandler::~ESP32SerialHandler() {
    stop();
}

bool ESP32SerialHandler::start() {
    if (running_) {
        return true;
    }

    if (!openSerialPort()) {
        std::cerr << "Failed to open serial port: " << config_.device_path << std::endl;
        return false;
    }

    running_ = true;
    worker_thread_ = std::thread(&ESP32SerialHandler::workerThread, this);

    std::cout << "ESP32 Serial Handler started on " << config_.device_path << " at "
              << config_.baud_rate << " baud" << std::endl;
    return true;
}

void ESP32SerialHandler::stop() {
    if (!running_) {
        return;
    }

    running_ = false;
    cv_.notify_all();

    if (worker_thread_.joinable()) {
        worker_thread_.join();
    }

    closeSerialPort();
    std::cout << "ESP32 Serial Handler stopped" << std::endl;
}

bool ESP32SerialHandler::isRunning() const {
    return running_;
}

void ESP32SerialHandler::registerPTCallback(PTDataCallback callback) {
    std::lock_guard<std::mutex> lock(data_mutex_);
    pt_callback_ = callback;
}

std::vector<uint8_t> ESP32SerialHandler::getActiveSensors() const {
    std::lock_guard<std::mutex> lock(data_mutex_);
    std::vector<uint8_t> active_sensors;

    uint64_t current_time = Timer::get_time_ns();
    const uint32_t timeout_ns = 2000000000;  // 2 seconds timeout

    for (const auto& pair : last_seen_timestamp_) {
        if (current_time - pair.second < timeout_ns) {
            active_sensors.push_back(pair.first);
        }
    }

    std::sort(active_sensors.begin(), active_sensors.end());
    return active_sensors;
}

std::shared_ptr<PTMessage> ESP32SerialHandler::getLatestSensorData(uint8_t sensor_id) const {
    std::lock_guard<std::mutex> lock(data_mutex_);
    auto it = latest_sensor_data_.find(sensor_id);
    if (it != latest_sensor_data_.end()) {
        return it->second;
    }
    return nullptr;
}

std::map<uint8_t, std::shared_ptr<PTMessage>> ESP32SerialHandler::getAllRecentSensorData(
    uint32_t max_age_ms) const {
    std::lock_guard<std::mutex> lock(data_mutex_);
    std::map<uint8_t, std::shared_ptr<PTMessage>> recent_data;

    uint64_t current_time = Timer::get_time_ns();
    const uint64_t timeout_ns = static_cast<uint64_t>(max_age_ms) * 1000000;

    for (const auto& pair : latest_sensor_data_) {
        auto timestamp_it = last_seen_timestamp_.find(pair.first);
        if (timestamp_it != last_seen_timestamp_.end()) {
            if (current_time - timestamp_it->second < timeout_ns) {
                recent_data[pair.first] = pair.second;
            }
        }
    }

    return recent_data;
}

std::vector<std::shared_ptr<PTMessage>> ESP32SerialHandler::buildObservationMatrix(
    const std::vector<uint8_t>& sensor_ids) const {
    std::lock_guard<std::mutex> lock(data_mutex_);
    std::vector<std::shared_ptr<PTMessage>> observation_data;

    for (uint8_t sensor_id : sensor_ids) {
        auto it = latest_sensor_data_.find(sensor_id);
        if (it != latest_sensor_data_.end()) {
            // Check if data is recent (within 1 second)
            auto timestamp_it = last_seen_timestamp_.find(sensor_id);
            if (timestamp_it != last_seen_timestamp_.end()) {
                uint64_t current_time = Timer::get_time_ns();
                const uint64_t timeout_ns = 1000000000;  // 1 second

                if (current_time - timestamp_it->second < timeout_ns) {
                    observation_data.push_back(it->second);
                }
            }
        }
    }

    return observation_data;
}

std::map<uint8_t, std::map<std::string, double>> ESP32SerialHandler::getSensorStatistics() const {
    std::lock_guard<std::mutex> lock(data_mutex_);
    std::map<uint8_t, std::map<std::string, double>> stats;

    uint64_t current_time = Timer::get_time_ns();

    for (const auto& pair : latest_sensor_data_) {
        uint8_t sensor_id = pair.first;
        std::map<std::string, double> sensor_stats;

        // Packet count
        auto packet_it = packet_counts_.find(sensor_id);
        if (packet_it != packet_counts_.end()) {
            sensor_stats["packet_count"] = static_cast<double>(packet_it->second);
        }

        // Last seen time (in milliseconds since epoch)
        auto timestamp_it = last_seen_timestamp_.find(sensor_id);
        if (timestamp_it != last_seen_timestamp_.end()) {
            sensor_stats["last_seen_ms"] = static_cast<double>(timestamp_it->second / 1000000);
        }

        // Average sample rate
        auto rate_it = avg_sample_rates_.find(sensor_id);
        if (rate_it != avg_sample_rates_.end()) {
            sensor_stats["avg_sample_rate"] = rate_it->second;
        }

        // Data age in milliseconds
        if (timestamp_it != last_seen_timestamp_.end()) {
            sensor_stats["data_age_ms"] =
                static_cast<double>(current_time - timestamp_it->second) / 1000000.0;
        }

        stats[sensor_id] = sensor_stats;
    }

    return stats;
}

void ESP32SerialHandler::workerThread() {
    uint8_t buffer[1024];
    const size_t record_size = sizeof(ESP32SampleRecord);

    std::cout << "ESP32 worker thread started" << std::endl;

    while (running_) {
        int bytes_read = readSerialData(buffer, sizeof(buffer));

        if (bytes_read > 0) {
            if (config_.enable_binary_mode) {
                parseBinaryData(buffer, bytes_read);
            } else {
                // Assume text mode for debugging
                parseTextData(reinterpret_cast<const char*>(buffer), bytes_read);
            }
        } else if (bytes_read < 0) {
            // Error or timeout
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }

    std::cout << "ESP32 worker thread stopped" << std::endl;
}

bool ESP32SerialHandler::openSerialPort() {
    serial_fd_ = open(config_.device_path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);

    if (serial_fd_ == -1) {
        std::cerr << "Failed to open serial port: " << config_.device_path << std::endl;
        return false;
    }

    struct termios tty;
    if (tcgetattr(serial_fd_, &tty) != 0) {
        std::cerr << "Failed to get serial port attributes" << std::endl;
        close(serial_fd_);
        serial_fd_ = -1;
        return false;
    }

    // Configure serial port
    cfsetospeed(&tty, B115200);  // Set baud rate
    cfsetispeed(&tty, B115200);

    tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;  // 8-bit characters
    tty.c_iflag &= ~IGNBRK;                      // Disable break processing
    tty.c_lflag = 0;      // No signaling chars, no echo, no canonical processing
    tty.c_oflag = 0;      // No remapping, no delays
    tty.c_cc[VMIN] = 0;   // Read doesn't block
    tty.c_cc[VTIME] = 5;  // 0.5 second read timeout

    tty.c_iflag &= ~(IXON | IXOFF | IXANY);  // Shut off xon/xoff ctrl
    tty.c_cflag |= (CLOCAL | CREAD);         // Ignore modem controls, enable reading
    tty.c_cflag &= ~(PARENB | PARODD);       // Shut off parity
    tty.c_cflag &= ~CSTOPB;
    tty.c_cflag &= ~CRTSCTS;

    if (tcsetattr(serial_fd_, TCSANOW, &tty) != 0) {
        std::cerr << "Failed to set serial port attributes" << std::endl;
        close(serial_fd_);
        serial_fd_ = -1;
        return false;
    }

    return true;
}

void ESP32SerialHandler::closeSerialPort() {
    if (serial_fd_ != -1) {
        close(serial_fd_);
        serial_fd_ = -1;
    }
}

int ESP32SerialHandler::readSerialData(uint8_t* buffer, size_t max_bytes) {
    if (serial_fd_ == -1) {
        return -1;
    }

    fd_set readfds;
    struct timeval timeout;

    FD_ZERO(&readfds);
    FD_SET(serial_fd_, &readfds);

    timeout.tv_sec = 0;
    timeout.tv_usec = 100000;  // 100ms timeout

    int result = select(serial_fd_ + 1, &readfds, nullptr, nullptr, &timeout);

    if (result > 0 && FD_ISSET(serial_fd_, &readfds)) {
        return read(serial_fd_, buffer, max_bytes);
    }

    return 0;  // Timeout
}

void ESP32SerialHandler::parseBinaryData(const uint8_t* data, size_t size) {
    const size_t record_size = sizeof(ESP32SampleRecord);

    for (size_t i = 0; i <= size - record_size; i += record_size) {
        ESP32SampleRecord record;
        std::memcpy(&record, data + i, record_size);

        // Basic validation
        if (record.channel < config_.max_sensors) {
            processSampleRecord(record);
        }
    }
}

void ESP32SerialHandler::parseTextData(const char* data, size_t size) {
    // For text mode debugging - parse voltage readings
    std::string data_str(data, size);

    // Simple parsing for space-separated voltage values
    std::istringstream iss(data_str);
    std::string line;

    while (std::getline(iss, line)) {
        if (line.empty())
            continue;

        std::istringstream line_stream(line);
        std::string value_str;
        uint8_t channel = 0;

        while (std::getline(line_stream, value_str, ' ') && channel < config_.max_sensors) {
            if (!value_str.empty()) {
                try {
                    float voltage = std::stof(value_str);

                    // Create mock ESP32SampleRecord for text mode
                    ESP32SampleRecord record;
                    record.t_us = static_cast<uint32_t>(Timer::get_time_ns() / 1000);
                    record.channel = channel;
                    record.volt_reader =
                        static_cast<int32_t>(voltage * 1000000);  // Convert to microvolts
                    record.voltage = voltage;
                    record.read_time_us = 1000;           // Mock read time
                    record.samples_per_second = 1000.0f;  // Mock sample rate
                    record.sent_us = record.t_us;

                    processSampleRecord(record);
                    channel++;
                } catch (const std::exception& e) {
                    // Skip invalid values
                    break;
                }
            }
        }
    }
}

void ESP32SerialHandler::processSampleRecord(const ESP32SampleRecord& record) {
    std::lock_guard<std::mutex> lock(data_mutex_);

    // Convert to PTMessage
    auto pt_message = convertToPTMessage(record);

    // Store latest data
    latest_sensor_data_[record.channel] = pt_message;
    last_seen_timestamp_[record.channel] = Timer::get_time_ns();

    // Update statistics
    packet_counts_[record.channel]++;
    updateSensorStatistics(record.channel, record.samples_per_second);

    // Map sensor channel to PT location (adjust based on your hardware setup)
    uint8_t pt_location = mapSensorToPTLocation(record.channel);

    // Call callback if registered
    if (pt_callback_) {
        pt_callback_(record.channel, record.voltage, static_cast<uint64_t>(record.t_us) * 1000,
                     pt_location);
    }

    std::cout << "Received PT data from sensor " << static_cast<int>(record.channel)
              << ": voltage=" << record.voltage << "V, location=" << static_cast<int>(pt_location)
              << std::endl;
}

std::shared_ptr<PTMessage> ESP32SerialHandler::convertToPTMessage(
    const ESP32SampleRecord& record) const {
    auto message = std::make_shared<PTMessage>();

    // Convert timestamp to nanoseconds for monotonic time
    uint64_t timestamp_ns = static_cast<uint64_t>(record.t_us) * 1000;

    // Map sensor channel to PT location
    uint8_t pt_location = mapSensorToPTLocation(record.channel);

    // Store raw voltage (calibration will be applied later)
    set_pt_measurement(*message, timestamp_ns, record.channel, record.voltage,
                       static_cast<PTLocation>(pt_location));

    return message;
}

void ESP32SerialHandler::updateSensorStatistics(uint8_t sensor_id, double sample_rate) {
    auto it = avg_sample_rates_.find(sensor_id);
    if (it != avg_sample_rates_.end()) {
        // Simple moving average
        it->second = (it->second * 0.9) + (sample_rate * 0.1);
    } else {
        avg_sample_rates_[sensor_id] = sample_rate;
    }
}

bool ESP32SerialHandler::isDataRecent(uint64_t timestamp, uint32_t max_age_ms) const {
    uint64_t current_time = Timer::get_time_ns();
    uint64_t max_age_ns = static_cast<uint64_t>(max_age_ms) * 1000000;
    return (current_time - timestamp) < max_age_ns;
}

uint8_t ESP32SerialHandler::mapSensorToPTLocation(uint8_t sensor_channel) const {
    // Map sensor channels to PT locations based on your hardware setup
    // Adjust this mapping based on your actual ESP32 wiring
    switch (sensor_channel) {
        case 0:
            return static_cast<uint8_t>(PTLocation::PRESSURANT_TANK);
        case 1:
            return static_cast<uint8_t>(PTLocation::KERO_INLET);
        case 2:
            return static_cast<uint8_t>(PTLocation::KERO_OUTLET);
        case 3:
            return static_cast<uint8_t>(PTLocation::LOX_INLET);
        case 4:
            return static_cast<uint8_t>(PTLocation::LOX_OUTLET);
        case 5:
            return static_cast<uint8_t>(PTLocation::INJECTOR);
        case 6:
            return static_cast<uint8_t>(PTLocation::CHAMBER_WALL_1);
        case 7:
            return static_cast<uint8_t>(PTLocation::CHAMBER_WALL_2);
        case 8:
            return static_cast<uint8_t>(PTLocation::NOZZLE_EXIT);
        default:
            return static_cast<uint8_t>(PTLocation::UNKNOWN);
    }
}

std::shared_ptr<ESP32SerialHandler> createESP32Handler(const std::string& device_path,
                                                       int baud_rate) {
    ESP32Config config;
    config.device_path = device_path;
    config.baud_rate = baud_rate;
    config.max_buffer_size = 1024;
    config.timeout_ms = 100;
    config.enable_binary_mode = true;
    config.max_sensors = 9;  // 9 PT sensors (0-8)

    return std::make_shared<ESP32SerialHandler>(config);
}
