/**
 * Comprehensive test program to send ALL message types to Elodin DB
 *
 * Sends:
 * - Raw sensor messages (PT, TC, RTD, LC)
 * - Calibrated sensor messages (CalibratedPT, CalibratedTC)
 * - Filtered state messages
 * - Navigation messages (Navigation, Attitude)
 * - Control messages (ActuatorCommand, ControlState)
 * - IMU messages
 * - GPS messages (Position, Velocity)
 * - Barometer messages
 *
 * This matches all message types that DiabloAvionics can send.
 */

#include <array>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <random>
#include <thread>
#include <vector>

#include "../../FSW/include/config/ConfigParser.hpp"
#include "../../FSW/include/elodin/DatabaseConfig.hpp"
#include "../../FSW/include/elodin/ElodinClient.hpp"
#include "../../utl/db.hpp"
#include "comms/BarometerMessage.hpp"
#include "comms/GPSMessage.hpp"
#include "comms/IMUMessage.hpp"
#include "comms/messages/control/ControlMessages.hpp"
#include "comms/messages/filtered/FilteredMessages.hpp"
#include "comms/messages/flight/FlightMessages.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"

using namespace vtable;
using namespace vtable::builder;

// Helper to get current timestamp in nanoseconds
uint64_t get_timestamp_ns() {
    auto now = std::chrono::steady_clock::now();
    auto duration = now.time_since_epoch();
    return std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();
}

// Helper to get current timestamp in milliseconds
uint32_t get_timestamp_ms() {
    auto now = std::chrono::steady_clock::now();
    auto duration = now.time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <db_port> [messages_per_type] [duration_seconds]"
                  << std::endl;
        std::cerr << "Example: " << argv[0] << " 2240 100 30" << std::endl;
        std::cerr << "  - db_port: Elodin database port (default: 2240)" << std::endl;
        std::cerr << "  - messages_per_type: Messages per type per iteration (default: 10)"
                  << std::endl;
        std::cerr << "  - duration_seconds: How long to run (0 = infinite, default: 0)"
                  << std::endl;
        return 1;
    }

    uint16_t port = std::stoi(argv[1]);
    int messages_per_type = (argc > 2) ? std::stoi(argv[2]) : 10;
    int duration_seconds = (argc > 3) ? std::stoi(argv[3]) : 0;

    std::cout << "\n🧪 Comprehensive Message Type Test - DiabloAvionics Compatible" << std::endl;
    std::cout << "================================================================" << std::endl;
    std::cout << "Database: 127.0.0.1:" << port << std::endl;
    std::cout << "Messages per type per iteration: " << messages_per_type << std::endl;
    if (duration_seconds > 0) {
        std::cout << "Duration: " << duration_seconds << " seconds" << std::endl;
    } else {
        std::cout << "Duration: Infinite (Ctrl+C to stop)" << std::endl;
    }
    std::cout << "================================================================" << std::endl;
    std::cout << "\nMessage Types:" << std::endl;
    std::cout << "  Raw Sensors: PT, TC, RTD, LC" << std::endl;
    std::cout << "  Calibrated: CalibratedPT, CalibratedTC" << std::endl;
    std::cout << "  Filtered: FilteredState" << std::endl;
    std::cout << "  Navigation: Navigation, Attitude" << std::endl;
    std::cout << "  Control: ActuatorCommand, ControlState" << std::endl;
    std::cout << "  IMU: Accelerometer + Gyroscope" << std::endl;
    std::cout << "  GPS: Position, Velocity" << std::endl;
    std::cout << "  Barometer: Atmospheric pressure" << std::endl;
    std::cout << "================================================================" << std::endl;

    try {
        // Load config first
        std::string config_path = (argc > 4) ? argv[4] : "config/config_flight_daq.toml";
        fsw::config::ConfigParser parser;
        if (!parser.load_config(config_path)) {
            std::cerr << "❌ Failed to load config: " << config_path << std::endl;
            return 1;
        }
        auto all_sensors = parser.get_all_sensor_assignments();
        std::cout << "✅ Loaded " << all_sensors.size() << " sensors from config" << std::endl;

        if (all_sensors.empty()) {
            std::cerr << "❌ ERROR: No sensors found in config file!" << std::endl;
            return 1;
        }

        // Connect to Elodin DB
        fsw::elodin::ElodinClient client;
        if (!client.connect("127.0.0.1", port)) {
            std::cerr << "❌ Failed to connect to Elodin DB: " << client.last_error() << std::endl;
            return 1;
        }
        std::cout << "\n✅ Connected to Elodin DB" << std::endl;

        // Register all VTables from config (per sensor)
        std::cout << "\n📋 Registering VTables from config: " << config_path << std::endl;
        if (!fsw::elodin::DatabaseConfig::register_tables_from_config(client, config_path)) {
            std::cerr << "❌ Failed to register VTables from config" << std::endl;
            return 1;
        }

        // Also register VTables for non-sensor message types (calibrated, filtered, navigation,
        // etc.)
        std::cout << "\n📋 Registering VTables for non-sensor message types..." << std::endl;
        if (!fsw::elodin::DatabaseConfig::register_non_sensor_tables(client)) {
            std::cerr << "❌ Failed to register non-sensor VTables" << std::endl;
            return 1;
        }
        std::cout << "✅ All VTables registered" << std::endl;

        // Wait for Elodin to process registrations
        std::this_thread::sleep_for(std::chrono::milliseconds(500));

        // Random number generator for realistic data
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_real_distribution<double> pressure_dist(0.0, 1000.0);     // 0-1000 PSI
        std::uniform_real_distribution<double> temp_dist(20.0, 200.0);         // 20-200°C
        std::uniform_real_distribution<double> adc_dist(0.0, 16777215.0);      // 24-bit ADC
        std::uniform_real_distribution<double> resistance_dist(100.0, 200.0);  // RTD resistance
        std::uniform_real_distribution<double> load_dist(0.0, 10000.0);        // Load cell (N)
        std::uniform_real_distribution<double> accel_dist(-20.0, 20.0);  // Acceleration (m/s²)
        std::uniform_real_distribution<double> gyro_dist(-5.0, 5.0);     // Angular velocity (rad/s)
        std::uniform_real_distribution<double> lat_dist(37.0, 38.0);     // Latitude
        std::uniform_real_distribution<double> lon_dist(-123.0, -122.0);  // Longitude
        std::uniform_real_distribution<double> alt_dist(0.0, 1000.0);     // Altitude (m)

        auto start_time = std::chrono::steady_clock::now();
        int iteration = 0;
        uint64_t total_messages = 0;

        // Use monotonic timestamp counter to prevent TimeTravel errors
        uint64_t timestamp_counter = get_timestamp_ns();
        uint32_t timestamp_ms_counter = get_timestamp_ms();

        std::cout << "\n📤 Starting to send messages..." << std::endl;
        std::cout << "   (Interleaved sending for real-time simulation)\n" << std::endl;

        while (true) {
            // Check duration limit
            if (duration_seconds > 0) {
                auto elapsed = std::chrono::steady_clock::now() - start_time;
                if (std::chrono::duration_cast<std::chrono::seconds>(elapsed).count() >=
                    duration_seconds) {
                    break;
                }
            }

            iteration++;

            // Send interleaved messages (one of each type per iteration)
            for (int i = 0; i < messages_per_type; ++i) {
                // Increment timestamp monotonically (10ms spacing between messages)
                timestamp_counter += 10000000;  // 10ms in nanoseconds
                timestamp_ms_counter += 10;
                uint64_t timestamp = timestamp_counter;
                uint32_t timestamp_ms = timestamp_ms_counter;

                // === RAW SENSOR MESSAGES ===
                // Send messages for each sensor from config using their unique message IDs
                // Only send one sensor per type per iteration to avoid overwhelming the system
                static size_t sensor_index = 0;

                // Safety check: ensure we have sensors and valid index
                if (!all_sensors.empty() && sensor_index < all_sensors.size()) {
                    // Send one sensor per iteration (round-robin)
                    const auto& sensor = all_sensors[sensor_index];
                    sensor_index++;
                    if (sensor_index >= all_sensors.size()) {
                        sensor_index = 0;  // Wrap around
                    }

                    bool published = false;

                    switch (sensor.sensor_type) {
                        case fsw::config::SensorType::PT: {
                            comms::messages::sensor::RawPTMessage raw_pt;
                            std::get<0>(raw_pt.fields) = timestamp;
                            std::get<1>(raw_pt.fields) = sensor.channel_id;
                            std::get<2>(raw_pt.fields) =
                                std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(raw_pt.fields) = static_cast<uint32_t>(adc_dist(gen));
                            std::get<4>(raw_pt.fields) = timestamp_ms;
                            std::get<5>(raw_pt.fields) = 0;
                            published = client.publish(sensor.message_id, raw_pt);
                            break;
                        }
                        case fsw::config::SensorType::TC: {
                            comms::messages::sensor::RawTCMessage raw_tc;
                            std::get<0>(raw_tc.fields) = timestamp;
                            std::get<1>(raw_tc.fields) = sensor.channel_id;
                            std::get<2>(raw_tc.fields) =
                                std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(raw_tc.fields) = static_cast<uint32_t>(adc_dist(gen));
                            std::get<4>(raw_tc.fields) = timestamp_ms;
                            std::get<5>(raw_tc.fields) = 0;
                            published = client.publish(sensor.message_id, raw_tc);
                            break;
                        }
                        case fsw::config::SensorType::RTD: {
                            comms::messages::sensor::RawRTDMessage raw_rtd;
                            std::get<0>(raw_rtd.fields) = timestamp;
                            std::get<1>(raw_rtd.fields) = sensor.channel_id;
                            std::get<2>(raw_rtd.fields) =
                                std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(raw_rtd.fields) =
                                static_cast<uint32_t>(resistance_dist(gen) * 1000);
                            std::get<4>(raw_rtd.fields) = timestamp_ms;
                            std::get<5>(raw_rtd.fields) = 0;
                            published = client.publish(sensor.message_id, raw_rtd);
                            break;
                        }
                        case fsw::config::SensorType::LC: {
                            comms::messages::sensor::RawLCMessage raw_lc;
                            std::get<0>(raw_lc.fields) = timestamp;
                            std::get<1>(raw_lc.fields) = sensor.channel_id;
                            std::get<2>(raw_lc.fields) =
                                std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(raw_lc.fields) = static_cast<uint32_t>(load_dist(gen));
                            std::get<4>(raw_lc.fields) = timestamp_ms;
                            std::get<5>(raw_lc.fields) = 0;
                            published = client.publish(sensor.message_id, raw_lc);
                            break;
                        }
                        case fsw::config::SensorType::ACTUATOR: {
                            // Skip actuators for now (would need ActuatorCommandMessage)
                            break;
                        }
                    }

                    if (published) {
                        total_messages++;
                    }
                } else {
                    // No sensors or invalid index - skip raw sensor messages this iteration
                    std::cerr << "⚠️  WARNING: No sensors available or invalid sensor_index"
                              << std::endl;
                }

                // === CALIBRATED SENSOR MESSAGES ===

                // Calibrated PT Message
                comms::messages::filtered::CalibratedPTMessage calibrated_pt;
                std::get<0>(calibrated_pt.fields) = timestamp;
                std::get<1>(calibrated_pt.fields) = i % 10;
                std::get<2>(calibrated_pt.fields) =
                    pressure_dist(gen) * 6894.76;  // Convert PSI to Pa
                std::get<3>(calibrated_pt.fields) = temp_dist(gen);
                std::get<4>(calibrated_pt.fields) = 0.95f;  // High quality
                std::get<5>(calibrated_pt.fields) = 1;      // Valid
                std::array<uint8_t, 2> calibrated_pt_packet_id = {0x30, 0x00};
                client.publish(calibrated_pt_packet_id, calibrated_pt);
                total_messages++;

                // Calibrated TC Message
                comms::messages::filtered::CalibratedTCMessage calibrated_tc;
                std::get<0>(calibrated_tc.fields) = timestamp;
                std::get<1>(calibrated_tc.fields) = i % 8;
                std::get<2>(calibrated_tc.fields) = temp_dist(gen);
                std::get<3>(calibrated_tc.fields) = 0.92f;  // High quality
                std::get<4>(calibrated_tc.fields) = 1;      // Valid
                std::array<uint8_t, 2> calibrated_tc_packet_id = {0x31, 0x00};
                client.publish(calibrated_tc_packet_id, calibrated_tc);
                total_messages++;

                // === FILTERED STATE MESSAGE ===

                comms::messages::filtered::FilteredStateMessage filtered_state;
                std::get<0>(filtered_state.fields) = timestamp;
                std::get<1>(filtered_state.fields) =
                    pressure_dist(gen) * 6894.76;                             // Chamber pressure
                std::get<2>(filtered_state.fields) = temp_dist(gen) + 100.0;  // Exhaust temp
                std::get<3>(filtered_state.fields) = temp_dist(gen);          // Fuel temp
                std::get<4>(filtered_state.fields) = temp_dist(gen) - 50.0;   // Oxidizer temp
                std::get<5>(filtered_state.fields) = load_dist(gen);          // Thrust estimate
                std::get<6>(filtered_state.fields) = 0.88f;                   // State quality
                std::array<uint8_t, 2> filtered_state_packet_id = {0x32, 0x00};
                client.publish(filtered_state_packet_id, filtered_state);
                total_messages++;

                // === NAVIGATION MESSAGES ===

                // Navigation Message
                comms::messages::flight::NavigationMessage nav_msg;
                std::get<0>(nav_msg.fields) = timestamp;
                std::get<1>(nav_msg.fields) = 0.0;                      // N position
                std::get<2>(nav_msg.fields) = 0.0;                      // E position
                std::get<3>(nav_msg.fields) = alt_dist(gen);            // Down (altitude)
                std::get<4>(nav_msg.fields) = accel_dist(gen) * 0.1;    // N velocity
                std::get<5>(nav_msg.fields) = accel_dist(gen) * 0.1;    // E velocity
                std::get<6>(nav_msg.fields) = -5.0;                     // D velocity (climbing)
                std::get<7>(nav_msg.fields) = 1.0;                      // Quaternion w
                std::get<8>(nav_msg.fields) = 0.0;                      // Quaternion x
                std::get<9>(nav_msg.fields) = 0.0;                      // Quaternion y
                std::get<10>(nav_msg.fields) = 0.0;                     // Quaternion z
                std::get<11>(nav_msg.fields) = accel_dist(gen);         // N acceleration
                std::get<12>(nav_msg.fields) = accel_dist(gen);         // E acceleration
                std::get<13>(nav_msg.fields) = accel_dist(gen) + 9.81;  // D acceleration
                std::array<uint8_t, 2> nav_packet_id = {0x40, 0x00};
                client.publish(nav_packet_id, nav_msg);
                total_messages++;

                // Attitude Message
                comms::messages::flight::AttitudeMessage attitude_msg;
                std::get<0>(attitude_msg.fields) = timestamp;
                std::get<1>(attitude_msg.fields) = 1.0;  // Quaternion w
                std::get<2>(attitude_msg.fields) = 0.0;  // Quaternion x
                std::get<3>(attitude_msg.fields) = 0.0;  // Quaternion y
                std::get<4>(attitude_msg.fields) = 0.0;  // Quaternion z
                std::get<5>(attitude_msg.fields) = 0.0;  // Roll
                std::get<6>(attitude_msg.fields) = 0.0;  // Pitch
                std::get<7>(attitude_msg.fields) = 0.0;  // Yaw
                std::array<uint8_t, 2> attitude_packet_id = {0x41, 0x00};
                client.publish(attitude_packet_id, attitude_msg);
                total_messages++;

                // === CONTROL MESSAGES ===

                // Actuator Command Message
                comms::messages::control::ActuatorCommandMessage actuator_cmd;
                std::get<0>(actuator_cmd.fields) = timestamp;
                std::get<1>(actuator_cmd.fields) = i % 10;  // Actuator ID
                std::get<2>(actuator_cmd.fields) = 1;       // Command type (OPEN)
                std::get<3>(actuator_cmd.fields) = 0.5f;    // Value (50% open)
                std::get<4>(actuator_cmd.fields) = 1;       // Status (ACK)
                std::array<uint8_t, 2> actuator_cmd_packet_id = {0x50, 0x00};
                client.publish(actuator_cmd_packet_id, actuator_cmd);
                total_messages++;

                // Control State Message
                comms::messages::control::ControlStateMessage control_state;
                std::get<0>(control_state.fields) = timestamp;
                std::get<1>(control_state.fields) = 100.0;  // Setpoint X
                std::get<2>(control_state.fields) = 0.0;    // Setpoint Y
                std::get<3>(control_state.fields) = 0.0;    // Setpoint Z
                std::get<4>(control_state.fields) = 1.0;    // PID P X
                std::get<5>(control_state.fields) = 0.1;    // PID I X
                std::get<6>(control_state.fields) = 0.01;   // PID D X
                std::get<7>(control_state.fields) = 1.0;    // PID P Y
                std::get<8>(control_state.fields) = 0.1;    // PID I Y
                std::get<9>(control_state.fields) = 0.01;   // PID D Y
                std::get<10>(control_state.fields) = 1.0;   // PID P Z
                std::get<11>(control_state.fields) = 0.1;   // PID I Z
                std::get<12>(control_state.fields) = 0.01;  // PID D Z
                std::array<uint8_t, 2> control_state_packet_id = {0x51, 0x00};
                client.publish(control_state_packet_id, control_state);
                total_messages++;

                // === IMU MESSAGE ===

                IMUMessage imu_msg;
                std::get<0>(imu_msg.fields) = timestamp / 1e9;         // Convert to seconds
                std::get<1>(imu_msg.fields) = accel_dist(gen);         // Accel X
                std::get<2>(imu_msg.fields) = accel_dist(gen);         // Accel Y
                std::get<3>(imu_msg.fields) = accel_dist(gen) + 9.81;  // Accel Z (gravity)
                std::get<4>(imu_msg.fields) = gyro_dist(gen);          // Gyro X
                std::get<5>(imu_msg.fields) = gyro_dist(gen);          // Gyro Y
                std::get<6>(imu_msg.fields) = gyro_dist(gen);          // Gyro Z
                std::get<7>(imu_msg.fields) = timestamp;
                std::array<uint8_t, 2> imu_packet_id = {0x60, 0x00};
                client.publish(imu_packet_id, imu_msg);
                total_messages++;

                // === GPS MESSAGES ===

                // GPS Position Message
                GPSPositionMessage gps_pos;
                std::get<0>(gps_pos.fields) = timestamp;
                std::get<1>(gps_pos.fields) = timestamp_ms;
                std::get<2>(gps_pos.fields) = 1;              // Status (valid)
                std::get<3>(gps_pos.fields) = lat_dist(gen);  // Latitude
                std::get<4>(gps_pos.fields) = lon_dist(gen);  // Longitude
                std::get<5>(gps_pos.fields) = alt_dist(gen);  // Altitude
                std::get<6>(gps_pos.fields) = 2.5f;           // Horizontal accuracy
                std::get<7>(gps_pos.fields) = 3.0f;           // Vertical accuracy
                std::get<8>(gps_pos.fields) = 8;              // Satellites
                std::array<uint8_t, 2> gps_pos_packet_id = {0x70, 0x00};
                client.publish(gps_pos_packet_id, gps_pos);
                total_messages++;

                // GPS Velocity Message
                GPSVelocityMessage gps_vel;
                std::get<0>(gps_vel.fields) = timestamp;
                std::get<1>(gps_vel.fields) = timestamp_ms / 1000;     // GPS time in seconds
                std::get<2>(gps_vel.fields) = accel_dist(gen) * 0.1f;  // Velocity X
                std::get<3>(gps_vel.fields) = accel_dist(gen) * 0.1f;  // Velocity Y
                std::get<4>(gps_vel.fields) = -5.0f;                   // Velocity Z (climbing)
                std::get<5>(gps_vel.fields) = 0.5f;                    // Speed accuracy
                std::array<uint8_t, 2> gps_vel_packet_id = {0x71, 0x00};
                client.publish(gps_vel_packet_id, gps_vel);
                total_messages++;

                // === BAROMETER MESSAGE ===

                BarometerMessage baro_msg;
                std::get<0>(baro_msg.fields) = timestamp / 1e9;  // Time in seconds
                std::get<1>(baro_msg.fields) =
                    101325.0 - (alt_dist(gen) * 12.0);         // Pressure (decreases with altitude)
                std::get<2>(baro_msg.fields) = alt_dist(gen);  // Altitude
                std::get<3>(baro_msg.fields) =
                    temp_dist(gen) - 100.0;  // Temperature (colder at altitude)
                std::get<4>(baro_msg.fields) = timestamp;
                std::array<uint8_t, 2> baro_packet_id = {0x80, 0x00};
                client.publish(baro_packet_id, baro_msg);
                total_messages++;

                // Small delay to simulate real-time streaming
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }

            // Progress update every 10 iterations
            if (iteration % 10 == 0) {
                auto elapsed = std::chrono::steady_clock::now() - start_time;
                double elapsed_sec =
                    std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count() / 1000.0;
                double rate = total_messages / elapsed_sec;
                std::cout << "  Iteration " << iteration << " | Total messages: " << total_messages
                          << " | Rate: " << std::fixed << std::setprecision(1) << rate << " msg/s"
                          << std::endl;
            }
        }

        std::cout << "\n✅ Done!" << std::endl;
        std::cout << "   Total iterations: " << iteration << std::endl;
        std::cout << "   Total messages sent: " << total_messages << std::endl;
        std::cout << "\n📊 Open Elodin editor to view all message types:" << std::endl;
        std::cout << "   elodin editor <db_path>" << std::endl;

    } catch (const std::exception& e) {
        std::cerr << "❌ Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
