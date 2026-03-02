#ifndef FSW_CONTROL_CONTROLLER_SERVICE_HPP
#define FSW_CONTROL_CONTROLLER_SERVICE_HPP

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "RobustDDPController.hpp"
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
     * @return true if initialization succeeded
     */
    bool initialize(const PWMConfig& pwm_config,
                    const RobustDDPController::Config& controller_config,
                    const std::string& elodin_host = "", uint16_t elodin_port = 2240);

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

    /** Send both fuel + LOX PWM commands for a given actuation output. */
    void sendActuationPWM(const RobustDDPController::ActuationCommand& act);

    // ── Elodin DB (optional) ───────────────────────────────────────────
    bool registerControllerTables();
    void writeActuationToDB(const RobustDDPController::ActuationCommand& actuation);
    void writeDiagnosticsToDB(const RobustDDPController::Diagnostics& diagnostics);
    void writeMeasurementToDB(const RobustDDPController::Measurement& measurement);

    // ── Controller loop ────────────────────────────────────────────────
    void controllerLoop();
    void elodinSubscriberLoop();

    // ── State ──────────────────────────────────────────────────────────
    std::atomic<bool> running_{false};

    // Controller algorithm
    std::unique_ptr<RobustDDPController> controller_;

    // Elodin DB (may be nullptr if not connected)
    std::unique_ptr<elodin::ElodinClient> elodin_client_;
    bool elodin_connected_ = false;

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
    double loop_rate_hz_ = 10.0;
    double loop_interval_ms_ = 100.0;
};

}  // namespace control
}  // namespace fsw

#endif  // FSW_CONTROL_CONTROLLER_SERVICE_HPP
