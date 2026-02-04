/**
 * @file GroundStationInterface.cpp
 * @brief Implementation of Ground Station communication interface
 */

#include "GroundStationInterface.hpp"

#include <fcntl.h>
#include <json/json.h>  // Or use your preferred JSON library
#include <unistd.h>

#include <cstring>
#include <iostream>
#include <sstream>

// ============================================================================
// GroundStationInterface Implementation
// ============================================================================

GroundStationInterface::GroundStationInterface(const Config& config)
    : config_(config),
      command_server_socket_(-1),
      telemetry_server_socket_(-1),
      running_(false),
      commands_received_(0),
      commands_executed_(0),
      commands_failed_(0),
      telemetry_sent_(0),
      telemetry_failed_(0),
      clients_connected_(0),
      total_connections_(0),
      sequence_number_(0) {
    std::cout << "GroundStationInterface initialized" << std::endl;
}

GroundStationInterface::~GroundStationInterface() {
    stop();
}

bool GroundStationInterface::initialize() {
    // Create command server socket
    if (!createServerSocket(command_server_socket_, config_.command_port)) {
        std::cerr << "Failed to create command server socket" << std::endl;
        return false;
    }

    // Create telemetry server socket
    if (!createServerSocket(telemetry_server_socket_, config_.telemetry_port)) {
        std::cerr << "Failed to create telemetry server socket" << std::endl;
        close(command_server_socket_);
        return false;
    }

    std::cout << "✅ Ground Station Interface initialized" << std::endl;
    std::cout << "   Command port: " << config_.command_port << std::endl;
    std::cout << "   Telemetry port: " << config_.telemetry_port << std::endl;

    return true;
}

bool GroundStationInterface::start() {
    if (running_) {
        return true;
    }

    running_ = true;

    // Start command listening thread
    command_listen_thread_ = std::thread(&GroundStationInterface::commandListenLoop, this);

    // Start command processing thread
    command_process_thread_ = std::thread(&GroundStationInterface::commandProcessLoop, this);

    // Start telemetry sending thread
    telemetry_send_thread_ = std::thread(&GroundStationInterface::telemetrySendLoop, this);

    // Start heartbeat thread
    heartbeat_thread_ = std::thread(&GroundStationInterface::heartbeatLoop, this);

    std::cout << "🚀 Ground Station Interface started" << std::endl;

    return true;
}

void GroundStationInterface::stop() {
    if (!running_) {
        return;
    }

    running_ = false;

    // Notify all condition variables
    commands_cv_.notify_all();
    telemetry_cv_.notify_all();

    // Join threads
    if (command_listen_thread_.joinable()) {
        command_listen_thread_.join();
    }
    if (command_process_thread_.joinable()) {
        command_process_thread_.join();
    }
    if (telemetry_send_thread_.joinable()) {
        telemetry_send_thread_.join();
    }
    if (heartbeat_thread_.joinable()) {
        heartbeat_thread_.join();
    }

    // Close all client sockets
    {
        std::lock_guard<std::mutex> lock(client_sockets_mutex_);
        for (int socket : client_sockets_) {
            close(socket);
        }
        client_sockets_.clear();
    }

    // Close server sockets
    if (command_server_socket_ >= 0) {
        close(command_server_socket_);
    }
    if (telemetry_server_socket_ >= 0) {
        close(telemetry_server_socket_);
    }

    std::cout << "🛑 Ground Station Interface stopped" << std::endl;
}

void GroundStationInterface::registerCommandHandler(CommandType type,
                                                    std::function<bool(const Command&)> handler) {
    command_handlers_[type] = handler;
    std::cout << "Registered command handler for type: " << static_cast<int>(type) << std::endl;
}

void GroundStationInterface::unregisterCommandHandler(CommandType type) {
    command_handlers_.erase(type);
}

bool GroundStationInterface::sendTelemetry(const TelemetryPacket& telemetry) {
    {
        std::lock_guard<std::mutex> lock(telemetry_mutex_);
        outgoing_telemetry_.push(telemetry);
    }
    telemetry_cv_.notify_one();
    return true;
}

bool GroundStationInterface::sendSensorData(const std::map<std::string, double>& sensor_data) {
    TelemetryPacket packet;
    packet.message_type = MessageType::SENSOR_DATA;
    packet.priority = Priority::NORMAL;
    packet.data = sensor_data;
    packet.timestamp =
        std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    packet.sequence_number = sequence_number_++;

    return sendTelemetry(packet);
}

bool GroundStationInterface::sendEngineStatus(const std::map<std::string, double>& status) {
    TelemetryPacket packet;
    packet.message_type = MessageType::ENGINE_STATUS;
    packet.priority = Priority::NORMAL;
    packet.data = status;
    packet.timestamp =
        std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    packet.sequence_number = sequence_number_++;

    return sendTelemetry(packet);
}

bool GroundStationInterface::sendSystemHealth(const std::map<std::string, double>& health) {
    TelemetryPacket packet;
    packet.message_type = MessageType::SYSTEM_HEALTH;
    packet.priority = Priority::NORMAL;
    packet.data = health;
    packet.timestamp =
        std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    packet.sequence_number = sequence_number_++;

    return sendTelemetry(packet);
}

bool GroundStationInterface::sendHeartbeat() {
    TelemetryPacket packet;
    packet.message_type = MessageType::HEARTBEAT;
    packet.priority = Priority::LOW;
    packet.timestamp =
        std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    packet.sequence_number = sequence_number_++;

    return sendTelemetry(packet);
}

bool GroundStationInterface::sendSafetyAlert(const std::string& alert_message, Priority priority) {
    TelemetryPacket packet;
    packet.message_type = MessageType::SAFETY_ALERT;
    packet.priority = priority;
    packet.data["alert"] = 1.0;  // Encode alert message in data
    packet.timestamp =
        std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    packet.sequence_number = sequence_number_++;

    std::cout << "⚠️  SAFETY ALERT: " << alert_message << std::endl;

    return sendTelemetry(packet);
}

GroundStationInterface::Statistics GroundStationInterface::getStatistics() const {
    Statistics stats;
    stats.commands_received = commands_received_;
    stats.commands_executed = commands_executed_;
    stats.commands_failed = commands_failed_;
    stats.telemetry_sent = telemetry_sent_;
    stats.telemetry_failed = telemetry_failed_;
    stats.clients_connected = clients_connected_;
    stats.total_connections = total_connections_;

    {
        std::lock_guard<std::mutex> lock(timing_mutex_);
        stats.last_command_time = last_command_time_;
        stats.last_telemetry_time = last_telemetry_time_;
    }

    return stats;
}

// ============================================================================
// Private Methods
// ============================================================================

bool GroundStationInterface::createServerSocket(int& socket_fd, uint16_t port) {
    // Create socket
    socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_fd < 0) {
        std::cerr << "Failed to create socket: " << strerror(errno) << std::endl;
        return false;
    }

    // Set socket options
    int opt = 1;
    if (setsockopt(socket_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        std::cerr << "Failed to set socket options: " << strerror(errno) << std::endl;
        close(socket_fd);
        return false;
    }

    // Bind socket
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = htons(port);

    if (bind(socket_fd, (struct sockaddr*)&address, sizeof(address)) < 0) {
        std::cerr << "Failed to bind socket to port " << port << ": " << strerror(errno)
                  << std::endl;
        close(socket_fd);
        return false;
    }

    // Listen
    if (listen(socket_fd, config_.max_clients) < 0) {
        std::cerr << "Failed to listen on socket: " << strerror(errno) << std::endl;
        close(socket_fd);
        return false;
    }

    // Set non-blocking mode
    int flags = fcntl(socket_fd, F_GETFL, 0);
    fcntl(socket_fd, F_SETFL, flags | O_NONBLOCK);

    return true;
}

void GroundStationInterface::commandListenLoop() {
    std::cout << "Command listen thread started" << std::endl;

    while (running_) {
        // Accept new connections
        acceptClients(command_server_socket_);

        // Receive commands from connected clients
        std::vector<int> sockets_to_check;
        {
            std::lock_guard<std::mutex> lock(client_sockets_mutex_);
            sockets_to_check = client_sockets_;
        }

        for (int client_socket : sockets_to_check) {
            // Try to receive data
            uint8_t header_buffer[8];
            ssize_t received = recv(client_socket, header_buffer, 8, MSG_DONTWAIT);

            if (received == 8) {
                // Parse header
                uint32_t packet_length = *reinterpret_cast<uint32_t*>(header_buffer);

                // Receive payload
                std::vector<uint8_t> payload(packet_length - 8);
                size_t total_received = 0;
                while (total_received < payload.size() && running_) {
                    ssize_t n = recv(client_socket, payload.data() + total_received,
                                     payload.size() - total_received, 0);
                    if (n > 0) {
                        total_received += n;
                    } else if (n == 0) {
                        break;  // Connection closed
                    }
                }

                if (total_received == payload.size()) {
                    // Deserialize command
                    try {
                        Command command = deserializeCommand(payload);

                        // Queue command for processing
                        {
                            std::lock_guard<std::mutex> lock(commands_mutex_);
                            incoming_commands_.push(command);
                        }
                        commands_cv_.notify_one();

                        commands_received_++;

                        {
                            std::lock_guard<std::mutex> lock(timing_mutex_);
                            last_command_time_ = std::chrono::steady_clock::now();
                        }

                    } catch (const std::exception& e) {
                        std::cerr << "Failed to deserialize command: " << e.what() << std::endl;
                    }
                }
            }
        }

        // Remove disconnected clients
        removeDisconnectedClients();

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    std::cout << "Command listen thread stopped" << std::endl;
}

void GroundStationInterface::commandProcessLoop() {
    std::cout << "Command process thread started" << std::endl;

    while (running_) {
        std::unique_lock<std::mutex> lock(commands_mutex_);

        // Wait for commands
        commands_cv_.wait_for(lock, std::chrono::milliseconds(100), [this] {
            return !incoming_commands_.empty() || !running_;
        });

        if (!running_)
            break;

        // Process all queued commands
        while (!incoming_commands_.empty()) {
            Command command = incoming_commands_.front();
            incoming_commands_.pop();

            lock.unlock();

            // Validate and execute command
            if (config_.enable_command_validation && !validateCommand(command)) {
                std::cerr << "Command validation failed" << std::endl;
                commands_failed_++;
            } else {
                executeCommand(command);
            }

            lock.lock();
        }
    }

    std::cout << "Command process thread stopped" << std::endl;
}

void GroundStationInterface::telemetrySendLoop() {
    std::cout << "Telemetry send thread started" << std::endl;

    while (running_) {
        std::unique_lock<std::mutex> lock(telemetry_mutex_);

        // Wait for telemetry
        telemetry_cv_.wait_for(lock, std::chrono::milliseconds(100), [this] {
            return !outgoing_telemetry_.empty() || !running_;
        });

        if (!running_)
            break;

        // Send all queued telemetry
        while (!outgoing_telemetry_.empty()) {
            TelemetryPacket telemetry = outgoing_telemetry_.front();
            outgoing_telemetry_.pop();

            lock.unlock();

            // Serialize and send
            std::vector<uint8_t> packet = serializeTelemetry(telemetry);

            if (sendToAllClients(packet)) {
                telemetry_sent_++;

                {
                    std::lock_guard<std::mutex> timing_lock(timing_mutex_);
                    last_telemetry_time_ = std::chrono::steady_clock::now();
                }
            } else {
                telemetry_failed_++;
            }

            lock.lock();
        }
    }

    std::cout << "Telemetry send thread stopped" << std::endl;
}

void GroundStationInterface::heartbeatLoop() {
    std::cout << "Heartbeat thread started" << std::endl;

    while (running_) {
        sendHeartbeat();

        std::this_thread::sleep_for(config_.heartbeat_interval);
    }

    std::cout << "Heartbeat thread stopped" << std::endl;
}

void GroundStationInterface::acceptClients(int server_socket) {
    struct sockaddr_in client_address;
    socklen_t client_address_len = sizeof(client_address);

    int client_socket =
        accept(server_socket, (struct sockaddr*)&client_address, &client_address_len);

    if (client_socket >= 0) {
        std::lock_guard<std::mutex> lock(client_sockets_mutex_);
        client_sockets_.push_back(client_socket);
        clients_connected_++;
        total_connections_++;

        std::cout << "✅ Ground station connected (socket: " << client_socket << ")" << std::endl;
    }
}

void GroundStationInterface::removeDisconnectedClients() {
    std::lock_guard<std::mutex> lock(client_sockets_mutex_);

    auto it = client_sockets_.begin();
    while (it != client_sockets_.end()) {
        int socket = *it;

        // Check if socket is still connected (try peek)
        char buffer;
        ssize_t result = recv(socket, &buffer, 1, MSG_PEEK | MSG_DONTWAIT);

        if (result == 0 || (result < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
            // Socket disconnected
            close(socket);
            it = client_sockets_.erase(it);
            clients_connected_--;

            std::cout << "🔌 Ground station disconnected (socket: " << socket << ")" << std::endl;
        } else {
            ++it;
        }
    }
}

bool GroundStationInterface::sendToAllClients(const std::vector<uint8_t>& data) {
    std::lock_guard<std::mutex> lock(client_sockets_mutex_);

    if (client_sockets_.empty()) {
        return false;
    }

    bool success = true;
    for (int socket : client_sockets_) {
        ssize_t sent = send(socket, data.data(), data.size(), MSG_NOSIGNAL);
        if (sent < 0 || static_cast<size_t>(sent) != data.size()) {
            success = false;
        }
    }

    return success;
}

std::vector<uint8_t> GroundStationInterface::serializeTelemetry(const TelemetryPacket& telemetry) {
    // Create JSON payload (simplified - use actual JSON library in production)
    std::ostringstream json_stream;
    json_stream << "{";
    json_stream << "\"timestamp\":" << telemetry.timestamp << ",";
    json_stream << "\"data\":{";

    bool first = true;
    for (const auto& [key, value] : telemetry.data) {
        if (!first)
            json_stream << ",";
        json_stream << "\"" << key << "\":" << value;
        first = false;
    }

    json_stream << "}}";

    std::string json_str = json_stream.str();
    std::vector<uint8_t> payload(json_str.begin(), json_str.end());

    // Build packet: [length(4) | msg_type(1) | priority(1) | sequence(2) | payload]
    uint32_t packet_length = 8 + payload.size();
    std::vector<uint8_t> packet(packet_length);

    *reinterpret_cast<uint32_t*>(packet.data()) = packet_length;
    packet[4] = static_cast<uint8_t>(telemetry.message_type);
    packet[5] = static_cast<uint8_t>(telemetry.priority);
    *reinterpret_cast<uint16_t*>(packet.data() + 6) =
        static_cast<uint16_t>(telemetry.sequence_number);

    std::copy(payload.begin(), payload.end(), packet.begin() + 8);

    return packet;
}

GroundStationInterface::Command GroundStationInterface::deserializeCommand(
    const std::vector<uint8_t>& data) {
    // Parse JSON payload (simplified)
    std::string json_str(data.begin(), data.end());

    // In production, use proper JSON parsing library
    // For now, create dummy command
    Command command;
    command.command_type = CommandType::ENGINE_START;
    command.timestamp = 0.0;
    command.command_id = 0;
    command.requires_confirmation = true;
    command.source = "ground_station";

    return command;
}

bool GroundStationInterface::validateCommand(const Command& command) const {
    // Basic validation
    if (command.command_id == 0) {
        return false;
    }

    // Check timestamp (command not too old)
    double current_time =
        std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();

    if (current_time - command.timestamp > 10.0) {  // 10 second timeout
        std::cerr << "Command too old" << std::endl;
        return false;
    }

    return true;
}

void GroundStationInterface::executeCommand(const Command& command) {
    logCommand(command);

    // Find and execute command handler
    auto it = command_handlers_.find(command.command_type);
    if (it != command_handlers_.end()) {
        bool success = it->second(command);
        if (success) {
            commands_executed_++;
        } else {
            commands_failed_++;
        }
    } else {
        std::cerr << "No handler registered for command type: "
                  << static_cast<int>(command.command_type) << std::endl;
        commands_failed_++;
    }
}

void GroundStationInterface::logCommand(const Command& command) {
    std::cout << "📥 Command received: type=" << static_cast<int>(command.command_type)
              << " id=" << command.command_id << " from=" << command.source << std::endl;
}

void GroundStationInterface::logTelemetry(const TelemetryPacket& telemetry) {
    // Optional: log telemetry (disabled by default for performance)
}

// ============================================================================
// FSWGroundStationBridge Implementation
// ============================================================================

FSWGroundStationBridge::FSWGroundStationBridge(std::shared_ptr<GroundStationInterface> gs_interface)
    : gs_interface_(gs_interface), streaming_active_(false), streaming_interval_(100) {
    std::cout << "FSWGroundStationBridge initialized" << std::endl;
}

FSWGroundStationBridge::~FSWGroundStationBridge() {
    stopTelemetryStreaming();
}

void FSWGroundStationBridge::updateSensorTelemetry(
    const std::map<std::string, double>& sensor_data) {
    std::lock_guard<std::mutex> lock(data_mutex_);
    latest_sensor_data_ = sensor_data;
}

void FSWGroundStationBridge::updateEngineStatus(const std::map<std::string, double>& status) {
    std::lock_guard<std::mutex> lock(data_mutex_);
    latest_engine_status_ = status;
}

void FSWGroundStationBridge::updateSystemHealth(const std::map<std::string, double>& health) {
    std::lock_guard<std::mutex> lock(data_mutex_);
    latest_system_health_ = health;
}

void FSWGroundStationBridge::startTelemetryStreaming(std::chrono::milliseconds interval) {
    if (streaming_active_) {
        return;
    }

    streaming_interval_ = interval;
    streaming_active_ = true;

    streaming_thread_ = std::thread(&FSWGroundStationBridge::telemetryStreamingLoop, this);

    std::cout << "🚀 Telemetry streaming started (" << interval.count() << " ms interval)"
              << std::endl;
}

void FSWGroundStationBridge::stopTelemetryStreaming() {
    if (!streaming_active_) {
        return;
    }

    streaming_active_ = false;

    if (streaming_thread_.joinable()) {
        streaming_thread_.join();
    }

    std::cout << "🛑 Telemetry streaming stopped" << std::endl;
}

void FSWGroundStationBridge::telemetryStreamingLoop() {
    while (streaming_active_) {
        // Send latest sensor data
        {
            std::lock_guard<std::mutex> lock(data_mutex_);
            if (!latest_sensor_data_.empty()) {
                gs_interface_->sendSensorData(latest_sensor_data_);
            }
            if (!latest_engine_status_.empty()) {
                gs_interface_->sendEngineStatus(latest_engine_status_);
            }
            if (!latest_system_health_.empty()) {
                gs_interface_->sendSystemHealth(latest_system_health_);
            }
        }

        std::this_thread::sleep_for(streaming_interval_);
    }
}
