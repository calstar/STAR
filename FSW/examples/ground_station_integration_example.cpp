/**
 * @file ground_station_integration_example.cpp
 * @brief Example demonstrating how to integrate Ground Station GUI with FSW
 * 
 * This example shows:
 * - Setting up the GroundStationInterface
 * - Registering command handlers
 * - Sending telemetry data
 * - Handling state transitions and safety
 */

#include <iostream>
#include <memory>
#include <thread>
#include <chrono>
#include <atomic>
#include <cmath>
#include <signal.h>

#include "../comms/include/GroundStationInterface.hpp"

// Global flag for clean shutdown
std::atomic<bool> g_running{true};

void signalHandler(int signal) {
    std::cout << "\n🛑 Received signal " << signal << ", shutting down..." << std::endl;
    g_running = false;
}

// Simulated engine state
enum class EngineState {
    INITIALIZATION = 0,
    STANDBY = 1,
    PRE_IGNITION_CHECKS = 3,
    IGNITION_PREP = 5,
    IGNITION_SEQUENCE = 6,
    STEADY_STATE = 10,
    SHUTDOWN_SEQUENCE = 13,
    ABORT = 15
};

std::atomic<EngineState> g_current_state{EngineState::INITIALIZATION};
std::atomic<double> g_current_thrust{0.0};
std::atomic<double> g_current_mixture_ratio{2.5};
std::atomic<bool> g_abort_requested{false};

// Simulated valve positions
std::atomic<double> g_valve_positions[4] = {0.0, 0.0, 0.0, 0.0};

/**
 * @brief Simulate sensor data generation
 */
std::map<std::string, double> generateSensorData() {
    static double time = 0.0;
    time += 0.1;  // 100ms timestep
    
    std::map<std::string, double> sensor_data;
    
    // Simulate 16 pressure transducers with realistic noise and dynamics
    for (int i = 1; i <= 16; ++i) {
        double base_pressure = 100.0 + i * 50.0;
        
        // Add engine state-dependent pressure
        if (g_current_state == EngineState::STEADY_STATE) {
            base_pressure += g_current_thrust * 5.0;
        }
        
        // Add noise
        double noise = (rand() % 100 - 50) / 10.0;
        
        sensor_data["PT" + std::to_string(i) + "_pressure"] = base_pressure + noise;
    }
    
    // Simulate 8 thermocouples
    for (int i = 1; i <= 8; ++i) {
        double base_temp = 20.0 + i * 30.0;
        
        if (g_current_state == EngineState::STEADY_STATE) {
            base_temp += g_current_thrust * 3.0;
        }
        
        double noise = (rand() % 50 - 25) / 10.0;
        sensor_data["TC" + std::to_string(i) + "_temperature"] = base_temp + noise;
    }
    
    // IMU data
    sensor_data["IMU_accel_x"] = sin(time) * 0.1;
    sensor_data["IMU_accel_y"] = cos(time) * 0.1;
    sensor_data["IMU_accel_z"] = 9.81 + sin(time * 2) * 0.05;
    sensor_data["IMU_gyro_x"] = sin(time * 0.5) * 0.01;
    sensor_data["IMU_gyro_y"] = cos(time * 0.5) * 0.01;
    sensor_data["IMU_gyro_z"] = sin(time * 0.3) * 0.01;
    
    return sensor_data;
}

/**
 * @brief Generate engine status telemetry
 */
std::map<std::string, double> generateEngineStatus() {
    std::map<std::string, double> status;
    
    status["state"] = static_cast<double>(g_current_state.load());
    status["thrust_percent"] = g_current_thrust.load();
    status["thrust_actual_N"] = g_current_thrust.load() * 150.0;  // Max 15kN
    status["mixture_ratio"] = g_current_mixture_ratio.load();
    status["chamber_pressure"] = g_current_state == EngineState::STEADY_STATE ? 
                                300.0 + g_current_thrust * 7.0 : 0.0;
    
    // Valve positions
    for (int i = 0; i < 4; ++i) {
        status["valve_" + std::to_string(i) + "_position"] = g_valve_positions[i].load();
    }
    
    return status;
}

/**
 * @brief Generate system health telemetry
 */
std::map<std::string, double> generateSystemHealth() {
    std::map<std::string, double> health;
    
    health["cpu_usage"] = 45.0 + (rand() % 20);
    health["memory_usage"] = 60.0 + (rand() % 15);
    health["network_latency_ms"] = 5.0 + (rand() % 10);
    health["safety_interlocks_ok"] = 1.0;
    health["battery_voltage"] = 24.5 + (rand() % 5) / 10.0;
    health["temperature_board"] = 35.0 + (rand() % 10);
    
    return health;
}

/**
 * @brief Command handler: Engine start
 */
bool handleEngineStart(const GroundStationInterface::Command& cmd) {
    std::cout << "📥 ENGINE START command received" << std::endl;
    
    // Check preconditions
    if (g_current_state != EngineState::STANDBY && 
        g_current_state != EngineState::IGNITION_PREP) {
        std::cerr << "❌ Cannot start engine from current state" << std::endl;
        return false;
    }
    
    // Transition to ignition sequence
    g_current_state = EngineState::IGNITION_SEQUENCE;
    std::cout << "✅ Transitioning to IGNITION_SEQUENCE" << std::endl;
    
    return true;
}

/**
 * @brief Command handler: Engine stop
 */
bool handleEngineStop(const GroundStationInterface::Command& cmd) {
    std::cout << "📥 ENGINE STOP command received" << std::endl;
    
    // Check if emergency stop
    auto it = cmd.parameters.find("emergency");
    bool emergency = (it != cmd.parameters.end() && it->second > 0.5);
    
    if (emergency) {
        std::cout << "🛑 EMERGENCY SHUTDOWN!" << std::endl;
        g_current_state = EngineState::ABORT;
        g_current_thrust = 0.0;
        // Close all valves immediately
        for (int i = 0; i < 4; ++i) {
            g_valve_positions[i] = 0.0;
        }
    } else {
        std::cout << "✅ Controlled shutdown" << std::endl;
        g_current_state = EngineState::SHUTDOWN_SEQUENCE;
    }
    
    return true;
}

/**
 * @brief Command handler: Abort
 */
bool handleAbort(const GroundStationInterface::Command& cmd) {
    std::cout << "📥 ⚠️  ABORT command received!" << std::endl;
    
    g_abort_requested = true;
    g_current_state = EngineState::ABORT;
    g_current_thrust = 0.0;
    
    // Close all valves
    for (int i = 0; i < 4; ++i) {
        g_valve_positions[i] = 0.0;
    }
    
    std::cout << "✅ ABORT sequence initiated" << std::endl;
    
    return true;
}

/**
 * @brief Command handler: Set thrust
 */
bool handleSetThrust(const GroundStationInterface::Command& cmd) {
    auto it = cmd.parameters.find("thrust_percent");
    if (it == cmd.parameters.end()) {
        std::cerr << "❌ Missing thrust_percent parameter" << std::endl;
        return false;
    }
    
    double thrust = it->second;
    
    // Validate range
    if (thrust < 0.0 || thrust > 100.0) {
        std::cerr << "❌ Thrust out of range: " << thrust << std::endl;
        return false;
    }
    
    std::cout << "📥 SET THRUST command: " << thrust << "%" << std::endl;
    g_current_thrust = thrust;
    
    return true;
}

/**
 * @brief Command handler: Valve control
 */
bool handleValveControl(const GroundStationInterface::Command& cmd) {
    auto valve_it = cmd.parameters.find("valve_id");
    auto pos_it = cmd.parameters.find("position");
    
    if (valve_it == cmd.parameters.end() || pos_it == cmd.parameters.end()) {
        std::cerr << "❌ Missing valve_id or position parameter" << std::endl;
        return false;
    }
    
    int valve_id = static_cast<int>(valve_it->second);
    double position = pos_it->second;
    
    // Validate
    if (valve_id < 0 || valve_id >= 4) {
        std::cerr << "❌ Invalid valve_id: " << valve_id << std::endl;
        return false;
    }
    
    if (position < 0.0 || position > 1.0) {
        std::cerr << "❌ Invalid position: " << position << std::endl;
        return false;
    }
    
    std::cout << "📥 VALVE CONTROL command: valve=" << valve_id 
              << " position=" << (position * 100.0) << "%" << std::endl;
    
    g_valve_positions[valve_id] = position;
    
    return true;
}

/**
 * @brief Simulate engine state machine progression
 */
void updateEngineStateMachine() {
    static auto last_transition = std::chrono::steady_clock::now();
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - last_transition);
    
    // Auto-progress through states for demo
    switch (g_current_state.load()) {
        case EngineState::INITIALIZATION:
            if (elapsed.count() > 2) {
                g_current_state = EngineState::STANDBY;
                std::cout << "→ Transitioned to STANDBY" << std::endl;
                last_transition = now;
            }
            break;
            
        case EngineState::IGNITION_SEQUENCE:
            if (elapsed.count() > 3) {
                g_current_state = EngineState::STEADY_STATE;
                std::cout << "→ Transitioned to STEADY_STATE" << std::endl;
                last_transition = now;
            }
            break;
            
        case EngineState::SHUTDOWN_SEQUENCE:
            if (elapsed.count() > 2) {
                g_current_state = EngineState::STANDBY;
                g_current_thrust = 0.0;
                std::cout << "→ Transitioned to STANDBY" << std::endl;
                last_transition = now;
            }
            break;
            
        default:
            break;
    }
}

/**
 * @brief Main function
 */
int main(int argc, char** argv) {
    // Setup signal handlers
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);
    
    std::cout << "==================================================" << std::endl;
    std::cout << "  Diablo FSW - Ground Station Integration Demo" << std::endl;
    std::cout << "==================================================" << std::endl;
    std::cout << std::endl;
    
    // Configure ground station interface
    GroundStationInterface::Config gs_config;
    gs_config.command_port = 2241;
    gs_config.telemetry_port = 2242;
    gs_config.heartbeat_interval = std::chrono::milliseconds(1000);
    gs_config.enable_command_validation = true;
    
    // Create ground station interface
    auto gs_interface = std::make_shared<GroundStationInterface>(gs_config);
    
    // Initialize
    if (!gs_interface->initialize()) {
        std::cerr << "❌ Failed to initialize ground station interface" << std::endl;
        return 1;
    }
    
    // Register command handlers
    gs_interface->registerCommandHandler(
        GroundStationInterface::CommandType::ENGINE_START,
        handleEngineStart
    );
    
    gs_interface->registerCommandHandler(
        GroundStationInterface::CommandType::ENGINE_STOP,
        handleEngineStop
    );
    
    gs_interface->registerCommandHandler(
        GroundStationInterface::CommandType::ENGINE_ABORT,
        handleAbort
    );
    
    gs_interface->registerCommandHandler(
        GroundStationInterface::CommandType::SET_THRUST,
        handleSetThrust
    );
    
    gs_interface->registerCommandHandler(
        GroundStationInterface::CommandType::VALVE_CONTROL,
        handleValveControl
    );
    
    // Start ground station interface
    if (!gs_interface->start()) {
        std::cerr << "❌ Failed to start ground station interface" << std::endl;
        return 1;
    }
    
    std::cout << std::endl;
    std::cout << "✅ Ground Station Interface started successfully" << std::endl;
    std::cout << "   Waiting for ground station connections..." << std::endl;
    std::cout << "   Command port: " << gs_config.command_port << std::endl;
    std::cout << "   Telemetry port: " << gs_config.telemetry_port << std::endl;
    std::cout << std::endl;
    std::cout << "💡 Launch ground_station_gui.py to connect" << std::endl;
    std::cout << "   Press Ctrl+C to exit" << std::endl;
    std::cout << std::endl;
    
    // Main loop
    auto last_telemetry_time = std::chrono::steady_clock::now();
    const auto telemetry_interval = std::chrono::milliseconds(100);  // 10 Hz
    
    while (g_running) {
        auto now = std::chrono::steady_clock::now();
        
        // Update engine state machine
        updateEngineStateMachine();
        
        // Send telemetry at fixed rate
        if (now - last_telemetry_time >= telemetry_interval) {
            // Generate and send sensor data
            auto sensor_data = generateSensorData();
            gs_interface->sendSensorData(sensor_data);
            
            // Generate and send engine status
            auto engine_status = generateEngineStatus();
            gs_interface->sendEngineStatus(engine_status);
            
            // Generate and send system health (at lower rate)
            static int health_counter = 0;
            if (++health_counter >= 10) {  // 1 Hz
                auto system_health = generateSystemHealth();
                gs_interface->sendSystemHealth(system_health);
                health_counter = 0;
            }
            
            last_telemetry_time = now;
        }
        
        // Sleep to avoid burning CPU
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    
    // Cleanup
    std::cout << std::endl;
    std::cout << "Shutting down ground station interface..." << std::endl;
    gs_interface->stop();
    
    // Print statistics
    auto stats = gs_interface->getStatistics();
    std::cout << std::endl;
    std::cout << "==================================================" << std::endl;
    std::cout << "  Statistics" << std::endl;
    std::cout << "==================================================" << std::endl;
    std::cout << "Commands received: " << stats.commands_received << std::endl;
    std::cout << "Commands executed: " << stats.commands_executed << std::endl;
    std::cout << "Commands failed: " << stats.commands_failed << std::endl;
    std::cout << "Telemetry sent: " << stats.telemetry_sent << std::endl;
    std::cout << "Telemetry failed: " << stats.telemetry_failed << std::endl;
    std::cout << "Total connections: " << stats.total_connections << std::endl;
    std::cout << "==================================================" << std::endl;
    
    return 0;
}

