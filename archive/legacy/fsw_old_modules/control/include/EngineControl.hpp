#ifndef ENGINE_CONTROL_HPP
#define ENGINE_CONTROL_HPP

#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

/**
 * @brief Main Engine Control System
 *
 * Handles valve control (motor + solenoid), gain scheduling, and engine state management
 * for liquid rocket engine operations including pre-ignition, startup, steady-state, and shutdown
 */
class EngineControl {
public:
    enum class EnginePhase {
        PRE_IGNITION,  // Pre-ignition checks and purging
        IGNITION,      // Ignition sequence
        STARTUP,       // Startup transient
        STEADY_STATE,  // Nominal operation
        SHUTDOWN,      // Shutdown sequence
        ABORT,         // Emergency abort
        MAINTENANCE    // Maintenance mode
    };

    enum class ValveType {
        MAIN_FUEL,      // Main fuel valve (motor-controlled)
        MAIN_OXIDIZER,  // Main oxidizer valve (motor-controlled)
        IGNITER_FUEL,   // Igniter fuel valve (solenoid)
        IGNITER_OX,     // Igniter oxidizer valve (solenoid)
        PURGE_N2,       // Nitrogen purge valve (solenoid)
        COOLING_H2O     // Cooling water valve (solenoid)
    };

    struct ValveCommand {
        ValveType type;
        double position;       // 0.0 to 1.0 (0 = closed, 1 = fully open)
        double rate_limit;     // Position change rate limit (1/s)
        bool emergency_close;  // Emergency close command
        std::chrono::steady_clock::time_point timestamp;
    };

    struct EngineState {
        EnginePhase phase;
        double thrust_demand;         // N
        double mixture_ratio_demand;  // O/F ratio
        double chamber_pressure;      // Pa
        double thrust_actual;         // N (estimated)
        double mixture_ratio_actual;  // O/F ratio (estimated)
        bool ignition_confirmed;
        bool all_systems_go;
        std::chrono::steady_clock::time_point phase_start_time;
        std::chrono::steady_clock::time_point timestamp;
    };

    struct ControlGains {
        // PID gains for different engine phases
        struct PIDGains {
            double kp, ki, kd;
            double integral_limit;
            double output_limit;
        };

        PIDGains thrust_control;
        PIDGains pressure_control;
        PIDGains mixture_ratio_control;

        // Gain scheduling parameters
        std::vector<double> pressure_breakpoints;     // Pa
        std::vector<double> thrust_breakpoints;       // N
        std::vector<double> temperature_breakpoints;  // K

        // Adaptive gain factors
        double adaptive_factor;
        bool gain_scheduling_enabled;
    };

    EngineControl();
    ~EngineControl();

    // Main control loop
    void run();
    void stop();

    // Phase management
    void setEnginePhase(EnginePhase phase);
    EnginePhase getCurrentPhase() const;

    // Command interface
    void setThrustDemand(double thrust_demand);
    void setMixtureRatioDemand(double mixture_ratio);
    void emergencyAbort();

    // Valve control
    void setValvePosition(ValveType valve, double position);
    void setValveRateLimit(ValveType valve, double rate_limit);
    double getValvePosition(ValveType valve) const;

    // Gain scheduling
    void updateControlGains(const ControlGains& gains);
    void enableGainScheduling(bool enable);

    // State queries
    EngineState getEngineState() const;
    std::vector<ValveCommand> getValveCommands() const;

    // Safety systems
    void checkAbortConditions();
    bool isSystemHealthy() const;

private:
    // Core control functions
    void controlLoop();
    void updateGainScheduling();
    void computeValveCommands();
    void safetyMonitor();

    // Valve control algorithms
    double computeMainFuelValvePosition(double thrust_demand, double chamber_pressure);
    double computeMainOxValvePosition(double thrust_demand, double mixture_ratio);
    double computeIgniterValvePositions(double phase_progress);
    double computePurgeValvePosition(EnginePhase phase);

    // Gain scheduling
    ControlGains::PIDGains interpolateGains(const std::vector<ControlGains::PIDGains>& gains,
                                            const std::vector<double>& breakpoints,
                                            double current_value);

    // State variables
    std::atomic<bool> running_;
    std::atomic<EnginePhase> current_phase_;
    std::atomic<double> thrust_demand_;
    std::atomic<double> mixture_ratio_demand_;

    // Valve states
    std::array<std::atomic<double>, 6> valve_positions_;
    std::array<std::atomic<double>, 6> valve_rate_limits_;
    std::array<std::atomic<bool>, 6> emergency_close_flags_;

    // Control gains
    ControlGains control_gains_;
    mutable std::mutex gains_mutex_;

    // Engine state
    EngineState engine_state_;
    mutable std::mutex state_mutex_;

    // Threading
    std::thread control_thread_;
    std::thread safety_thread_;

    // Timing
    std::chrono::steady_clock::time_point last_update_;
    std::chrono::milliseconds control_period_{10};  // 100 Hz control loop
};

#endif  // ENGINE_CONTROL_HPP
