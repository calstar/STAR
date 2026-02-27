/**
 * Fake generator for CalibratedPTMessage
 * Validates that calibrated PT data appears correctly in Elodin editor
 */

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <thread>

#include "../../utl/db.hpp"
#include "../include/comms/messages/filtered/FilteredMessages.hpp"
#include "../include/elodin/DatabaseConfig.hpp"
#include "../include/elodin/ElodinClient.hpp"

using namespace vtable;
using namespace vtable::builder;

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <db_port> [message_count]" << std::endl;
        std::cerr << "Example: " << argv[0] << " 2240 100" << std::endl;
        return 1;
    }

    uint16_t port = std::stoi(argv[1]);
    int message_count = (argc >= 3) ? std::stoi(argv[2]) : 100;

    std::cout << "🧪 Sending fake CalibratedPTMessage to Elodin" << std::endl;
    std::cout << "=============================================" << std::endl;
    std::cout << "DB: 127.0.0.1:" << port << std::endl;
    std::cout << "Messages: " << message_count << std::endl;

    // Connect to Elodin
    daq_comms::elodin::ElodinClient client;
    if (!client.connect("127.0.0.1", port)) {
        std::cerr << "❌ Failed to connect to Elodin DB" << std::endl;
        return 1;
    }

    std::cout << "✅ Connected to Elodin DB" << std::endl;

    // Register CalibratedPTMessage VTable
    // TODO: Add registration in DatabaseConfig
    std::cout << "⚠️  Note: CalibratedPTMessage VTable registration not yet implemented"
              << std::endl;
    std::cout << "   This test will fail until VTable is registered" << std::endl;
    std::cout << std::endl;

    // Packet ID for CalibratedPTMessage
    std::array<uint8_t, 2> calibrated_pt_packet_id = {0x30, 0x00};

    std::cout << "📤 Sending " << message_count << " CalibratedPTMessage(s)..." << std::endl;

    auto start_time = std::chrono::steady_clock::now();

    for (int i = 0; i < message_count; ++i) {
        // Create calibrated PT message with realistic pressure values
        comms::messages::filtered::CalibratedPTMessage msg;

        auto now = std::chrono::steady_clock::now();
        auto duration = now.time_since_epoch();
        uint64_t timestamp_ns =
            std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();

        uint8_t channel_id = i % 6;  // Cycle through channels 0-5

        // Generate realistic pressure: sine wave + noise
        double t = i * 0.1;                                       // Time in seconds
        double base_pressure = 100000.0;                          // 100 kPa base pressure
        double pressure_variation = 50000.0 * std::sin(t * 0.5);  // ±50 kPa variation
        double pressure = base_pressure + pressure_variation;

        double temperature = 25.0 + 5.0 * std::sin(t * 0.3);  // Temperature variation

        float quality = 0.95f + 0.05f * std::sin(t);  // Quality between 0.95-1.0
        uint8_t valid = 1;

        std::get<0>(msg.fields) = timestamp_ns;
        std::get<1>(msg.fields) = channel_id;
        std::get<2>(msg.fields) = pressure;
        std::get<3>(msg.fields) = temperature;
        std::get<4>(msg.fields) = quality;
        std::get<5>(msg.fields) = valid;

        client.publish(calibrated_pt_packet_id, msg);

        if ((i + 1) % 10 == 0) {
            std::cout << "Sent #" << (i + 1) << " (channel=" << (int)channel_id
                      << ", pressure=" << (int)pressure << " Pa)" << std::endl;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    auto end_time = std::chrono::steady_clock::now();
    auto elapsed =
        std::chrono::duration_cast<std::chrono::milliseconds>(end_time - start_time).count();

    std::cout << std::endl;
    std::cout << "✅ Done! Sent " << message_count << " messages in " << elapsed << " ms"
              << std::endl;
    std::cout << std::endl;
    std::cout << "Open Elodin editor: elodin editor <db_path>" << std::endl;

    return 0;
}
