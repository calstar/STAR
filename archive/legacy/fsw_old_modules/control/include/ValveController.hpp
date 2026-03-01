#ifndef VALVE_CONTROLLER_HPP
#define VALVE_CONTROLLER_HPP

#include <array>
#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>

/**
 * @brief Valve Controller Interface
 *
 * Handles both motor-controlled valves (main fuel/oxidizer) and solenoid valves
 * with position feedback, rate limiting, and fault detection
 */
class ValveController {
public:
    enum class ValveType {
        MOTOR_CONTROLLED,  // Stepper/servo motor with encoder feedback
        SOLENOID,          // On/off solenoid with position feedback
        PROPORTIONAL       // Proportional solenoid with position feedback
    };

    enum class ValveState { CLOSED, OPENING, OPEN, CLOSING, FAULT, EMERGENCY_STOP };

    struct ValveConfig {
        ValveType type;
        double min_position;        // Minimum position (0.0 = closed)
        double max_position;        // Maximum position (1.0 = fully open)
        double default_rate_limit;  // Default rate limit (1/s)
        double max_rate_limit;      // Maximum rate limit (1/s)
        double position_tolerance;  // Position control tolerance
        double timeout_ms;          // Command timeout
        bool enable_feedback;       // Enable position feedback
        bool enable_force_control;  // Enable force/current limiting
    };

    struct ValveStatus {
        ValveState state;
        double commanded_position;  // Commanded position (0.0 to 1.0)
        double actual_position;     // Actual position from encoder/feedback
        double position_error;      // Position error
        double velocity;            // Current velocity (1/s)
        double current;             // Motor current (A)
        double temperature;         // Motor temperature (°C)
        bool fault_detected;
        std::string fault_message;
        std::chrono::steady_clock::time_point last_update;
        std::chrono::steady_clock::time_point last_command;
    };

    struct MotorControlParams {
        // PID gains for motor control
        double kp, ki, kd;
        double integral_limit;
        double output_limit;

        // Current/force limiting
        double max_current;
        double current_limit_factor;

        // Velocity and acceleration limits
        double max_velocity;
        double max_acceleration;

        // Encoder parameters
        int encoder_resolution;
        double gear_ratio;
        bool encoder_inverted;
    };

    ValveController(const std::string& valve_name, const ValveConfig& config);
    virtual ~ValveController();

    // Control interface
    virtual bool setPosition(double position, double rate_limit = -1.0);
    virtual bool emergencyClose();
    virtual bool resetFault();

    // Status queries
    virtual ValveStatus getStatus() const;
    virtual bool isHealthy() const;
    virtual bool isInPosition(double tolerance = -1.0) const;

    // Configuration
    virtual bool updateConfig(const ValveConfig& config);
    virtual bool updateMotorParams(const MotorControlParams& params);

    // Calibration
    virtual bool calibrateEncoder();
    virtual bool calibrateLimits();
    virtual bool performSelfTest();

protected:
    // Hardware interface (to be implemented by derived classes)
    virtual bool initializeHardware() = 0;
    virtual bool shutdownHardware() = 0;
    virtual bool sendMotorCommand(double position, double velocity, double current_limit) = 0;
    virtual bool readEncoderPosition(double& position) = 0;
    virtual bool readMotorCurrent(double& current) = 0;
    virtual bool readMotorTemperature(double& temperature) = 0;
    virtual bool setSolenoidState(bool state) = 0;
    virtual bool readSolenoidPosition(double& position) = 0;

private:
    void controlLoop();
    void updateStatus();
    void checkFaults();
    void computeMotorCommand();

    // PID control for motor valves
    double computePIDOutput(double error, double dt);

    // Rate limiting
    double applyRateLimit(double target_position, double dt);

    // Fault detection
    bool detectStall();
    bool detectOvercurrent();
    bool detectOvertemperature();
    bool detectTimeout();

    // Configuration
    std::string valve_name_;
    ValveConfig config_;
    MotorControlParams motor_params_;

    // State variables
    std::atomic<bool> running_;
    std::atomic<ValveState> valve_state_;
    std::atomic<double> commanded_position_;
    std::atomic<double> actual_position_;
    std::atomic<double> target_position_;
    std::atomic<double> rate_limit_;
    std::atomic<bool> emergency_close_;

    // PID controller state
    double integral_error_;
    double previous_error_;
    std::chrono::steady_clock::time_point last_pid_update_;

    // Fault detection
    std::atomic<bool> fault_detected_;
    std::string fault_message_;
    std::chrono::steady_clock::time_point last_command_time_;
    std::chrono::steady_clock::time_point last_position_update_;

    // Threading
    std::thread control_thread_;
    std::mutex status_mutex_;
    std::mutex config_mutex_;

    // Timing
    std::chrono::milliseconds control_period_{20};  // 50 Hz control loop
};

/**
 * @brief Motor-Controlled Valve (Stepper/Servo)
 */
class MotorValveController : public ValveController {
public:
    MotorValveController(const std::string& valve_name, const ValveConfig& config,
                         const MotorControlParams& motor_params,
                         const std::string& can_id);  // CAN bus ID for motor controller

protected:
    bool initializeHardware() override;
    bool shutdownHardware() override;
    bool sendMotorCommand(double position, double velocity, double current_limit) override;
    bool readEncoderPosition(double& position) override;
    bool readMotorCurrent(double& current) override;
    bool readMotorTemperature(double& temperature) override;
    bool setSolenoidState(bool state) override {
        return false;
    }  // Not applicable
    bool readSolenoidPosition(double& position) override {
        return false;
    }  // Not applicable

private:
    std::string can_id_;
    // CAN bus interface would be implemented here
};

/**
 * @brief Solenoid Valve Controller
 */
class SolenoidValveController : public ValveController {
public:
    SolenoidValveController(const std::string& valve_name, const ValveConfig& config,
                            const std::string& gpio_pin);  // GPIO pin for solenoid control

protected:
    bool initializeHardware() override;
    bool shutdownHardware() override;
    bool sendMotorCommand(double position, double velocity, double current_limit) override;
    bool readEncoderPosition(double& position) override;
    bool readMotorCurrent(double& current) override;
    bool readMotorTemperature(double& temperature) override;
    bool setSolenoidState(bool state) override;
    bool readSolenoidPosition(double& position) override;

private:
    std::string gpio_pin_;
    bool solenoid_state_;
    // GPIO interface would be implemented here
};

#endif  // VALVE_CONTROLLER_HPP
