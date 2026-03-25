#ifndef FSW_CONTROL_CONTROLLER_SERVICE_HPP
#define FSW_CONTROL_CONTROLLER_SERVICE_HPP

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "ControllerLUT.hpp"
#include "RobustDDPController.hpp"
#include "calibration/PTCalibration.hpp"
#include "elodin/ElodinClient.hpp"

namespace fsw {
namespace control {

/**
 * @brief C++ controller service with UDP PWM output
 *
 * Pipeline:
 *   sensor data (pushed via setMeasurement) → RobustDDPController::step()
 *   → PWM command UDP packet (combined_gui.py format) → actuator board
 *
 * Optionally writes to Elodin DB if connected.
 */
class ControllerService {
public:
    // ── PWM / actuator config ──────────────────────────────────────────
    struct PWMConfig {
        std::string actuator_board_ip = "192.168.2.201";
        uint16_t actuator_port = 5005;
        uint8_t fuel_channel = 3;  // Fuel Press actuator channel
        uint8_t lox_channel = 8;   // LOX Press actuator channel
        float frequency_hz = 10.0f;
        uint32_t duration_ms = 1000;  // PWM burst duration per command
    };

    ControllerService();
    ~ControllerService();

    /**
     * @brief Initialize the controller service
     * @param pwm_config       PWM output configuration (board IP, channels, …)
     * @param controller_config Controller algorithm configuration
     * @param elodin_host      Elodin DB host (empty string = skip DB)
     * @param elodin_port      Elodin DB port (default 2240)
     * @param relay_host       Elodin relay host for sensor data
     * @param relay_port       Elodin relay port
     * @param lut_path         Optional path to LUT binary. If non-empty and load succeeds,
     *                         bypasses DDP and uses LUT for boolean control (u_safe_F/O > 0.5).
     * @param thrust_curve_path Optional path to thrust curve CSV (time_s,thrust_N). When set
     *                         and fire is active, thrust_desired is interpolated from curve.
     * @return true if initialization succeeded
     */
    bool initialize(const PWMConfig& pwm_config,
                    const RobustDDPController::Config& controller_config,
                    const std::string& elodin_host = "", uint16_t elodin_port = 2240,
                    const std::string& relay_host = "127.0.0.1", uint16_t relay_port = 9090,
                    const std::string& lut_path = "", const std::string& thrust_curve_path = "");

    /** Start the controller loop at the given rate. */
    bool start(double loop_rate_hz = 10.0);

    /** Stop the controller loop. */
    void stop();

    bool is_running() const {
        return running_;
    }

    // ── Thread-safe data setters (called from external sensor thread) ──
    void setMeasurement(const RobustDDPController::Measurement& meas);
    void setCommand(const RobustDDPController::Command& cmd);
    void setNavState(const RobustDDPController::NavState& nav);

    /**
     * @brief Enable or disable PWM output (FIRE state gate).
     * PWM is only sent while fire_active_ is true.
     * Called by the TCP control thread when FIRE_START / FIRE_STOP is received.
     */
    void setFireActive(bool active);

    /**
     * @brief Override controller output with fixed duty cycles for open-loop validation.
     * When both values are 0 (default), the RobustDDP controller runs normally.
     * Set non-zero to bypass the controller and send these fixed duties on every FIRE tick.
     */
    void setTestDuty(float fuel, float ox);

    /** Get last actuation output (for diagnostics / GUI broadcast). */
    RobustDDPController::ActuationCommand getLastActuation() const;
    RobustDDPController::Diagnostics getLastDiagnostics() const;

private:
    // ── PWM packet sending ─────────────────────────────────────────────
    /**
     * Send a PWM actuator command over UDP.
     * Packet format matches combined_gui.py exactly:
     *   Header  <BBI>: packet_type=10, version=0, timestamp_ms(u32)
     *   Body    <B>  : num_commands
     *   Per-cmd <BIff>: actuator_id, duration_ms, duty_cycle, frequency
     */
    bool sendPWMCommand(uint8_t channel, float duty_cycle, float frequency, uint32_t duration_ms);

    /** Single UDP packet with both channels (fuel + LOX) for fire-state commands. */
    bool sendPWMCommands(uint8_t channel1, float duty1, uint8_t channel2, float duty2,
                         float frequency, uint32_t duration_ms);

    /** Send both fuel + LOX PWM commands for a given actuation output (one packet). */
    void sendActuationPWM(const RobustDDPController::ActuationCommand& act);

    // ── Elodin DB (optional) ───────────────────────────────────────────
    bool registerControllerTables();
    void writeActuationToDB(const RobustDDPController::ActuationCommand& actuation);
    void writeDiagnosticsToDB(const RobustDDPController::Diagnostics& diagnostics);
    void writeMeasurementToDB(const RobustDDPController::Measurement& measurement);

    // ── Controller loop ────────────────────────────────────────────────
    void controllerLoop();
    void elodinSubscriberLoop();
    void relaySubscriberLoop();

    // ── State ──────────────────────────────────────────────────────────
    std::atomic<bool> running_{false};
    std::atomic<bool> fire_active_{false};  // PWM only sent when FIRE state is active

    // Open-loop test duty cycles (0 = use DDP controller; non-zero = bypass DDP)
    std::atomic<float> test_duty_fuel_{0.0f};
    std::atomic<float> test_duty_ox_{0.0f};

    // Controller algorithm (DDP when LUT not used)
    std::unique_ptr<RobustDDPController> controller_;

    // Optional LUT for boolean control (bypasses DDP when loaded)
    ControllerLUT lut_;

    // Elodin DB (write-only; used for publishing actuation/diagnostics)
    std::unique_ptr<elodin::ElodinClient> elodin_client_;
    bool elodin_connected_ = false;

    // Relay WebSocket (for reading PT sensor data)
    std::string relay_host_ = "127.0.0.1";
    uint16_t relay_port_ = 9090;

    // Inline PT calibration (raw ADC → PSI) — loaded from default JSON calibration files
    fsw::calibration::PTCalibrationManager pt_calibration_;

    // PWM output
    PWMConfig pwm_config_;
    int udp_socket_fd_ = -1;

    // Thread-safe sensor inputs
    mutable std::mutex input_mutex_;
    RobustDDPController::Measurement current_meas_{};
    RobustDDPController::Command current_cmd_{};
    RobustDDPController::NavState current_nav_{};
    bool has_measurement_ = false;

    // Last outputs (thread-safe read)
    mutable std::mutex output_mutex_;
    RobustDDPController::ActuationCommand last_actuation_{};
    RobustDDPController::Diagnostics last_diagnostics_{};

    // Loop timing
    std::thread controller_thread_;
    std::thread elodin_subscriber_thread_;
    std::thread relay_subscriber_thread_;
    double loop_rate_hz_ = 10.0;
    double loop_interval_ms_ = 100.0;

    // Thrust curve (time-varying target from Layer 2 pressure curves)
    std::vector<double> thrust_curve_times_;
    std::vector<double> thrust_curve_values_;
    std::chrono::steady_clock::time_point fire_start_time_;
    bool thrust_curve_loaded_ = false;

    bool loadThrustCurve(const std::string& path);
    double interpolateThrustCurve(double t_elapsed_s) const;
};

}  // namespace control
}  // namespace fsw

#endif  // FSW_CONTROL_CONTROLLER_SERVICE_HPP
