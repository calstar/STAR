#include "../../control/include/EngineControl.hpp"

#include <chrono>
#include <iostream>

EngineControl::EngineControl() {
    running_ = false;
    current_phase_ = EnginePhase::PRE_IGNITION;
    thrust_demand_ = 0.0;
    mixture_ratio_demand_ = 6.0;

    // Initialize valve positions
    for (int i = 0; i < 6; ++i) {
        valve_positions_[i] = 0.0;
        valve_rate_limits_[i] = 0.5;
        emergency_close_flags_[i] = false;
    }
}

EngineControl::~EngineControl() {
    stop();
}

void EngineControl::run() {
    running_ = true;
    control_thread_ = std::thread(&EngineControl::controlLoop, this);
    safety_thread_ = std::thread(&EngineControl::safetyMonitor, this);
}

void EngineControl::stop() {
    running_ = false;
    if (control_thread_.joinable()) {
        control_thread_.join();
    }
    if (safety_thread_.joinable()) {
        safety_thread_.join();
    }
}

void EngineControl::setEnginePhase(EnginePhase phase) {
    current_phase_ = phase;
}

EngineControl::EnginePhase EngineControl::getCurrentPhase() const {
    return current_phase_;
}

void EngineControl::setThrustDemand(double thrust_demand) {
    thrust_demand_ = thrust_demand;
}

void EngineControl::setMixtureRatioDemand(double mixture_ratio) {
    mixture_ratio_demand_ = mixture_ratio;
}

void EngineControl::emergencyAbort() {
    for (int i = 0; i < 6; ++i) {
        emergency_close_flags_[i] = true;
    }
}

void EngineControl::setValvePosition(ValveType valve, double position) {
    int index = static_cast<int>(valve);
    if (index >= 0 && index < 6) {
        valve_positions_[index] = std::max(0.0, std::min(1.0, position));
    }
}

void EngineControl::setValveRateLimit(ValveType valve, double rate_limit) {
    int index = static_cast<int>(valve);
    if (index >= 0 && index < 6) {
        valve_rate_limits_[index] = std::max(0.1, std::min(5.0, rate_limit));
    }
}

double EngineControl::getValvePosition(ValveType valve) const {
    int index = static_cast<int>(valve);
    if (index >= 0 && index < 6) {
        return valve_positions_[index];
    }
    return 0.0;
}

void EngineControl::updateControlGains(const ControlGains& gains) {
    std::lock_guard<std::mutex> lock(gains_mutex_);
    control_gains_ = gains;
}

void EngineControl::enableGainScheduling(bool enable) {
    std::lock_guard<std::mutex> lock(gains_mutex_);
    control_gains_.gain_scheduling_enabled = enable;
}

EngineControl::EngineState EngineControl::getEngineState() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return engine_state_;
}

std::vector<EngineControl::ValveCommand> EngineControl::getValveCommands() const {
    std::vector<ValveCommand> commands;
    for (int i = 0; i < 6; ++i) {
        ValveCommand cmd;
        cmd.type = static_cast<ValveType>(i);
        cmd.position = valve_positions_[i];
        cmd.rate_limit = valve_rate_limits_[i];
        cmd.emergency_close = emergency_close_flags_[i];
        cmd.timestamp = std::chrono::steady_clock::now();
        commands.push_back(cmd);
    }
    return commands;
}

void EngineControl::checkAbortConditions() {
    // TODO: Implement abort condition checking
    // - Chamber pressure limits
    // - Temperature limits
    // - Valve position errors
    // - Sensor failures
}

bool EngineControl::isSystemHealthy() const {
    // TODO: Implement system health checking
    return true;
}

void EngineControl::controlLoop() {
    while (running_) {
        try {
            auto current_time = std::chrono::steady_clock::now();

            // Update control gains based on current conditions
            updateGainScheduling();

            // Compute valve commands
            computeValveCommands();

            // Check safety conditions
            checkAbortConditions();

            // Update engine state
            {
                std::lock_guard<std::mutex> lock(state_mutex_);
                engine_state_.phase = current_phase_;
                engine_state_.thrust_demand = thrust_demand_;
                engine_state_.mixture_ratio_demand = mixture_ratio_demand_;
                engine_state_.timestamp = current_time;
            }

            std::this_thread::sleep_for(control_period_);

        } catch (const std::exception& e) {
            std::cerr << "Error in engine control loop: " << e.what() << std::endl;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

void EngineControl::updateGainScheduling() {
    // TODO: Implement gain scheduling based on current engine state
    std::lock_guard<std::mutex> lock(gains_mutex_);

    // Example gain scheduling based on chamber pressure
    double chamber_pressure = engine_state_.chamber_pressure;

    if (chamber_pressure < 1e6) {
        // Low pressure gains
        control_gains_.thrust_control.kp = 1.0;
        control_gains_.thrust_control.ki = 0.1;
        control_gains_.thrust_control.kd = 0.01;
    } else if (chamber_pressure < 5e6) {
        // Medium pressure gains
        control_gains_.thrust_control.kp = 2.0;
        control_gains_.thrust_control.ki = 0.2;
        control_gains_.thrust_control.kd = 0.02;
    } else {
        // High pressure gains
        control_gains_.thrust_control.kp = 3.0;
        control_gains_.thrust_control.ki = 0.3;
        control_gains_.thrust_control.kd = 0.03;
    }
}

void EngineControl::computeValveCommands() {
    // TODO: Implement valve command computation based on control algorithm
    // This would integrate with the optimal controller and gain scheduling

    // Example simple control logic
    double fuel_valve_cmd =
        computeMainFuelValvePosition(thrust_demand_, engine_state_.chamber_pressure);
    double ox_valve_cmd = computeMainOxValvePosition(thrust_demand_, mixture_ratio_demand_);

    setValvePosition(ValveType::MAIN_FUEL, fuel_valve_cmd);
    setValvePosition(ValveType::MAIN_OXIDIZER, ox_valve_cmd);
}

void EngineControl::safetyMonitor() {
    while (running_) {
        try {
            // TODO: Implement safety monitoring
            // - Monitor valve positions
            // - Check for faults
            // - Monitor sensor health
            // - Check for emergency conditions

            std::this_thread::sleep_for(std::chrono::milliseconds(100));

        } catch (const std::exception& e) {
            std::cerr << "Error in safety monitor: " << e.what() << std::endl;
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        }
    }
}

double EngineControl::computeMainFuelValvePosition(double thrust_demand, double chamber_pressure) {
    // TODO: Implement fuel valve position calculation
    // This would be based on the optimal controller output and calibration
    return std::max(0.0, std::min(1.0, thrust_demand / 10000.0));
}

double EngineControl::computeMainOxValvePosition(double thrust_demand, double mixture_ratio) {
    // TODO: Implement oxidizer valve position calculation
    // This would be based on the optimal controller output and calibration
    double fuel_position =
        computeMainFuelValvePosition(thrust_demand, engine_state_.chamber_pressure);
    return std::max(0.0, std::min(1.0, fuel_position * mixture_ratio / 6.0));
}

double EngineControl::computeIgniterValvePositions(double phase_progress) {
    // TODO: Implement igniter valve position calculation based on engine phase
    return phase_progress;
}

double EngineControl::computePurgeValvePosition(EnginePhase phase) {
    // TODO: Implement purge valve position calculation based on engine phase
    switch (phase) {
        case EnginePhase::PRE_IGNITION:
        case EnginePhase::SHUTDOWN:
            return 1.0;  // Open for purging
        default:
            return 0.0;  // Closed during operation
    }
}
