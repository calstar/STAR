#ifndef FSW_CONTROL_CONTROLLER_SERVICE_HPP
#define FSW_CONTROL_CONTROLLER_SERVICE_HPP

#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include "RobustDDPController.hpp"
#include "elodin/ElodinClient.hpp"

namespace fsw {
namespace control {

/**
 * @brief C++ controller service integrated with Elodin DB
 *
 * This service wraps RobustDDPController and provides:
 * - Reading sensor measurements from Elodin DB
 * - Running controller computations
 * - Writing controller outputs (actuation + diagnostics) to Elodin DB
 * - Full support for SITL and HITL runs with replay capability
 */
class ControllerService {
public:
    ControllerService();
    ~ControllerService();

    /**
     * @brief Initialize the controller service
     * @param elodin_host Elodin DB host address
     * @param elodin_port Elodin DB port (default 2240)
     * @param controller_config Controller configuration
     * @return true if initialization successful
     */
    bool initialize(const std::string& elodin_host, uint16_t elodin_port,
                    const RobustDDPController::Config& controller_config);

    /**
     * @brief Start the controller loop
     * @param loop_rate_hz Controller loop rate in Hz (default 10 Hz)
     * @return true if started successfully
     */
    bool start(double loop_rate_hz = 10.0);

    /**
     * @brief Stop the controller loop
     */
    void stop();

    /**
     * @brief Check if controller is running
     */
    bool is_running() const {
        return running_;
    }

private:
    /**
     * @brief Register controller message tables with Elodin DB
     */
    bool registerControllerTables();

    /**
     * @brief Main controller loop (runs in separate thread)
     */
    void controllerLoop();

    /**
     * @brief Write actuation command to Elodin DB
     */
    void writeActuationToDB(const RobustDDPController::ActuationCommand& actuation);

    /**
     * @brief Write diagnostics to Elodin DB
     */
    void writeDiagnosticsToDB(const RobustDDPController::Diagnostics& diagnostics);

    /**
     * @brief Write measurement to Elodin DB (for replay)
     */
    void writeMeasurementToDB(const RobustDDPController::Measurement& measurement);

    std::atomic<bool> running_;
    std::unique_ptr<elodin::ElodinClient> elodin_client_;
    std::unique_ptr<RobustDDPController> controller_;
    std::thread controller_thread_;
    double loop_rate_hz_ = 10.0;
    double loop_interval_ms_ = 100.0;
};

}  // namespace control
}  // namespace fsw

#endif  // FSW_CONTROL_CONTROLLER_SERVICE_HPP




