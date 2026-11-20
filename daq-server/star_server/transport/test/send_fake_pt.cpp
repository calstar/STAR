/**
 * Simple test to send fake RawPTMessage data to Elodin DB
 * Uses our message formats and Elodin protocol
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
        std::cerr << "Usage: " << argv[0] << " <db_port> [message_count]" << std::endl;
        std::cerr << "Example: " << argv[0] << " 2240 10" << std::endl;
        return 1;
    }

    uint16_t port = std::stoi(argv[1]);
    int message_count = (argc > 2) ? std::stoi(argv[2]) : 10;

    std::cout << "\n🧪 Sending fake RawPTMessage to Elodin" << std::endl;
    std::cout << "===================================" << std::endl;
    std::cout << "Database: 127.0.0.1:" << port << std::endl;
    std::cout << "Messages: " << message_count << std::endl;
    std::cout << "Packet ID: [0x20, 0x00]" << std::endl;
    std::cout << "===================================\n" << std::endl;

    try {
        // Connect to Elodin DB
        daq_comms::elodin::ElodinClient client;
        if (!client.connect("127.0.0.1", port)) {
            std::cerr << "❌ Failed to connect to Elodin DB: " << client.last_error() << std::endl;
            return 1;
        }
        std::cout << "✅ Connected to Elodin DB" << std::endl;

        // Register VTable for RawPTMessage
        // RawPTMessage: uint64_t timestamp_ns, uint8_t channel_id, uint32_t raw_adc_counts,
        //               uint32_t sample_timestamp_ms, uint8_t status_flags
        // Total: 8 + 1 + 4 + 4 + 1 = 18 bytes
        if (!daq_comms::elodin::DatabaseConfig::register_tables(client)) {
            std::cerr << "❌ Failed to register tables" << std::endl;
            return 1;
        }
        std::cout << "✅ Registered VTables" << std::endl;

        // Wait for Elodin to process VTable registrations
        // FSW waits 500ms, but let's wait much longer to ensure VTables are fully processed
        std::cout << "⏳ Waiting 5 seconds for Elodin to fully process VTable registrations..."
                  << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(5000));

        // Send fake RawPTMessage data
        std::cout << "📤 Starting data transmission..." << std::endl;
        std::cout << "   Sending " << message_count << " RawPTMessage(s) to Elodin" << std::endl;
        std::cout << "   Rate: ~10 Hz (100ms between messages)" << std::endl;
        std::cout << std::endl;
        auto start_time = std::chrono::steady_clock::now();

        std::array<uint8_t, 2> pt_packet_id{0x20, 0x00};  // PT_PACKET_ID

        for (int i = 0; i < message_count; ++i) {
            comms::messages::sensor::RawPTMessage pt_msg;

            // Generate fake data
            auto now = std::chrono::steady_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(now - start_time);
            uint64_t timestamp_ns = elapsed.count();
            uint8_t channel_id = i % 3;               // Cycle through channels 0, 1, 2
            uint32_t raw_adc_counts = 1000 + i * 10;  // Fake ADC reading
            uint32_t sample_timestamp_ms = i * 100;   // Fake embedded timestamp
            uint8_t status_flags = 0;                 // Good status

            pt_msg.setField<0>(timestamp_ns);
            pt_msg.setField<1>(channel_id);
            pt_msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});  // Padding bytes (must be zeros)
            pt_msg.setField<3>(raw_adc_counts);
            pt_msg.setField<4>(sample_timestamp_ms);
            pt_msg.setField<5>(status_flags);

            // Debug: Hex dump first message to compare with FSW
            if (i == 0) {
                // Use the same serialize_msg that ElodinClient uses
                auto debug_buf =
                    daq_comms::elodin::ElodinClient::serialize_msg(pt_packet_id, pt_msg);

                std::cout << "\n[DEBUG] First message hex dump (" << debug_buf.size()
                          << " bytes):\n";
                for (size_t j = 0; j < debug_buf.size(); j++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0')
                              << (int)static_cast<uint8_t>(debug_buf[j]) << " ";
                    if ((j + 1) % 8 == 0)
                        std::cout << "\n";
                }
                std::cout << std::dec << "\n";
                std::cout << "[DEBUG] Expected: len(4)=" << std::hex << (18 + 4) << std::dec
                          << ", type=1, packet_id=[0x20,0x00], request_id=0\n";
            }

            // Publish to Elodin
            if (!client.publish(pt_packet_id, pt_msg)) {
                std::cerr << "❌ Failed to publish message #" << (i + 1) << std::endl;
                continue;
            }

            if (i < 5) {
                std::cout << "[send_fake_pt] ✅ Sent #" << (i + 1)
                          << " (channel=" << (int)channel_id << ", adc=" << raw_adc_counts
                          << ", timestamp=" << timestamp_ns << ")" << std::endl;
            } else if (i % 50 == 0) {
                std::cout << "[send_fake_pt] 📊 Progress: " << (i + 1) << "/" << message_count
                          << " messages sent" << std::endl;
            }

            // Flush after each message to ensure immediate delivery (like FSW)
            client.flush_buffer();
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // Final flush
        client.flush_buffer();

        auto end_time = std::chrono::steady_clock::now();
        auto duration =
            std::chrono::duration_cast<std::chrono::milliseconds>(end_time - start_time);

        std::cout << "\n===================================" << std::endl;
        std::cout << "✅ Transmission Complete!" << std::endl;
        std::cout << "   Messages sent: " << message_count << std::endl;
        std::cout << "   Duration: " << duration.count() << " ms" << std::endl;
        std::cout << "   Average rate: " << (message_count * 1000.0 / duration.count()) << " msg/s"
                  << std::endl;
        std::cout << "===================================" << std::endl;
        std::cout << "\n📊 View data in Elodin editor:" << std::endl;
        std::cout << "   elodin editor ~/.local/share/elodin/test_pt_db" << std::endl;
        std::cout << std::endl;

        client.disconnect();

    } catch (const std::exception& e) {
        std::cerr << "❌ Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
