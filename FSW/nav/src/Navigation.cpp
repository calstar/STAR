#include "../include/Navigation.h"
#include "../../include/DiabloGlobals.h"
#include "../../../comms/include/Timer.hpp"
#include <iostream>
#include <cmath>
#include <cstdint>

// navigation_timer is defined in DiabloGlobals.cpp

// Forward declarations for globals
extern std::mutex NAVIGATION_MESSAGE_LOCK;
extern std::mutex NAVIGATION_CONDITION_LOCK;
extern std::condition_variable nav_cv;
extern mfNavigationMessage navigation_message;
extern std::mutex ELODIN_DB_LOCK;
extern std::unique_ptr<Socket> Sock;
extern uint8_t NAV_ID;

Navigation::Navigation(Config config)
    : msg_count(0),
      config_(config),
      _nav_server_socket_ip(config.navigation.publish_ip),
      _nav_server_socket_port(config.navigation.publish_port),
      _nav_server_max_clients(config.navigation.publish_max_clients),
      _port_min(config.network.port_min),
      is_broadcasting(false),
      nav_timer(&navigation_timer),
      last_timestamp_imu(__DBL_MAX__),
      last_timestamp_pt(__DBL_MAX__),
      is_hitl(config.hitl.HITL_flag),
      simulate_velocity_flag(config.hitl.simulate_velocity_flag),
      hitl_velocity_NED(config.hitl.simulated_velocity_NED),
      simulate_accel_flag(config.hitl.simulate_accel_flag),
      hitl_acceleration_NED(config.hitl.simulated_accel_NED),
      sensor_fusion_(std::make_unique<DiabloSensorFusion>()),
      navigation_filter_(std::make_unique<DiabloNavigationFilter>()) {
    
    // Initialize navigation filter with config
    DiabloNavigationFilter::FilterConfig filter_config;
    filter_config.altitude_measurement_noise = 100.0;  // m²
    filter_config.thrust_measurement_noise = 1000.0;   // N²
    filter_config.initial_altitude_uncertainty = 50.0; // m
    filter_config.enable_adaptive_noise = true;
    navigation_filter_->initialize(filter_config);
    
    if (is_hitl) {
        std::cout << "[Navigation] HITL is enabled; velocity and acceleration will be simulated" << std::endl;
    }
    
    std::cout << "[Navigation] Initialized with sensor fusion and navigation filter on " 
              << _nav_server_socket_ip << ":" << _nav_server_socket_port << std::endl;
}

Navigation::~Navigation() {
    std::cout << "[Navigation] Destructor called" << std::endl;
}

void Navigation::populate_navigation_message_ned() {
    // Use our unique sensor fusion and navigation filter approach
    uint64_t time_monotonic = nav_timer->get_time_ns();
    
    // Step 1: Fuse sensor data from all our DiabloAvionics sensors
    auto fused_measurement = sensor_fusion_->fuseSensorData();
    
    // Step 2: Update navigation filter with fused measurement
    auto filter_state = navigation_filter_->update(fused_measurement);
    
    // Step 3: Build navigation message from filter state
    // Note: We focus on vertical navigation (altitude, vertical velocity) since
    // we're primarily an engine control system, not a full 6DOF navigation system
    std::array<double, 4> quat_ned_to_body = {1.0, 0.0, 0.0, 0.0}; // Identity (no IMU yet)
    
    // Position: Use altitude from filter, keep default lat/lon (could be set from GPS later)
    std::array<double, 3> pos_lla = {
        37.7749,  // Default latitude
        -122.4194, // Default longitude
        filter_state.altitude_m  // Filtered altitude
    };
    
    // Velocity: Focus on vertical velocity (could add horizontal from GPS/IMU later)
    std::array<double, 3> vel_ned = {
        0.0,  // North velocity (unknown without GPS/IMU)
        0.0,  // East velocity (unknown without GPS/IMU)
        filter_state.vertical_velocity_ms  // Filtered vertical velocity
    };
    
    // Acceleration: Estimate from thrust and vehicle dynamics
    // a = (thrust - drag - weight) / mass
    // For now, use simple estimate from vertical velocity change
    std::array<double, 3> accel_ned = {
        0.0,  // North acceleration
        0.0,  // East acceleration
        (filter_state.thrust_n / 100.0) - 9.81  // Rough estimate: thrust/mass - gravity
        // TODO: Get actual vehicle mass from config
    };
    
    // Apply HITL overrides if enabled
    if (is_hitl) {
        if (simulate_velocity_flag) {
            vel_ned = hitl_velocity_NED;
        }
        if (simulate_accel_flag) {
            accel_ned = hitl_acceleration_NED;
        }
    }
    
    // Update global navigation message
    {
        std::lock_guard<std::mutex> lock(NAVIGATION_MESSAGE_LOCK);
        set_navigation_message(navigation_message, time_monotonic,
                              quat_ned_to_body, pos_lla, vel_ned, accel_ned);
    }
    
    // Publish to Elodin DB
    std::array<uint8_t, 2> packet_id{NAV_ID, 0};
    {
        std::lock_guard<std::mutex> lock(ELODIN_DB_LOCK);
        if (Sock) {
            write_to_elodindb(packet_id, navigation_message);
        }
    }
    
    msg_count++;
    if (msg_count % 100 == 0) {
        std::cout << "[Navigation] Published " << msg_count 
                  << " messages | Altitude: " << filter_state.altitude_m << "m"
                  << " | V_vert: " << filter_state.vertical_velocity_ms << "m/s"
                  << " | Thrust: " << filter_state.thrust_n << "N"
                  << " | Quality: " << filter_state.state_quality << std::endl;
    }
}

void Navigation::update() {
    std::unique_lock<std::mutex> navigation_condition_lock(NAVIGATION_CONDITION_LOCK);
    
    while (true) {
        // Wait for condition variable to be notified (when new sensor data arrives)
        nav_cv.wait(navigation_condition_lock);
        
        // Check state machine for abort
        StateMachineOutput _state_machine_output;
        {
            std::lock_guard<std::mutex> state_machine_output_lock(STATE_MACHINE_OUTPUT_LOCK);
            _state_machine_output = state_machine_output;
        }
        
        // Break if abort mode
        if (static_cast<EngineMode>(_state_machine_output.template getField<1>()) == EngineMode::ABORT) {
            break;
        }
        
        // Process and publish navigation message using all available sensors
        populate_navigation_message_ned();
    }
    
    std::cout << "[Navigation] Navigation loop exited" << std::endl;
}
