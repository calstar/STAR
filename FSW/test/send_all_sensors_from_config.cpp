/**
 * Test to send fake data for ALL sensors from config to Elodin DB
 * Uses ConfigParser to read sensor definitions and packet IDs from config
 * Publishes each sensor individually with its config-defined packet_id
 */

#include <array>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <random>
#include <thread>
#include <vector>

#include "../../archive/legacy/utl/db.hpp"
#include "../../daq_comms/include/comms/messages/sensor/SensorMessages.hpp"
#include "config/ConfigParser.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

using namespace vtable;
using namespace vtable::builder;
using namespace fsw;

int main(int argc, char* argv[]) {
    if (argc < 3) {
        std::cerr << "Usage: " << argv[0]
                  << " <config_path> <db_port> [messages_per_sensor] [duration_seconds]"
                  << std::endl;
        std::cerr << "Example: " << argv[0] << " config/config_flight_daq.toml 2240 10 0"
                  << std::endl;
        std::cerr << "  - config_path: Path to TOML config file" << std::endl;
        std::cerr << "  - db_port: Elodin database port" << std::endl;
        std::cerr << "  - messages_per_sensor: Messages per sensor per iteration (default: 10)"
                  << std::endl;
        std::cerr << "  - duration_seconds: How long to run (0 = infinite, default: 0)"
                  << std::endl;
        return 1;
    }

    std::string config_path = argv[1];
    uint16_t port = std::stoi(argv[2]);
    int messages_per_sensor = (argc > 3) ? std::stoi(argv[3]) : 10;
    int duration_seconds = (argc > 4) ? std::stoi(argv[4]) : 0;

    std::cout << "\n🧪 Sending fake data for ALL sensors from config to Elodin" << std::endl;
    std::cout << "============================================================" << std::endl;
    std::cout << "Config: " << config_path << std::endl;
    std::cout << "Database: 127.0.0.1:" << port << std::endl;
    std::cout << "Messages per sensor: " << messages_per_sensor << std::endl;
    if (duration_seconds > 0) {
        std::cout << "Duration: " << duration_seconds << " seconds" << std::endl;
    } else {
        std::cout << "Duration: Infinite (Ctrl+C to stop)" << std::endl;
    }
    std::cout << "============================================================\n" << std::endl;

    try {
        // Load config
        config::ConfigParser parser;
        if (!parser.load_config(config_path)) {
            std::cerr << "❌ Failed to load config: " << config_path << std::endl;
            return 1;
        }

        // Get all sensor assignments
        auto all_sensors = parser.get_all_sensor_assignments();
        std::cout << "✅ Loaded " << all_sensors.size() << " sensors from config" << std::endl;

        // Group sensors by type for display
        std::map<config::SensorType, std::vector<config::SensorAssignment>> sensors_by_type;
        for (const auto& sensor : all_sensors) {
            sensors_by_type[sensor.sensor_type].push_back(sensor);
        }

        std::cout << "\n📋 Sensors by type:" << std::endl;
        for (const auto& [type, sensors] : sensors_by_type) {
            std::string type_name;
            switch (type) {
                case config::SensorType::PT:
                    type_name = "PT";
                    break;
                case config::SensorType::TC:
                    type_name = "TC";
                    break;
                case config::SensorType::RTD:
                    type_name = "RTD";
                    break;
                case config::SensorType::LC:
                    type_name = "LC";
                    break;
                case config::SensorType::ACTUATOR:
                    type_name = "Actuator";
                    break;
            }
            std::cout << "  " << type_name << ": " << sensors.size() << " sensors" << std::endl;
            for (const auto& s : sensors) {
                std::cout << "    - " << s.sensor_id << " (board=" << (int)s.board_id
                          << ", ch=" << (int)s.channel_id << ", message_id=0x" << std::hex
                          << s.message_id << std::dec << ")" << std::endl;
            }
        }
        std::cout << std::endl;

        // Connect to Elodin DB
        elodin::ElodinClient client;
        if (!client.connect("127.0.0.1", port)) {
            std::cerr << "❌ Failed to connect to Elodin DB: " << client.last_error() << std::endl;
            return 1;
        }
        std::cout << "✅ Connected to Elodin DB" << std::endl;

        // Register all VTables as defined in the config
        std::cout << "\n📋 Registering VTables for each config-defined sensor..." << std::endl;
        for (const auto& sensor : all_sensors) {
            std::string prefix = sensor.sensor_id + ".";
            std::string val_name = "pressure_psi";
            PrimType val_type = PrimType::F32();

            switch (sensor.sensor_type) {
                case config::SensorType::PT:
                    val_name = "pressure_psi";
                    val_type = PrimType::F32();
                    break;
                case config::SensorType::TC:
                    val_name = "temperature_c";
                    val_type = PrimType::F32();
                    break;
                case config::SensorType::RTD:
                    val_name = "temperature_c";
                    val_type = PrimType::F32();
                    break;
                case config::SensorType::LC:
                    val_name = "load_n";
                    val_type = PrimType::F32();
                    break;
                case config::SensorType::ACTUATOR:
                    continue;  // Skip for now
            }

            // Extract high and low bytes from the message_id for the VTable ID
            std::tuple<uint8_t, uint8_t> vt_id = {
                static_cast<uint8_t>((sensor.message_id >> 8) & 0xFF),
                static_cast<uint8_t>(sensor.message_id & 0xFF)};

            // Build VTable matching DatabaseConfig's layout
            auto vt = builder::vtable({
                raw_field(0, 8, schema(PrimType::U64(), {}, component(prefix + "timestamp_ns"))),
                raw_field(8, 1, schema(PrimType::U8(), {}, component(prefix + "channel_id"))),
                // 3 bytes padding at offset 9
                raw_field(12, 4, schema(val_type, {}, component(prefix + val_name))),
                raw_field(16, 4, schema(PrimType::U32(), {}, component(prefix + "sample_ts_ms"))),
                raw_field(20, 1, schema(PrimType::U8(), {}, component(prefix + "status"))),
            });

            auto buf = Msg(VTableMsg{.id = vt_id, .vtable = vt}).encode_vec();
            if (buf.empty() || !client.send_msg({0, 0}, buf)) {
                std::cerr << "❌ Failed to register VTable for " << sensor.sensor_id << std::endl;
            }

            // Name the components and entity
            auto c1 = Msg(set_component_name(prefix + "timestamp_ns")).encode_vec();
            client.send_msg({0, 0}, c1);
            auto c2 = Msg(set_component_name(prefix + "channel_id")).encode_vec();
            client.send_msg({0, 0}, c2);
            auto c3 = Msg(set_component_name(prefix + val_name)).encode_vec();
            client.send_msg({0, 0}, c3);
            auto c4 = Msg(set_component_name(prefix + "sample_ts_ms")).encode_vec();
            client.send_msg({0, 0}, c4);
            auto c5 = Msg(set_component_name(prefix + "status")).encode_vec();
            client.send_msg({0, 0}, c5);

            // Extract a unique entity ID from the message_id for naming
            uint64_t entity_id = 0x20000 + sensor.message_id;
            auto e1 = Msg(set_entity_name(entity_id, sensor.sensor_id)).encode_vec();
            client.send_msg({0, 0}, e1);
        }
        std::cout << "✅ Registered dynamic VTables from config" << std::endl;

        // Wait for Elodin to process VTable registrations
        std::cout << "⏳ Waiting 3 seconds for Elodin to process VTable registrations..."
                  << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(3000));

        // Random number generators
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_int_distribution<uint32_t> adc_dist(1000, 50000);
        std::uniform_real_distribution<double> temp_dist(20.0, 100.0);
        std::uniform_real_distribution<double> pressure_dist(0.0, 1000.0);     // PSI
        std::uniform_real_distribution<double> resistance_dist(100.0, 200.0);  // Ohms
        std::uniform_real_distribution<double> load_dist(0.0, 1000.0);         // Newtons

        auto start_time = std::chrono::steady_clock::now();
        uint64_t timestamp_counter = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                         std::chrono::steady_clock::now().time_since_epoch())
                                         .count();
        uint32_t timestamp_ms_counter = std::chrono::duration_cast<std::chrono::milliseconds>(
                                            std::chrono::steady_clock::now().time_since_epoch())
                                            .count();

        std::cout << "\n📤 Starting data transmission..." << std::endl;
        std::cout << "   Rate: ~10 Hz (all sensors sent together every 100ms)" << std::endl;
        std::cout << std::endl;

        int iteration = 0;
        uint64_t total_messages = 0;

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

            // Send data for each sensor
            for (int i = 0; i < messages_per_sensor; ++i) {
                // Increment timestamp monotonically (10ms spacing between messages)
                timestamp_counter += 10000000;  // 10ms in nanoseconds
                timestamp_ms_counter += 10;
                uint64_t timestamp = timestamp_counter;
                uint32_t timestamp_ms = timestamp_ms_counter;

                // Send data for each sensor with its config-defined packet_id
                for (const auto& sensor : all_sensors) {
                    bool published = false;

                    switch (sensor.sensor_type) {
                        case config::SensorType::PT: {
                            comms::messages::sensor::RawPTMessage msg;
                            std::get<0>(msg.fields) = timestamp;
                            std::get<1>(msg.fields) = sensor.channel_id;
                            std::get<2>(msg.fields) = std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(msg.fields) = static_cast<uint32_t>(adc_dist(gen));
                            std::get<4>(msg.fields) = timestamp_ms;
                            std::get<5>(msg.fields) = 0;
                            published = client.publish(sensor.message_id, msg);
                            break;
                        }
                        case config::SensorType::TC: {
                            comms::messages::sensor::RawTCMessage msg;
                            std::get<0>(msg.fields) = timestamp;
                            std::get<1>(msg.fields) = sensor.channel_id;
                            std::get<2>(msg.fields) = std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(msg.fields) = static_cast<uint32_t>(adc_dist(gen));
                            std::get<4>(msg.fields) = timestamp_ms;
                            std::get<5>(msg.fields) = 0;
                            published = client.publish(sensor.message_id, msg);
                            break;
                        }
                        case config::SensorType::RTD: {
                            comms::messages::sensor::RawRTDMessage msg;
                            std::get<0>(msg.fields) = timestamp;
                            std::get<1>(msg.fields) = sensor.channel_id;
                            std::get<2>(msg.fields) = std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(msg.fields) =
                                static_cast<uint32_t>(resistance_dist(gen) * 1000);
                            std::get<4>(msg.fields) = timestamp_ms;
                            std::get<5>(msg.fields) = 0;
                            published = client.publish(sensor.message_id, msg);
                            break;
                        }
                        case config::SensorType::LC: {
                            comms::messages::sensor::RawLCMessage msg;
                            std::get<0>(msg.fields) = timestamp;
                            std::get<1>(msg.fields) = sensor.channel_id;
                            std::get<2>(msg.fields) = std::array<uint8_t, 3>{0, 0, 0};  // Padding
                            std::get<3>(msg.fields) = static_cast<uint32_t>(load_dist(gen));
                            std::get<4>(msg.fields) = timestamp_ms;
                            std::get<5>(msg.fields) = 0;
                            published = client.publish(sensor.message_id, msg);
                            break;
                        }
                        case config::SensorType::ACTUATOR: {
                            // TODO: Add ActuatorCommandMessage when available
                            // For now, skip actuators
                            break;
                        }
                    }

                    if (published) {
                        total_messages++;
                    }
                }

                // Progress update
                if (iteration == 1 && (i < 3 || i % 10 == 0)) {
                    std::cout << "[send_all_sensors_from_config] ✅ Sent batch #" << (i + 1)
                              << " (all " << all_sensors.size()
                              << " sensors, timestamp=" << timestamp << "ns)" << std::endl;
                }

                // Wait 10ms before next batch (100 Hz rate for all sensors)
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }

            // Progress update every iteration
            if (iteration % 10 == 0) {
                std::cout << "[send_all_sensors_from_config] Iteration #" << iteration
                          << ", total messages: " << total_messages << std::endl;
            }
        }

        client.flush_buffer();

        auto end_time = std::chrono::steady_clock::now();
        auto duration =
            std::chrono::duration_cast<std::chrono::milliseconds>(end_time - start_time);

        std::cout << "\n===================================" << std::endl;
        std::cout << "✅ Transmission Complete!" << std::endl;
        std::cout << "   Total messages sent: " << total_messages << std::endl;
        std::cout << "   Duration: " << duration.count() << " ms" << std::endl;
        std::cout << "===================================" << std::endl;
        std::cout << "\n📊 View data in Elodin editor:" << std::endl;
        std::cout << "   elodin editor <db_path>" << std::endl;
        std::cout << std::endl;

        client.disconnect();

    } catch (const std::exception& e) {
        std::cerr << "❌ Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
