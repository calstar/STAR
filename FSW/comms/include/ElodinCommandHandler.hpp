/**
 * @file ElodinCommandHandler.hpp
 * @brief Reads ground station commands from Elodin database and executes them
 * 
 * This provides the FSW side of the Elodin-integrated ground station:
 * - Polls Elodin DB for new command messages
 * - Validates and executes commands
 * - Logs command execution back to Elodin
 * - All telemetry written to Elodin using existing write_to_elodindb()
 */

#ifndef ELODIN_COMMAND_HANDLER_HPP
#define ELODIN_COMMAND_HANDLER_HPP

#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "TCPSocket.hpp"
#include "Elodin.hpp"

/**
 * @brief Handles ground station commands from Elodin database
 */
class ElodinCommandHandler {
public:
    enum class CommandType {
        ENGINE_START,
        ENGINE_STOP,
        ENGINE_ABORT,
        SET_THRUST,
        SET_MIXTURE_RATIO,
        VALVE_CONTROL,
        STATE_TRANSITION,
        CALIBRATION_START,
        CONFIG_UPDATE,
        SYSTEM_RESET
    };
    
    struct Command {
        CommandType type;
        std::map<std::string, double> parameters;
        double timestamp;
        std::string source;
        uint32_t command_id;
    };
    
    struct Config {
        std::chrono::milliseconds poll_interval{100};  // How often to check for new commands
        bool enable_validation{true};
        double command_timeout_seconds{10.0};  // Ignore commands older than this
    };
    
    using CommandHandler = std::function<bool(const Command&)>;
    
    ElodinCommandHandler(const Config& config = Config());
    ~ElodinCommandHandler();
    
    // Lifecycle
    bool initialize();
    bool start();
    void stop();
    
    // Register command handlers
    void registerHandler(CommandType type, CommandHandler handler);
    void unregisterHandler(CommandType type);
    
    // Statistics
    struct Statistics {
        uint32_t commands_received;
        uint32_t commands_executed;
        uint32_t commands_failed;
        uint32_t validation_failures;
        std::chrono::steady_clock::time_point last_command_time;
    };
    
    Statistics getStatistics() const;
    
private:
    Config config_;
    
    // Threading
    std::atomic<bool> running_;
    std::thread poll_thread_;
    
    // Command handlers
    std::map<CommandType, CommandHandler> handlers_;
    std::mutex handlers_mutex_;
    
    // Statistics
    std::atomic<uint32_t> commands_received_;
    std::atomic<uint32_t> commands_executed_;
    std::atomic<uint32_t> commands_failed_;
    std::atomic<uint32_t> validation_failures_;
    std::chrono::steady_clock::time_point last_command_time_;
    std::mutex stats_mutex_;
    
    // Last processed command timestamp (to avoid re-processing)
    double last_processed_timestamp_;
    std::mutex timestamp_mutex_;
    
    // Thread functions
    void pollLoop();
    
    // Command processing
    std::vector<Command> fetchNewCommands();
    bool validateCommand(const Command& cmd) const;
    void executeCommand(const Command& cmd);
    void logCommandExecution(const Command& cmd, bool success);
    
    // Parsing
    CommandType parseCommandType(const std::string& type_str) const;
};

/**
 * @brief End-to-end Elodin integration helper
 * 
 * Combines:
 * - Command reading from Elodin (ElodinCommandHandler)
 * - Telemetry writing to Elodin (using write_to_elodindb)
 * - Automatic logging of all FSW activity
 */
class ElodinFSWIntegration {
public:
    ElodinFSWIntegration();
    ~ElodinFSWIntegration();
    
    // Initialize and start
    bool initialize();
    bool start();
    void stop();
    
    // Register command handlers (convenience wrappers)
    void registerEngineStartHandler(std::function<bool()> handler);
    void registerEngineStopHandler(std::function<bool()> handler);
    void registerAbortHandler(std::function<bool()> handler);
    void registerThrustHandler(std::function<bool(double)> handler);
    void registerValveHandler(std::function<bool(int, double)> handler);
    void registerStateTransitionHandler(std::function<bool(int)> handler);
    
    // Telemetry logging helpers (wraps write_to_elodindb)
    template<typename MessageType>
    void logTelemetry(std::array<uint8_t, 2> packet_id, const MessageType& message) {
        write_to_elodindb(packet_id, message);
    }
    
    // Log command execution
    void logCommandResult(const std::string& command, bool success);
    
    // Get command handler for direct access
    std::shared_ptr<ElodinCommandHandler> getCommandHandler() { return command_handler_; }
    
private:
    std::shared_ptr<ElodinCommandHandler> command_handler_;
    
    // Internal command handlers
    std::function<bool()> engine_start_handler_;
    std::function<bool()> engine_stop_handler_;
    std::function<bool()> abort_handler_;
    std::function<bool(double)> thrust_handler_;
    std::function<bool(int, double)> valve_handler_;
    std::function<bool(int)> state_transition_handler_;
};

#endif // ELODIN_COMMAND_HANDLER_HPP

