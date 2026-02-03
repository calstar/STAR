/**
 * Simple FSW Simulator for Elodin Groundstation Testing
 * 
 * This simulates FSW behavior:
 * - Reads commands from Elodin database
 * - Executes state machine transitions
 * - Writes telemetry (engine status, sensor data) back to Elodin
 * 
 * Usage: ./test_fsw_simulator <db_port> [db_path]
 */

#include <iostream>
#include <thread>
#include <chrono>
#include <atomic>
#include <cstdint>
#include <array>
#include <map>
#include <string>
#include <iomanip>

#include "../../daq_comms/include/elodin/ElodinClient.hpp"
#include "../../daq_comms/include/elodin/DatabaseConfig.hpp"
#include "../../comms/include/messages/sensor/SensorMessages.hpp"
#include "../../utl/db.hpp"

using namespace vtable;
using namespace vtable::builder;

// Simple state machine states
enum class EngineState {
    STANDBY = 0,
    PRE_IGNITION = 1,
    IGNITION = 2,
    STARTUP = 3,
    STEADY_STATE = 4,
    SHUTDOWN = 5,
    ABORT = 6
};

// Global state
std::atomic<EngineState> current_state{EngineState::STANDBY};
std::atomic<double> current_thrust{0.0};
std::atomic<bool> running{true};

// Simple command message structure (matching groundstation format)
struct CommandMessage {
    std::string type;
    std::map<std::string, double> parameters;
    double timestamp;
    std::string source;
};

// Parse command from Elodin (simplified - in real FSW, use ElodinCommandHandler)
bool parseCommand(const std::vector<std::byte>& /*data*/, CommandMessage& /*cmd*/) {
    // In real implementation, this would parse the Elodin command packet
    // For now, we'll simulate command execution based on state
    return true;
}

// Execute command
void executeCommand(const CommandMessage& cmd) {
    std::cout << "📥 Executing command: " << cmd.type << std::endl;
    
    if (cmd.type == "ENGINE_START") {
        if (current_state == EngineState::STANDBY) {
            current_state = EngineState::PRE_IGNITION;
            std::cout << "  → Transitioned to PRE_IGNITION" << std::endl;
        }
    } else if (cmd.type == "ENGINE_STOP") {
        current_state = EngineState::SHUTDOWN;
        std::cout << "  → Transitioned to SHUTDOWN" << std::endl;
    } else if (cmd.type == "ENGINE_ABORT") {
        current_state = EngineState::ABORT;
        std::cout << "  ⚠️  ABORT COMMANDED" << std::endl;
    } else if (cmd.type == "SET_THRUST") {
        auto it = cmd.parameters.find("thrust_percent");
        if (it != cmd.parameters.end()) {
            current_thrust = it->second;
            std::cout << "  → Thrust set to " << current_thrust << "%" << std::endl;
        }
    } else if (cmd.type == "STATE_TRANSITION") {
        auto it = cmd.parameters.find("target_state");
        if (it != cmd.parameters.end()) {
            int state_val = static_cast<int>(it->second);
            if (state_val >= 0 && state_val <= 6) {
                current_state = static_cast<EngineState>(state_val);
                std::cout << "  → State transition to " << state_val << std::endl;
            }
        }
    }
}

// Write engine status to Elodin
void writeEngineStatus(daq_comms::elodin::ElodinClient& client) {
    // Create a simple status message
    // In real FSW, this would be EngineStatusMessage
    // For now, we'll use RawPTMessage format but with status data
    
    comms::messages::sensor::RawPTMessage status_msg;
    
    auto now = std::chrono::steady_clock::now();
    auto timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
        now.time_since_epoch()).count();
    
    // Load atomic values
    EngineState state = current_state.load();
    double thrust = current_thrust.load();
    
    // Encode state and thrust in the message fields
    status_msg.setField<0>(timestamp_ns);
    status_msg.setField<1>(static_cast<uint8_t>(state)); // channel_id = state
    status_msg.setField<2>(static_cast<uint32_t>(thrust * 100)); // raw_adc = thrust*100
    status_msg.setField<3>(0); // sample_timestamp_ms
    status_msg.setField<4>(0); // status_flags
    
    std::array<uint8_t, 2> status_packet_id{0x10, 0x00}; // ENGINE_STATUS
    
    if (client.publish(status_packet_id, status_msg)) {
        std::cout << "📤 Engine status: state=" << static_cast<int>(state) 
                  << ", thrust=" << thrust << "%" << std::endl;
    }
}

// Main loop
int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <db_port> [db_path]" << std::endl;
        std::cerr << "Example: " << argv[0] << " 2240" << std::endl;
        return 1;
    }
    
    uint16_t port = std::stoi(argv[1]);
    
    std::cout << "🤖 FSW Simulator for Elodin Groundstation Test" << std::endl;
    std::cout << "================================================" << std::endl;
    std::cout << "DB: 127.0.0.1:" << port << std::endl;
    std::cout << "State: STANDBY" << std::endl;
    std::cout << "" << std::endl;
    
    try {
        // Connect to Elodin
        daq_comms::elodin::ElodinClient client;
        if (!client.connect("127.0.0.1", port)) {
            std::cerr << "❌ Failed to connect to Elodin DB" << std::endl;
            return 1;
        }
        std::cout << "✅ Connected to Elodin DB" << std::endl;
        
        // Register tables
        if (!daq_comms::elodin::DatabaseConfig::register_tables(client)) {
            std::cerr << "❌ Failed to register tables" << std::endl;
            return 1;
        }
        std::cout << "✅ Registered VTables" << std::endl;
        
        // Wait for Elodin to process VTables
        std::this_thread::sleep_for(std::chrono::milliseconds(2000));
        
        std::cout << "" << std::endl;
        std::cout << "🔄 Starting simulation loop..." << std::endl;
        std::cout << "   - Polling for commands every 100ms" << std::endl;
        std::cout << "   - Writing engine status every 1s" << std::endl;
        std::cout << "   Press Ctrl+C to stop" << std::endl;
        std::cout << "" << std::endl;
        
        auto last_status_time = std::chrono::steady_clock::now();
        
        // Main loop
        while (running) {
            // TODO: Poll Elodin for commands
            // In real implementation, use ElodinCommandHandler to poll for commands
            // For now, we'll just write status periodically
            
            auto now = std::chrono::steady_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                now - last_status_time).count();
            
            // Write engine status every second
            if (elapsed >= 1000) {
                writeEngineStatus(client);
                last_status_time = now;
            }
            
            // Simulate state transitions
            if (current_state == EngineState::PRE_IGNITION) {
                std::this_thread::sleep_for(std::chrono::seconds(2));
                current_state = EngineState::IGNITION;
                std::cout << "  → Auto-transitioned to IGNITION" << std::endl;
            } else if (current_state == EngineState::IGNITION) {
                std::this_thread::sleep_for(std::chrono::seconds(1));
                current_state = EngineState::STARTUP;
                std::cout << "  → Auto-transitioned to STARTUP" << std::endl;
            } else if (current_state == EngineState::STARTUP && current_thrust > 0) {
                std::this_thread::sleep_for(std::chrono::seconds(2));
                current_state = EngineState::STEADY_STATE;
                std::cout << "  → Auto-transitioned to STEADY_STATE" << std::endl;
            }
            
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        
        client.disconnect();
        
    } catch (const std::exception& e) {
        std::cerr << "❌ Error: " << e.what() << std::endl;
        return 1;
    }
    
    return 0;
}

