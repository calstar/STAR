/**
 * Simple test to send fake RawPTMessage data to Elodin DB
 * Uses our message formats and Elodin protocol
 */

#include <iostream>
#include <thread>
#include <chrono>
#include <cstdint>
#include <array>
#include <vector>
#include <iomanip>

// Our includes
#include "../include/elodin/ElodinClient.hpp"
#include "../include/elodin/DatabaseConfig.hpp"
#include "../../comms/include/messages/sensor/SensorMessages.hpp"
#include "../../utl/db.hpp"

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
    
    std::cout << "🧪 Sending fake RawPTMessage to Elodin" << std::endl;
    std::cout << "===================================" << std::endl;
    std::cout << "DB: 127.0.0.1:" << port << std::endl;
    std::cout << "Messages: " << message_count << std::endl;
    std::cout << std::endl;
    
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
        std::cout << "⏳ Waiting 5 seconds for Elodin to fully process VTable registrations..." << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(5000));
        
        // Send fake RawPTMessage data
        std::cout << "📤 Sending " << message_count << " RawPTMessage(s)..." << std::endl;
        auto start_time = std::chrono::steady_clock::now();
        
        std::array<uint8_t, 2> pt_packet_id{0x20, 0x00}; // PT_PACKET_ID
        
        for (int i = 0; i < message_count; ++i) {
            comms::messages::sensor::RawPTMessage pt_msg;
            
            // Generate fake data
            auto now = std::chrono::steady_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(now - start_time);
            uint64_t timestamp_ns = elapsed.count();
            uint8_t channel_id = i % 3; // Cycle through channels 0, 1, 2
            uint32_t raw_adc_counts = 1000 + i * 10; // Fake ADC reading
            uint32_t sample_timestamp_ms = i * 100; // Fake embedded timestamp
            uint8_t status_flags = 0; // Good status
            
            pt_msg.setField<0>(timestamp_ns);
            pt_msg.setField<1>(channel_id);
            pt_msg.setField<2>(raw_adc_counts);
            pt_msg.setField<3>(sample_timestamp_ms);
            pt_msg.setField<4>(status_flags);
            
            // Debug: Hex dump first message to compare with FSW
            if (i == 0) {
                // Use the same serialize_msg that ElodinClient uses
                auto debug_buf = daq_comms::elodin::ElodinClient::serialize_msg(pt_packet_id, pt_msg);
                
                std::cout << "\n[DEBUG] First message hex dump (" << debug_buf.size() << " bytes):\n";
                for (size_t j = 0; j < debug_buf.size(); j++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') 
                              << (int)static_cast<uint8_t>(debug_buf[j]) << " ";
                    if ((j + 1) % 8 == 0) std::cout << "\n";
                }
                std::cout << std::dec << "\n";
                std::cout << "[DEBUG] Expected: len(4)=" << std::hex << (18+4) << std::dec 
                          << ", type=1, packet_id=[0x20,0x00], request_id=0\n";
            }
            
            // Publish to Elodin
            if (!client.publish(pt_packet_id, pt_msg)) {
                std::cerr << "❌ Failed to publish message #" << (i+1) << std::endl;
                continue;
            }
            
            if (i < 5 || i % 10 == 0) {
                std::cout << "  Sent #" << (i+1) << " (channel=" << (int)channel_id 
                          << ", adc=" << raw_adc_counts << ")" << std::endl;
            }
            
            // Flush after each message to ensure immediate delivery (like FSW)
            client.flush_buffer();
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        
        // Final flush
        client.flush_buffer();
        
        std::cout << std::endl;
        std::cout << "✅ Done! Sent " << message_count << " messages" << std::endl;
        std::cout << "   Open Elodin editor: elodin editor <db_path>" << std::endl;
        
        client.disconnect();
        
    } catch (const std::exception& e) {
        std::cerr << "❌ Error: " << e.what() << std::endl;
        return 1;
    }
    
    return 0;
}

