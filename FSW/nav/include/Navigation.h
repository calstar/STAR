#ifndef NAVIGATION_H
#define NAVIGATION_H

#include <condition_variable>
#include <memory>
#include <mutex>

#include "../../comms/include/Timer.hpp"
#include "../../utl/Elodin.hpp"
#include "../../utl/TCPSocket.hpp"
#include "../comms/include/mfDiabloSensorMessages.hpp"
#include "../comms/include/mfNavigationMessage.hpp"
#include "../include/Config.h"
#include "../include/DiabloGlobals.h"
#include "DiabloNavigationFilter.hpp"
#include "DiabloSensorFusion.hpp"

// Forward declarations
class Timer;
extern Timer navigation_timer;

/**
 * @brief Navigation subsystem for DiabloAvionics FSW
 *
 * Processes sensor data to compute navigation state (position, velocity, attitude)
 * and publishes to Elodin DB. Follows the reference FSW pattern with condition
 * variables and global state.
 */
class Navigation {
private:
    int msg_count;
    Config config_;
    std::string _nav_server_socket_ip;
    int _nav_server_socket_port;
    int _nav_server_max_clients;
    int _port_min;
    bool is_broadcasting;
    Timer* nav_timer;

    // Our unique navigation components
    std::unique_ptr<DiabloSensorFusion> sensor_fusion_;
    std::unique_ptr<DiabloNavigationFilter> navigation_filter_;

public:
    // Timestamp tracking
    double last_timestamp_imu;
    double last_timestamp_pt;

    // HITL variables
    bool is_hitl;
    bool simulate_velocity_flag;
    std::array<double, 3> hitl_velocity_NED;
    bool simulate_accel_flag;
    std::array<double, 3> hitl_acceleration_NED;

    /* Member Functions */
    void update();
    void populate_navigation_message_ned();  // Uses our sensor fusion and filter

    /* Special Member Functions (SMFs) */
    Navigation(Config config);
    ~Navigation();
};

#endif  // NAVIGATION_H
