/**
 * Test to send fake data for ALL sensor types (PT, TC, RTD, LC) to Elodin DB
 * This validates that all VTables work correctly
 */

#include <array>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <thread>
#include <vector>

// Our includes
#include "../../utl/db.hpp"
#include "../include/elodin/DatabaseConfig.hpp"
#include "../include/elodin/ElodinClient.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"

using namespace vtable;
using namespace vtable::builder;

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <db_port> [messages_per_type]" << std::endl;
        std::cerr << "Example: " << argv[0] << " 2240 10" << std::endl;
        return 1;
    }

    uint16_t port = std::stoi(argv[1]);
    int messages_per_type = (argc > 2) ? std::stoi(argv[2]) : 10;

    std::cout << "\n🧪 Sending fake data for ALL sensor types to Elodin" << std::endl;
    std::cout << "===================================================" << std::endl;
    std::cout << "Database: 127.0.0.1:" << port << std::endl;
    std::cout << "Messages per type: " << messages_per_type << std::endl;
    std::cout << "Sensor types: PT, TC, RTD, LC" << std::endl;
    std::cout << "===================================================\n" << std::endl;

    try {
        // Connect to Elodin DB
        daq_comms::elodin::ElodinClient client;
        if (!client.connect("127.0.0.1", port)) {
            std::cerr << "❌ Failed to connect to Elodin DB: " << client.last_error() << std::endl;
            return 1;
        }
        std::cout << "✅ Connected to Elodin DB" << std::endl;

        // Register all VTables
        if (!daq_comms::elodin::DatabaseConfig::register_tables(client)) {
            std::cerr << "❌ Failed to register tables" << std::endl;
            return 1;
        }
        std::cout << "✅ Registered all VTables" << std::endl;

        // Wait for Elodin to process VTable registrations
        std::cout << "⏳ Waiting 5 seconds for Elodin to fully process VTable registrations..."
                  << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(5000));

        // Packet IDs
        std::array<uint8_t, 2> pt_packet_id{0x20, 0x00};
        std::array<uint8_t, 2> tc_packet_id{0x21, 0x00};
        std::array<uint8_t, 2> rtd_packet_id{0x22, 0x00};
        std::array<uint8_t, 2> lc_packet_id{0x23, 0x00};

        auto start_time = std::chrono::steady_clock::now();

        std::cout << "\n📤 Starting REAL-TIME data transmission (interleaved)..." << std::endl;
        std::cout << "   Rate: ~10 Hz (all sensor types sent together every 100ms)" << std::endl;
        std::cout << "   Pattern: PT → TC → RTD → LC (repeated)" << std::endl;
        std::cout << std::endl;

        // Send interleaved messages - all sensor types together for real-time display
        for (int i = 0; i < messages_per_type; ++i) {
            auto now = std::chrono::steady_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(now - start_time);
            uint64_t timestamp_ns = elapsed.count();
            uint32_t sample_timestamp_ms = i * 100;

            // Send PT message
            {
                comms::messages::sensor::RawPTMessage msg;
                msg.setField<0>(timestamp_ns);
                msg.setField<1>(static_cast<uint8_t>(i % 3));
                msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                msg.setField<3>(1000 + i * 10);
                msg.setField<4>(sample_timestamp_ms);
                msg.setField<5>(0);

                if (!client.publish(pt_packet_id, msg)) {
                    std::cerr << "❌ Failed to publish PT message #" << (i + 1) << std::endl;
                }
            }

            // Send TC message (same timestamp for real-time sync)
            {
                comms::messages::sensor::RawTCMessage msg;
                msg.setField<0>(timestamp_ns);
                msg.setField<1>(static_cast<uint8_t>(i % 2));
                msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                msg.setField<3>(2000 + i * 20);
                msg.setField<4>(sample_timestamp_ms);
                msg.setField<5>(0);

                if (!client.publish(tc_packet_id, msg)) {
                    std::cerr << "❌ Failed to publish TC message #" << (i + 1) << std::endl;
                }
            }

            // Send RTD message (same timestamp for real-time sync)
            {
                comms::messages::sensor::RawRTDMessage msg;
                msg.setField<0>(timestamp_ns);
                msg.setField<1>(static_cast<uint8_t>(i % 2));
                msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                msg.setField<3>(3000 + i * 30);
                msg.setField<4>(sample_timestamp_ms);
                msg.setField<5>(0);

                if (!client.publish(rtd_packet_id, msg)) {
                    std::cerr << "❌ Failed to publish RTD message #" << (i + 1) << std::endl;
                }
            }

            // Send LC message (same timestamp for real-time sync)
            {
                comms::messages::sensor::RawLCMessage msg;
                msg.setField<0>(timestamp_ns);
                msg.setField<1>(static_cast<uint8_t>(0));
                msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                msg.setField<3>(4000 + i * 40);
                msg.setField<4>(sample_timestamp_ms);
                msg.setField<5>(0);

                if (!client.publish(lc_packet_id, msg)) {
                    std::cerr << "❌ Failed to publish LC message #" << (i + 1) << std::endl;
                }
            }

            // Progress update
            if (i < 5 || i % 10 == 0) {
                std::cout << "[send_all_sensors] ✅ Sent batch #" << (i + 1)
                          << " (PT+TC+RTD+LC, timestamp=" << timestamp_ns << "ns)" << std::endl;
            }

            // Wait 100ms before next batch (10 Hz rate)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        std::cout << "\n   ✅ Sent " << messages_per_type
                  << " batches (4 messages each = " << (messages_per_type * 4) << " total messages)"
                  << std::endl;

        client.flush_buffer();

        auto end_time = std::chrono::steady_clock::now();
        auto duration =
            std::chrono::duration_cast<std::chrono::milliseconds>(end_time - start_time);

        std::cout << "\n===================================" << std::endl;
        std::cout << "✅ Transmission Complete!" << std::endl;
        std::cout << "   Total messages sent: " << (messages_per_type * 4) << std::endl;
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
