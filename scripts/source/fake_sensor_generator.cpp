#include <iostream>
#include <thread>
#include <chrono>
#include <random>
#include <memory>
#include <signal.h>
#include <unistd.h>

#include "../external/shared/message_factory/MessageFactory.hpp"
#include "../comms/include/PTMessage.hpp"
#include "../comms/include/TCMessage.hpp"
#include "../comms/include/RTDMessage.hpp"
#include "../comms/include/IMUMessage.hpp"
#include "../comms/include/BarometerMessage.hpp"
#include "../comms/include/GPSMessage.hpp"
#include "../utl/Elodin.hpp"
#include "../utl/TCPSocket.hpp"
#include "../utl/dbConfig.hpp"
#include "../comms/include/Timer.hpp"

// Global variables for cleanup
std::unique_ptr<Socket> LocalSock;
std::unique_ptr<Socket> GroundStationSock;
bool running = true;

// Signal handler for graceful shutdown
void signalHandler(int signum) {
    (void)signum; // Suppress unused parameter warning
    std::cout << "\nShutting down sensor generator..." << std::endl;
    running = false;
}

// Random number generators
std::random_device rd;
std::mt19937 gen(rd());
std::normal_distribution<double> normal_dist(0.0, 1.0);

// Global state for trends and drift
double pressure_trend = 0.0;
double temperature_trend = 0.0;
double imu_drift_x = 0.0, imu_drift_y = 0.0, imu_drift_z = 0.0;
double gps_lat_drift = 0.0, gps_lon_drift = 0.0;

// PT Sensor Generator
void generatePTData() {
    // Base values with trends
    double base_pressure = 101325.0; // Standard atmospheric pressure
    double base_temperature = 25.0;  // Room temperature
    
    while (running) {
        uint64_t time_ns = Timer::get_time_ns();
        double time_s = static_cast<double>(time_ns) / 1e9;
        
        PTMessage pt_msg;
        
        // Add slow trends (weather-like changes)
        pressure_trend += normal_dist(gen) * 0.1;  // Slow pressure drift
        temperature_trend += normal_dist(gen) * 0.05; // Slow temperature drift
        
        // Add periodic variations (daily cycles)
        double daily_pressure = 200.0 * sin(time_s * 2 * M_PI / 86400.0); // 24-hour cycle
        double daily_temp = 5.0 * sin(time_s * 2 * M_PI / 86400.0 + M_PI/4); // 24-hour cycle with offset
        
        // Add noise
        double pressure_noise = normal_dist(gen) * 10.0; // 10 Pa noise
        double temp_noise = normal_dist(gen) * 0.5; // 0.5°C noise
        
        double pressure = base_pressure + pressure_trend + daily_pressure + pressure_noise;
        double temperature = base_temperature + temperature_trend + daily_temp + temp_noise;
        
        set_pt_measurement(pt_msg, time_s, pressure, temperature, time_ns);
        
        // Write to database
        std::array<uint8_t, 2> packet_id = {0x02, 0x00}; // PT sensor ID
        try {
            write_to_elodindb(packet_id, pt_msg);
            LocalSock->flush_elodin(); // Flush buffer to ensure data is sent
            std::cout << "PT: P=" << pressure << " Pa, T=" << temperature << " C [SENT]" << std::endl;
        } catch (const std::exception& e) {
            std::cerr << "❌ Failed to send PT data: " << e.what() << std::endl;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100)); // 10 Hz
    }
}

// TC Sensor Generator
void generateTCData() {
    std::uniform_real_distribution<double> temp_dist(100.0, 200.0); // C
    std::uniform_real_distribution<double> voltage_dist(0.001, 0.010); // V
    std::uniform_real_distribution<double> noise_dist(-0.05, 0.05);
    
    while (running) {
        uint64_t time_ns = Timer::get_time_ns();
        double time_s = static_cast<double>(time_ns) / 1e9;
        
        TCMessage tc_msg;
        double temperature = temp_dist(gen) + noise_dist(gen);
        double voltage = voltage_dist(gen) + noise_dist(gen) * 0.001;
        uint8_t tc_type = 0; // Type K
        
        set_tc_measurement(tc_msg, time_s, temperature, voltage, tc_type, time_ns);
        
        // Write to database
        std::array<uint8_t, 2> packet_id = {0x03, 0x00}; // TC sensor ID
        write_to_elodindb(packet_id, tc_msg);
        LocalSock->flush_elodin(); // Flush buffer to ensure data is sent
        
        std::cout << "TC: T=" << temperature << " C, V=" << voltage << " V" << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(200)); // 5 Hz
    }
}

// RTD Sensor Generator
void generateRTDData() {
    std::uniform_real_distribution<double> temp_dist(15.0, 35.0); // C
    std::uniform_real_distribution<double> resistance_dist(95.0, 105.0); // Ohm
    std::uniform_real_distribution<double> noise_dist(-0.02, 0.02);
    
    while (running) {
        uint64_t time_ns = Timer::get_time_ns();
        double time_s = static_cast<double>(time_ns) / 1e9;
        
        RTDMessage rtd_msg;
        double temperature = temp_dist(gen) + noise_dist(gen);
        double resistance = resistance_dist(gen) + noise_dist(gen);
        uint8_t rtd_type = 0; // PT100
        
        set_rtd_measurement(rtd_msg, time_s, temperature, resistance, rtd_type, time_ns);
        
        // Write to database
        std::array<uint8_t, 2> packet_id = {0x04, 0x00}; // RTD sensor ID
        write_to_elodindb(packet_id, rtd_msg);
        LocalSock->flush_elodin(); // Flush buffer to ensure data is sent
        
        std::cout << "RTD: T=" << temperature << " C, R=" << resistance << " Ohm" << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(500)); // 2 Hz
    }
}

// IMU Sensor Generator
void generateIMUData() {
    while (running) {
        uint64_t time_ns = Timer::get_time_ns();
        double time_s = static_cast<double>(time_ns) / 1e9;
        
        IMUMessage imu_msg;
        
        // Add IMU drift (bias instability)
        imu_drift_x += normal_dist(gen) * 0.0001;
        imu_drift_y += normal_dist(gen) * 0.0001;
        imu_drift_z += normal_dist(gen) * 0.0001;
        
        // Add periodic motion (vibration, rotation)
        double vibration_freq = 10.0; // 10 Hz vibration
        double rotation_freq = 0.1;   // 0.1 Hz slow rotation
        
        double vibration_x = 0.5 * sin(time_s * 2 * M_PI * vibration_freq);
        double vibration_y = 0.3 * sin(time_s * 2 * M_PI * vibration_freq + M_PI/3);
        double vibration_z = 0.2 * sin(time_s * 2 * M_PI * vibration_freq + M_PI/6);
        
        double rotation_x = 0.1 * sin(time_s * 2 * M_PI * rotation_freq);
        double rotation_y = 0.15 * sin(time_s * 2 * M_PI * rotation_freq + M_PI/2);
        double rotation_z = 0.05 * sin(time_s * 2 * M_PI * rotation_freq + M_PI/4);
        
        // Add noise
        double accel_noise = normal_dist(gen) * 0.1; // 0.1 m/s² noise
        double gyro_noise = normal_dist(gen) * 0.01; // 0.01 rad/s noise
        
        std::array<double, 3> accel = {
            vibration_x + rotation_x + imu_drift_x + accel_noise,
            vibration_y + rotation_y + imu_drift_y + accel_noise,
            9.81 + vibration_z + rotation_z + imu_drift_z + accel_noise // Gravity + motion
        };
        std::array<double, 3> gyro = {
            rotation_x + imu_drift_x + gyro_noise,
            rotation_y + imu_drift_y + gyro_noise,
            rotation_z + imu_drift_z + gyro_noise
        };
        
        set_imu_measurement(imu_msg, time_s, accel, gyro, time_ns);
        
        // Write to database
        std::array<uint8_t, 2> packet_id = {0x01, 0x00}; // IMU sensor ID
        write_to_elodindb(packet_id, imu_msg);
        LocalSock->flush_elodin(); // Flush buffer to ensure data is sent
        
        std::cout << "IMU: Accel=[" << accel[0] << ", " << accel[1] << ", " << accel[2] 
                  << "], Gyro=[" << gyro[0] << ", " << gyro[1] << ", " << gyro[2] << "]" << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(10)); // 100 Hz
    }
}

// Barometer Sensor Generator
void generateBarometerData() {
    std::uniform_real_distribution<double> pressure_dist(95000.0, 105000.0); // Pa
    std::uniform_real_distribution<double> altitude_dist(-10.0, 10.0); // m
    std::uniform_real_distribution<double> temp_dist(20.0, 30.0); // C
    std::uniform_real_distribution<double> noise_dist(-0.1, 0.1);
    
    while (running) {
        uint64_t time_ns = Timer::get_time_ns();
        double time_s = static_cast<double>(time_ns) / 1e9;
        
        BarometerMessage bar_msg;
        double pressure = pressure_dist(gen) + noise_dist(gen);
        double altitude = altitude_dist(gen) + noise_dist(gen);
        double temperature = temp_dist(gen) + noise_dist(gen);
        
        set_barometer_measurement(bar_msg, time_s, pressure, altitude, temperature, time_ns);
        
        // Write to database
        std::array<uint8_t, 2> packet_id = {0x05, 0x00}; // Barometer sensor ID
        write_to_elodindb(packet_id, bar_msg);
        LocalSock->flush_elodin(); // Flush buffer to ensure data is sent
        
        std::cout << "Barometer: P=" << pressure << " Pa, Alt=" << altitude 
                  << " m, T=" << temperature << " C" << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(50)); // 20 Hz
    }
}

// GPS Sensor Generator
void generateGPSData() {
    // Base location (San Francisco)
    double base_lat = 37.7749;
    double base_lon = -122.4194;
    double base_alt = 50.0;
    
    // Movement parameters
    double speed = 10.0; // m/s (36 km/h)
    double heading = 0.0; // degrees
    
    while (running) {
        uint64_t time_ns = Timer::get_time_ns();
        double time_s = static_cast<double>(time_ns) / 1e9;
        
        // Simulate vehicle movement (circular path with some randomness)
        double radius = 1000.0; // 1 km radius
        double angular_velocity = speed / radius; // rad/s
        
        // Add some heading changes
        heading += normal_dist(gen) * 0.1; // Random heading changes
        double current_angle = time_s * angular_velocity + heading;
        
        // Calculate position
        double lat_offset = radius * cos(current_angle) / 111000.0; // Convert to degrees
        double lon_offset = radius * sin(current_angle) / (111000.0 * cos(base_lat * M_PI / 180.0));
        
        // Add GPS drift
        gps_lat_drift += normal_dist(gen) * 0.00001;
        gps_lon_drift += normal_dist(gen) * 0.00001;
        
        // Add altitude variations
        double alt_variation = 20.0 * sin(time_s * 0.1) + normal_dist(gen) * 2.0;
        
        double latitude = base_lat + lat_offset + gps_lat_drift + normal_dist(gen) * 0.0001;
        double longitude = base_lon + lon_offset + gps_lon_drift + normal_dist(gen) * 0.0001;
        double altitude = base_alt + alt_variation;
        uint32_t time_gps = time_ns / 1000000; // Convert to ms
        
        // GPS Position
        GPSPositionMessage gps_pos_msg;
        set_gps_position_measurement(gps_pos_msg, time_gps, 1, latitude, longitude, 
                                   altitude, 2.5, 3.0, 8, time_ns);
        
        // Write to database
        std::array<uint8_t, 2> packet_id_pos = {0x06, 0x00}; // GPS Position ID
        write_to_elodindb(packet_id_pos, gps_pos_msg);
        LocalSock->flush_elodin(); // Flush buffer to ensure data is sent
        
        // Calculate velocity from position changes
        double velocity_north = -speed * sin(current_angle) + normal_dist(gen) * 0.5;
        double velocity_east = speed * cos(current_angle) + normal_dist(gen) * 0.5;
        double velocity_up = 0.1 * cos(time_s * 0.2) + normal_dist(gen) * 0.1;
        
        // GPS Velocity
        GPSVelocityMessage gps_vel_msg;
        set_gps_velocity_measurement(gps_vel_msg, time_gps, velocity_north, velocity_east, 
                                   velocity_up, 0.5, time_ns);
        
        // Write to database
        std::array<uint8_t, 2> packet_id_vel = {0x07, 0x00}; // GPS Velocity ID
        write_to_elodindb(packet_id_vel, gps_vel_msg);
        LocalSock->flush_elodin(); // Flush buffer to ensure data is sent
        
        std::cout << "GPS: Lat=" << latitude << ", Lon=" << longitude 
                  << ", Alt=" << altitude << ", Vel=[" << velocity_north << ", " 
                  << velocity_east << ", " << velocity_up << "]" << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(1000)); // 1 Hz
    }
}

int main(int argc, char* argv[]) {
    // Set up signal handlers
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);
    
    // Parse command line arguments
    if (argc != 3) {
        std::cerr << "Usage: " << argv[0] << " <host> <port>" << std::endl;
        return 1;
    }
    
    std::string host = argv[1];
    int port = std::stoi(argv[2]);
    
    // Initialize socket connection to Elodin database
    LocalSock = std::make_unique<Socket>(host.c_str(), port);
    // Socket constructor automatically connects, no need for separate connect() call
    
    std::cout << "✅ Connected to Elodin database at " << host << ":" << port << std::endl;
    
    // Generate database configuration (send vtable schemas)
    cppGenerateDBConfig();
    
    std::cout << "Starting fake sensor generators..." << std::endl;
    
    // Start sensor generator threads
    std::thread pt_thread(generatePTData);
    std::thread tc_thread(generateTCData);
    std::thread rtd_thread(generateRTDData);
    std::thread imu_thread(generateIMUData);
    std::thread barometer_thread(generateBarometerData);
    std::thread gps_thread(generateGPSData);
    
    // Wait for all threads to complete
    pt_thread.join();
    tc_thread.join();
    rtd_thread.join();
    imu_thread.join();
    barometer_thread.join();
    gps_thread.join();
    
    std::cout << "Sensor generator shutdown complete." << std::endl;
    return 0;
}
