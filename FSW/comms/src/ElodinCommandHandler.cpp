/**
 * @file ElodinCommandHandler.cpp
 * @brief Implementation of Elodin command handler
 */

#include "ElodinCommandHandler.hpp"
#include <iostream>
#include <sstream>
#include <json/json.h>  // Use your JSON library

// ============================================================================
// ElodinCommandHandler Implementation
// ============================================================================

ElodinCommandHandler::ElodinCommandHandler(const Config& config)
    : config_(config)
    , running_(false)
    , commands_received_(0)
    , commands_executed_(0)
    , commands_failed_(0)
    , validation_failures_(0)
    , last_processed_timestamp_(0.0)
{
    std::cout << "ElodinCommandHandler initialized" << std::endl;
    std::cout << "  Poll interval: " << config_.poll_interval.count() << " ms" << std::endl;
    std::cout << "  Validation enabled: " << (config_.enable_validation ? "yes" : "no") << std::endl;
}

ElodinCommandHandler::~ElodinCommandHandler() {
    stop();
}

bool ElodinCommandHandler::initialize() {
    // Nothing special to initialize - commands come from Elodin DB
    // which is already initialized via LocalSock
    std::cout << "✅ ElodinCommandHandler initialized" << std::endl;
    return true;
}

bool ElodinCommandHandler::start() {
    if (running_) {
        return true;
    }
    
    running_ = true;
    poll_thread_ = std::thread(&ElodinCommandHandler::pollLoop, this);
    
    std::cout << "🚀 ElodinCommandHandler started - polling for commands" << std::endl;
    return true;
}

void ElodinCommandHandler::stop() {
    if (!running_) {
        return;
    }
    
    running_ = false;
    
    if (poll_thread_.joinable()) {
        poll_thread_.join();
    }
    
    std::cout << "🛑 ElodinCommandHandler stopped" << std::endl;
}

void ElodinCommandHandler::registerHandler(CommandType type, CommandHandler handler) {
    std::lock_guard<std::mutex> lock(handlers_mutex_);
    handlers_[type] = handler;
    std::cout << "Registered handler for command type: " << static_cast<int>(type) << std::endl;
}

void ElodinCommandHandler::unregisterHandler(CommandType type) {
    std::lock_guard<std::mutex> lock(handlers_mutex_);
    handlers_.erase(type);
}

ElodinCommandHandler::Statistics ElodinCommandHandler::getStatistics() const {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    Statistics stats;
    stats.commands_received = commands_received_;
    stats.commands_executed = commands_executed_;
    stats.commands_failed = commands_failed_;
    stats.validation_failures = validation_failures_;
    stats.last_command_time = last_command_time_;
    return stats;
}

void ElodinCommandHandler::pollLoop() {
    std::cout << "Command polling loop started" << std::endl;
    
    while (running_) {
        try {
            // Fetch new commands from Elodin
            auto commands = fetchNewCommands();
            
            for (const auto& cmd : commands) {
                // Validate command
                if (config_.enable_validation && !validateCommand(cmd)) {
                    std::cerr << "❌ Command validation failed" << std::endl;
                    validation_failures_++;
                    continue;
                }
                
                // Execute command
                executeCommand(cmd);
                
                // Update last processed timestamp
                {
                    std::lock_guard<std::mutex> lock(timestamp_mutex_);
                    last_processed_timestamp_ = std::max(last_processed_timestamp_, cmd.timestamp);
                }
            }
            
        } catch (const std::exception& e) {
            std::cerr << "❌ Error in command poll loop: " << e.what() << std::endl;
        }
        
        // Sleep for poll interval
        std::this_thread::sleep_for(config_.poll_interval);
    }
    
    std::cout << "Command polling loop stopped" << std::endl;
}

std::vector<ElodinCommandHandler::Command> ElodinCommandHandler::fetchNewCommands() {
    std::vector<Command> commands;
    
    // TODO: Query Elodin database for new command messages
    // For now, this is a placeholder that would use Elodin query API
    // In practice, you would:
    // 1. Query for packets with COMMAND packet_id ([0xFF, 0x01])
    // 2. Filter by timestamp > last_processed_timestamp_
    // 3. Parse JSON payload into Command structures
    
    // Placeholder implementation (replace with actual Elodin query)
    /*
    auto query_result = queryElodinDB(
        packet_id = [0xFF, 0x01],
        start_time = last_processed_timestamp_,
        end_time = getCurrentTime()
    );
    
    for (const auto& record : query_result) {
        Command cmd;
        cmd.type = parseCommandType(record["type"]);
        cmd.parameters = record["parameters"];
        cmd.timestamp = record["timestamp"];
        cmd.source = record["source"];
        cmd.command_id = record.get("command_id", 0);
        commands.push_back(cmd);
    }
    */
    
    return commands;
}

bool ElodinCommandHandler::validateCommand(const Command& cmd) const {
    // Check timestamp (command not too old)
    auto now = std::chrono::duration<double>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    
    if (now - cmd.timestamp > config_.command_timeout_seconds) {
        std::cerr << "Command too old: " << (now - cmd.timestamp) << " seconds" << std::endl;
        return false;
    }
    
    // Additional validation could go here
    // - Parameter range checks
    // - State machine checks
    // - Safety interlock checks
    
    return true;
}

void ElodinCommandHandler::executeCommand(const Command& cmd) {
    std::cout << "📥 Executing command: " << static_cast<int>(cmd.type) << std::endl;
    
    commands_received_++;
    
    // Find and execute handler
    CommandHandler handler;
    {
        std::lock_guard<std::mutex> lock(handlers_mutex_);
        auto it = handlers_.find(cmd.type);
        if (it == handlers_.end()) {
            std::cerr << "❌ No handler registered for command type: " 
                      << static_cast<int>(cmd.type) << std::endl;
            commands_failed_++;
            logCommandExecution(cmd, false);
            return;
        }
        handler = it->second;
    }
    
    // Execute handler
    bool success = handler(cmd);
    
    if (success) {
        commands_executed_++;
        std::cout << "✅ Command executed successfully" << std::endl;
    } else {
        commands_failed_++;
        std::cerr << "❌ Command execution failed" << std::endl;
    }
    
    // Update last command time
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        last_command_time_ = std::chrono::steady_clock::now();
    }
    
    // Log execution result back to Elodin
    logCommandExecution(cmd, success);
}

void ElodinCommandHandler::logCommandExecution(const Command& cmd, bool success) {
    // TODO: Write command execution result to Elodin
    // This creates an audit trail of all commands
    /*
    CommandExecutionMessage msg;
    msg.command_type = static_cast<int>(cmd.type);
    msg.success = success;
    msg.timestamp = getCurrentTime();
    
    write_to_elodindb([0xFF, 0x02], msg);  // Command execution log
    */
}

ElodinCommandHandler::CommandType ElodinCommandHandler::parseCommandType(const std::string& type_str) const {
    static const std::map<std::string, CommandType> type_map = {
        {"ENGINE_START", CommandType::ENGINE_START},
        {"ENGINE_STOP", CommandType::ENGINE_STOP},
        {"ENGINE_ABORT", CommandType::ENGINE_ABORT},
        {"SET_THRUST", CommandType::SET_THRUST},
        {"SET_MIXTURE_RATIO", CommandType::SET_MIXTURE_RATIO},
        {"VALVE_CONTROL", CommandType::VALVE_CONTROL},
        {"STATE_TRANSITION", CommandType::STATE_TRANSITION},
        {"CALIBRATION_START", CommandType::CALIBRATION_START},
        {"CONFIG_UPDATE", CommandType::CONFIG_UPDATE},
        {"SYSTEM_RESET", CommandType::SYSTEM_RESET}
    };
    
    auto it = type_map.find(type_str);
    if (it != type_map.end()) {
        return it->second;
    }
    
    throw std::runtime_error("Unknown command type: " + type_str);
}


// ============================================================================
// ElodinFSWIntegration Implementation
// ============================================================================

ElodinFSWIntegration::ElodinFSWIntegration() {
    command_handler_ = std::make_shared<ElodinCommandHandler>();
}

ElodinFSWIntegration::~ElodinFSWIntegration() {
    stop();
}

bool ElodinFSWIntegration::initialize() {
    return command_handler_->initialize();
}

bool ElodinFSWIntegration::start() {
    // Register internal command handlers
    command_handler_->registerHandler(
        ElodinCommandHandler::CommandType::ENGINE_START,
        [this](const auto& cmd) {
            if (engine_start_handler_) {
                return engine_start_handler_();
            }
            return false;
        }
    );
    
    command_handler_->registerHandler(
        ElodinCommandHandler::CommandType::ENGINE_STOP,
        [this](const auto& cmd) {
            if (engine_stop_handler_) {
                return engine_stop_handler_();
            }
            return false;
        }
    );
    
    command_handler_->registerHandler(
        ElodinCommandHandler::CommandType::ENGINE_ABORT,
        [this](const auto& cmd) {
            if (abort_handler_) {
                return abort_handler_();
            }
            return false;
        }
    );
    
    command_handler_->registerHandler(
        ElodinCommandHandler::CommandType::SET_THRUST,
        [this](const auto& cmd) {
            if (thrust_handler_) {
                auto it = cmd.parameters.find("thrust_percent");
                if (it != cmd.parameters.end()) {
                    return thrust_handler_(it->second);
                }
            }
            return false;
        }
    );
    
    command_handler_->registerHandler(
        ElodinCommandHandler::CommandType::VALVE_CONTROL,
        [this](const auto& cmd) {
            if (valve_handler_) {
                auto valve_it = cmd.parameters.find("valve_id");
                auto pos_it = cmd.parameters.find("position");
                if (valve_it != cmd.parameters.end() && pos_it != cmd.parameters.end()) {
                    return valve_handler_(static_cast<int>(valve_it->second), pos_it->second);
                }
            }
            return false;
        }
    );
    
    command_handler_->registerHandler(
        ElodinCommandHandler::CommandType::STATE_TRANSITION,
        [this](const auto& cmd) {
            if (state_transition_handler_) {
                auto it = cmd.parameters.find("target_state");
                if (it != cmd.parameters.end()) {
                    return state_transition_handler_(static_cast<int>(it->second));
                }
            }
            return false;
        }
    );
    
    return command_handler_->start();
}

void ElodinFSWIntegration::stop() {
    command_handler_->stop();
}

void ElodinFSWIntegration::registerEngineStartHandler(std::function<bool()> handler) {
    engine_start_handler_ = handler;
}

void ElodinFSWIntegration::registerEngineStopHandler(std::function<bool()> handler) {
    engine_stop_handler_ = handler;
}

void ElodinFSWIntegration::registerAbortHandler(std::function<bool()> handler) {
    abort_handler_ = handler;
}

void ElodinFSWIntegration::registerThrustHandler(std::function<bool(double)> handler) {
    thrust_handler_ = handler;
}

void ElodinFSWIntegration::registerValveHandler(std::function<bool(int, double)> handler) {
    valve_handler_ = handler;
}

void ElodinFSWIntegration::registerStateTransitionHandler(std::function<bool(int)> handler) {
    state_transition_handler_ = handler;
}

void ElodinFSWIntegration::logCommandResult(const std::string& command, bool success) {
    // Log command execution result to Elodin
    // This provides audit trail in database
    std::cout << "📊 Logged command result: " << command << " = " 
              << (success ? "SUCCESS" : "FAILED") << std::endl;
}

