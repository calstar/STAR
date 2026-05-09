#include "SITLSimulator.hpp"

#include <chrono>
#include <iostream>
#include <thread>

#include "../include/comms/BarometerMessage.hpp"
#include "../include/comms/GPSMessage.hpp"
#include "../include/comms/IMUMessage.hpp"
#include "../include/comms/PTMessage.hpp"
#include "../include/comms/messages/control/ControlMessages.hpp"
#include "../include/comms/messages/flight/NavigationMessage.hpp"

namespace fsw {
namespace sitl {

SITLSimulator::SITLSimulator()
    : running_(false), simulation_time_(0.0), engine_runner_(nullptr), controller_(nullptr) {
    state_ = SimulationState{};
}

SITLSimulator::~SITLSimulator() {
    stop();
}

bool SITLSimulator::initialize(const SITLConfig& config) {
    config_ = config;

    // Initialize Elodin client
    elodin_client_ = std::make_unique<elodin::ElodinClient>();
    if (!elodin_client_->connect(config_.elodin_host, config_.elodin_port)) {
        std::cerr << "[SITL] Failed to connect to Elodin database" << std::endl;
        return false;
    }

    // Register message tables
    elodin_client_->register_table({0x10, 0x00}, "RawPTMessage");
    elodin_client_->register_table({0x20, 0x00}, "IMUMessage");
    elodin_client_->register_table({0x70, 0x00}, "GPSPositionMessage");
    elodin_client_->register_table({0x80, 0x00}, "BarometerMessage");
    elodin_client_->register_table({0x40, 0x00}, "NavigationMessage");
    elodin_client_->register_table({0x50, 0x00}, "ActuatorCommandMessage");

    // Initialize EKF Navigation
    nav::EKFNavigation::EKFConfig ekf_config;
    ekf_config.position_process_noise = 0.1;
    ekf_config.velocity_process_noise = 0.1;
    ekf_config.attitude_process_noise = 0.01;
    ekf_config.imu_accel_noise = 0.1;
    ekf_config.imu_gyro_noise = 0.01;
    ekf_config.gps_position_noise = 1.0;
    ekf_config.barometer_noise = 100.0;

    ekf_nav_ = std::make_unique<nav::EKFNavigation>();
    nav::EKFNavigation::NavigationState initial_state;
    initial_state.state_vector = Eigen::VectorXd::Zero(nav::EKFNavigation::STATE_DIM);
    initial_state.covariance =
        Eigen::MatrixXd::Identity(nav::EKFNavigation::STATE_DIM, nav::EKFNavigation::STATE_DIM) *
        0.1;

    if (!ekf_nav_->initialize(ekf_config, initial_state)) {
        std::cerr << "[SITL] Failed to initialize EKF Navigation" << std::endl;
        return false;
    }

    // Initialize simulation state
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        state_.P_u_fuel = config_.initial_tank_pressure_fuel;
        state_.P_u_ox = config_.initial_tank_pressure_ox;
        state_.altitude = config_.initial_altitude;
        state_.velocity = config_.initial_velocity;
    }

    // TODO: Initialize engine simulation
    // This will require Python bindings or C++ wrapper for PintleEngineRunner

    std::cout << "[SITL] Simulator initialized successfully" << std::endl;
    return true;
}

void SITLSimulator::start() {
    if (running_) {
        return;
    }

    running_ = true;
    start_time_ = std::chrono::steady_clock::now();
    last_update_time_ = start_time_;
    simulation_time_ = 0.0;

    // Start EKF navigation thread
    ekf_nav_->run();

    // Start simulation thread
    simulation_thread_ = std::thread(&SITLSimulator::simulation_loop, this);

    std::cout << "[SITL] Simulation started" << std::endl;
}

void SITLSimulator::stop() {
    if (!running_) {
        return;
    }

    running_ = false;

    // Stop EKF navigation
    if (ekf_nav_) {
        ekf_nav_->stop();
    }

    // Wait for simulation thread
    if (simulation_thread_.joinable()) {
        simulation_thread_.join();
    }

    // Disconnect from Elodin
    if (elodin_client_) {
        elodin_client_->disconnect();
    }

    std::cout << "[SITL] Simulation stopped" << std::endl;
}

bool SITLSimulator::is_running() const {
    return running_;
}

double SITLSimulator::get_simulation_time() const {
    return simulation_time_;
}

SITLSimulator::SimulationState SITLSimulator::get_state() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return state_;
}

void SITLSimulator::simulation_loop() {
    const double dt = 1.0 / config_.simulation_rate_hz;
    const auto target_period = std::chrono::duration<double>(dt);

    while (running_) {
        auto loop_start = std::chrono::steady_clock::now();

        // Update physics
        update_physics(config_.physics_dt);

        // Publish sensor data
        publish_sensor_data();

        // Process control commands
        process_control_commands();

        // Update EKF
        update_ekf();

        // Update simulation time
        simulation_time_ += dt;

        // Real-time synchronization
        if (config_.realtime) {
            auto elapsed = std::chrono::steady_clock::now() - loop_start;
            if (elapsed < target_period) {
                std::this_thread::sleep_for(target_period - elapsed);
            }
        }
    }
}

void SITLSimulator::publish_sensor_data() {
    SimulationState current_state;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        current_state = state_;
    }

    const auto now = std::chrono::steady_clock::now();
    const auto timestamp_ns =
        std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch()).count();
    const double timestamp_s = timestamp_ns / 1e9;

    // Publish PT messages
    comms::PTMessage pt_copv;
    pt_copv.fields =
        std::make_tuple(timestamp_ns, config_.copv_pt_channel,
                        static_cast<uint32_t>(current_state.P_copv * 1000.0)  // Convert Pa to mPa
        );
    elodin_client_->publish({0x10, 0x00}, pt_copv);

    comms::PTMessage pt_reg;
    pt_reg.fields = std::make_tuple(timestamp_ns, config_.reg_pt_channel,
                                    static_cast<uint32_t>(current_state.P_reg * 1000.0));
    elodin_client_->publish({0x10, 0x00}, pt_reg);

    comms::PTMessage pt_fuel_u;
    pt_fuel_u.fields = std::make_tuple(timestamp_ns, config_.fuel_upstream_pt_channel,
                                       static_cast<uint32_t>(current_state.P_u_fuel * 1000.0));
    elodin_client_->publish({0x10, 0x00}, pt_fuel_u);

    comms::PTMessage pt_ox_u;
    pt_ox_u.fields = std::make_tuple(timestamp_ns, config_.ox_upstream_pt_channel,
                                     static_cast<uint32_t>(current_state.P_u_ox * 1000.0));
    elodin_client_->publish({0x10, 0x00}, pt_ox_u);

    comms::PTMessage pt_fuel_d;
    pt_fuel_d.fields = std::make_tuple(timestamp_ns, config_.fuel_downstream_pt_channel,
                                       static_cast<uint32_t>(current_state.P_d_fuel * 1000.0));
    elodin_client_->publish({0x10, 0x00}, pt_fuel_d);

    comms::PTMessage pt_ox_d;
    pt_ox_d.fields = std::make_tuple(timestamp_ns, config_.ox_downstream_pt_channel,
                                     static_cast<uint32_t>(current_state.P_d_ox * 1000.0));
    elodin_client_->publish({0x10, 0x00}, pt_ox_d);

    // Publish IMU message
    comms::IMUMessage imu_msg;
    imu_msg.fields = std::make_tuple(timestamp_s, current_state.accel_x, current_state.accel_y,
                                     current_state.accel_z, current_state.gyro_x,
                                     current_state.gyro_y, current_state.gyro_z, timestamp_ns);
    elodin_client_->publish({0x20, 0x00}, imu_msg);

    // Publish GPS message
    comms::GPSPositionMessage gps_msg;
    gps_msg.fields =
        std::make_tuple(timestamp_ns, static_cast<uint32_t>(timestamp_s * 1000),
                        1,  // Status: valid
                        current_state.gps_lat, current_state.gps_lon, current_state.gps_altitude,
                        2.5f,  // Horizontal accuracy
                        3.0f,  // Vertical accuracy
                        8      // Satellites
        );
    elodin_client_->publish({0x70, 0x00}, gps_msg);

    // Publish Barometer message
    comms::BarometerMessage baro_msg;
    baro_msg.fields =
        std::make_tuple(timestamp_s, current_state.baro_pressure, current_state.baro_altitude,
                        20.0,  // Temperature (placeholder)
                        timestamp_ns);
    elodin_client_->publish({0x80, 0x00}, baro_msg);
}

void SITLSimulator::process_control_commands() {
    // TODO: Subscribe to control commands from Elodin
    // For now, this is a placeholder
    // In Betaflight pattern, this would read actuator commands and apply them to simulation
}

void SITLSimulator::update_physics(double dt) {
    std::lock_guard<std::mutex> lock(state_mutex_);

    // TODO: Integrate with engine simulation
    // This should call PintleEngineRunner.evaluate() with current tank pressures
    // and update state based on physics simulation

    // Placeholder physics update
    // In real implementation, this would:
    // 1. Get actuation commands (solenoid duty cycles)
    // 2. Compute mass flows based on pressures and duty cycles
    // 3. Run engine simulation to get thrust, chamber pressure, etc.
    // 4. Update vehicle dynamics (altitude, velocity, acceleration)
    // 5. Update tank pressures based on mass flows
    // 6. Update sensor readings (with noise)

    // Simple placeholder: update altitude based on velocity
    state_.altitude += state_.velocity * dt;
    state_.velocity += state_.acceleration * dt;

    // Update accelerations (gravity + thrust)
    const double g = 9.81;
    state_.acceleration = (state_.thrust / 100.0) - g;  // Placeholder: assume 100kg vehicle
    state_.accel_z = state_.acceleration;
}

void SITLSimulator::update_ekf() {
    // Get current state
    SimulationState current_state;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        current_state = state_;
    }

    // Process IMU measurement
    nav::EKFNavigation::IMUMeasurement imu_meas;
    imu_meas.accel_x = current_state.accel_x;
    imu_meas.accel_y = current_state.accel_y;
    imu_meas.accel_z = current_state.accel_z;
    imu_meas.gyro_x = current_state.gyro_x;
    imu_meas.gyro_y = current_state.gyro_y;
    imu_meas.gyro_z = current_state.gyro_z;
    imu_meas.timestamp = std::chrono::steady_clock::now();
    ekf_nav_->processIMUMeasurement(imu_meas);

    // Process GPS measurement
    nav::EKFNavigation::GPSMeasurement gps_meas;
    gps_meas.latitude = current_state.gps_lat;
    gps_meas.longitude = current_state.gps_lon;
    gps_meas.altitude = current_state.gps_altitude;
    gps_meas.velocity_x = 0.0;  // TODO: Compute from state
    gps_meas.velocity_y = 0.0;
    gps_meas.velocity_z = -current_state.velocity;
    gps_meas.timestamp = std::chrono::steady_clock::now();
    ekf_nav_->processGPSMeasurement(gps_meas);

    // Process Barometer measurement
    nav::EKFNavigation::BarometerMeasurement baro_meas;
    baro_meas.pressure = current_state.baro_pressure;
    baro_meas.altitude = current_state.baro_altitude;
    baro_meas.timestamp = std::chrono::steady_clock::now();
    ekf_nav_->processBarometerMeasurement(baro_meas);

    // Process Engine measurement
    nav::EKFNavigation::EngineMeasurement engine_meas;
    engine_meas.thrust = current_state.thrust;
    engine_meas.mass_flow = current_state.mass_flow_fuel + current_state.mass_flow_ox;
    engine_meas.chamber_pressure = current_state.P_chamber;
    engine_meas.timestamp = std::chrono::steady_clock::now();
    ekf_nav_->processEngineMeasurement(engine_meas);

    // Get EKF state and publish navigation message
    auto nav_state = ekf_nav_->getCurrentState();
    comms::messages::flight::NavigationMessage nav_msg;
    nav_msg.fields = std::make_tuple(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count(),
        nav_state.position_x, nav_state.position_y, nav_state.position_z, nav_state.velocity_x,
        nav_state.velocity_y, nav_state.velocity_z, nav_state.attitude_qw, nav_state.attitude_qx,
        nav_state.attitude_qy, nav_state.attitude_qz, nav_state.accel_x, nav_state.accel_y,
        nav_state.accel_z);
    elodin_client_->publish({0x40, 0x00}, nav_msg);
}

}  // namespace sitl
}  // namespace fsw
