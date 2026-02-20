#ifndef SITL_SIMULATOR_HPP
#define SITL_SIMULATOR_HPP

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "../include/control/PressureStateMachine.hpp"
#include "../include/elodin/ElodinClient.hpp"
#include "../include/nav/EKFNavigation.hpp"

namespace fsw {
namespace sitl {

/**
 * @brief Software-In-The-Loop (SITL) Simulator
 *
 * Integrates engine simulation with FSW system for testing control algorithms.
 * Follows Betaflight SITL pattern:
 * - Runs simulation loop at fixed rate
 * - Generates sensor data from simulation
 * - Publishes sensor data to Elodin
 * - Subscribes to control commands from Elodin
 * - Applies commands to simulation
 * - Runs EKF navigation filter on simulated sensor data
 */
class SITLSimulator {
public:
    struct SITLConfig {
        // Elodin connection
        std::string elodin_host = "127.0.0.1";
        uint16_t elodin_port = 2240;

        // Simulation parameters
        double simulation_rate_hz = 100.0;  // Simulation loop rate
        double physics_dt = 0.01;           // Physics timestep (seconds)
        bool realtime = true;               // Run in real-time or as fast as possible

        // Engine simulation config
        std::string engine_config_path = "engine_sim/configs/default.yaml";
        std::string controller_config_path = "engine_sim/configs/controller_default.yaml";

        // Sensor channel mappings
        uint8_t copv_pt_channel = 0;
        uint8_t reg_pt_channel = 1;
        uint8_t fuel_upstream_pt_channel = 2;
        uint8_t ox_upstream_pt_channel = 3;
        uint8_t fuel_downstream_pt_channel = 4;
        uint8_t ox_downstream_pt_channel = 5;

        // Initial conditions
        double initial_altitude = 0.0;                        // [m]
        double initial_velocity = 0.0;                        // [m/s]
        double initial_tank_pressure_fuel = 974.0 * 6894.76;  // [Pa] (974 psi)
        double initial_tank_pressure_ox = 1305.0 * 6894.76;   // [Pa] (1305 psi)
    };

    SITLSimulator();
    ~SITLSimulator();

    /**
     * @brief Initialize simulator
     * @param config Configuration
     * @return true if successful
     */
    bool initialize(const SITLConfig& config);

    /**
     * @brief Start simulation loop
     */
    void start();

    /**
     * @brief Stop simulation loop
     */
    void stop();

    /**
     * @brief Check if simulator is running
     */
    bool is_running() const;

    /**
     * @brief Get current simulation time
     */
    double get_simulation_time() const;

    /**
     * @brief Get current state
     */
    struct SimulationState {
        // Pressures [Pa]
        double P_copv;
        double P_reg;
        double P_u_fuel;
        double P_u_ox;
        double P_d_fuel;
        double P_d_ox;
        double P_chamber;

        // Engine performance
        double thrust;          // [N]
        double mass_flow_fuel;  // [kg/s]
        double mass_flow_ox;    // [kg/s]
        double mixture_ratio;

        // Vehicle state
        double altitude;      // [m]
        double velocity;      // [m/s]
        double acceleration;  // [m/s²]

        // IMU data
        double accel_x, accel_y, accel_z;  // [m/s²]
        double gyro_x, gyro_y, gyro_z;     // [rad/s]

        // GPS data
        double gps_lat, gps_lon;  // [deg]
        double gps_altitude;      // [m]
        double gps_velocity;      // [m/s]

        // Barometer
        double baro_pressure;  // [Pa]
        double baro_altitude;  // [m]
    };

    SimulationState get_state() const;

private:
    void simulation_loop();
    void publish_sensor_data();
    void process_control_commands();
    void update_physics(double dt);
    void update_ekf();

    // Elodin client
    std::unique_ptr<elodin::ElodinClient> elodin_client_;

    // EKF Navigation filter
    std::unique_ptr<nav::EKFNavigation> ekf_nav_;

    // Configuration
    SITLConfig config_;

    // Simulation state
    SimulationState state_;
    mutable std::mutex state_mutex_;

    // Timing
    std::atomic<bool> running_;
    std::atomic<double> simulation_time_;
    std::thread simulation_thread_;
    std::chrono::steady_clock::time_point start_time_;
    std::chrono::steady_clock::time_point last_update_time_;

    // Engine simulation (Python bindings or C++ wrapper)
    // TODO: Add engine simulation interface
    void* engine_runner_;  // Placeholder for engine simulation
    void* controller_;     // Placeholder for DDP controller
};

}  // namespace sitl
}  // namespace fsw

#endif  // SITL_SIMULATOR_HPP



