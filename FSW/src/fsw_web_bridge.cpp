#include <chrono>
#include <iostream>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

#include "App.h"  // uWebSockets
#include "elodin/ElodinClient.hpp"

using json = nlohmann::json;

int main() {
    int port = 8081;

    std::cout << "🚀 Starting FSW WebSocket Bridge on port " << port << "..." << std::endl;

    // Initialize Elodin
    auto elodin_client = std::make_shared<fsw::elodin::ElodinClient>();
    if (!elodin_client->connect("127.0.0.1", 3000)) {
        std::cerr << "❌ Failed to connect to Elodin DB!" << std::endl;
        return 1;
    }

    struct PerSocketData {
        /* fill with user data */
    };

    /* uWebSockets App */
    uWS::App *global_app = nullptr;

    uWS::App app = uWS::App().ws<PerSocketData>(
        "/*", {/* Settings */
               .compression = uWS::SHARED_COMPRESSOR,
               .maxPayloadLength = 16 * 1024 * 1024,
               .idleTimeout = 60,
               .maxBackpressure = 1 * 1024 * 1024,

               /* Handlers */
               .upgrade = nullptr,
               .open =
                   [](auto *ws) {
                       std::cout << "🌐 Client Connected" << std::endl;
                       ws->subscribe("broadcast");

                       // TODO: Send INITIAL_STATE and HISTORICAL_DATA
                   },
               .message =
                   [](auto *ws, std::string_view message, uWS::OpCode opCode) {
                       std::cout << "📥 Message from client: " << message << std::endl;
                       // TODO: Handle SEND_COMMAND (State change, actuator command)
                   },
               .drain =
                   [](auto * /*ws*/) {
                       /* Check ws->getBufferedAmount() here */
                   },
               .ping =
                   [](auto * /*ws*/, std::string_view) {
                   },
               .pong =
                   [](auto * /*ws*/, std::string_view) {
                   },
               .close =
                   [](auto * /*ws*/, int /*code*/, std::string_view /*message*/) {
                       std::cout << "❌ Client Disconnected" << std::endl;
                   }});

    global_app = &app;

    // Load dynamic config map
    std::string config_script =
        "python3 " + std::string(argv[0]).substr(0, std::string(argv[0]).find_last_of('/')) +
        "/../../scripts/export_sensor_config.py";
    system(config_script.c_str());

    std::map<std::string, std::string> sensor_map;
    try {
        std::ifstream f("/tmp/sensor_map.json");
        if (f.is_open()) {
            json j = json::parse(f);
            for (auto &el : j.items()) {
                sensor_map[el.key()] = el.value().get<std::string>();
            }
            std::cout << "[WebBridge] Loaded " << sensor_map.size()
                      << " dynamic sensor mappings.\n";
        } else {
            std::cerr << "[WebBridge] Warning: Could not open /tmp/sensor_map.json\n";
        }
    } catch (const std::exception &e) {
        std::cerr << "[WebBridge] Warning: JSON parsing failed for sensor map: " << e.what()
                  << "\n";
    }

    // Pass the sensor_map into the telemetry thread loop
    std::thread telemetry_thread([&global_app, elodin_client, loop, sensor_map]() {
        // Subscribe to all Elodin streams using the "Stream" msg_id
        std::vector<uint8_t> stream_payload = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                               0x00, 0x00, 0x00, 0x00, 0x00};
        auto stream_id = fsw::elodin::msg_id("Stream");
        elodin_client->send_msg(stream_id, stream_payload);

        uint8_t packet_buffer[4096];
        while (true) {
            if (!global_app) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }

            ssize_t packet_len = elodin_client->read_packet(packet_buffer, sizeof(packet_buffer));
            if (packet_len > 12) {
                uint8_t type = packet_buffer[4];
                uint8_t high = packet_buffer[5];
                uint8_t low = packet_buffer[6];
                const uint8_t *payload = packet_buffer + 12;
                size_t payload_len = packet_len - 12;

                std::string entity;
                std::string component;
                double value = 0.0;
                uint32_t sample_ms = 0;

                if (type == 1 && payload_len >= 21) {
                    sample_ms = *reinterpret_cast<const uint32_t *>(payload + 16);

                    std::string hex_id = "0x" +
                                         (std::stringstream() << std::hex << (int)high).str() +
                                         "_" + std::to_string(low);

                    if (sensor_map.count(hex_id)) {
                        entity = sensor_map.at(hex_id);
                    } else {
                        // Fallback minimal mappings if dynamic config is missing a sensor
                        if (high == 0x20)
                            entity = (low >= 0x11) ? "PT_Cal.CH" + std::to_string(low - 0x10)
                                                   : "PT.CH" + std::to_string(low);
                        else if (high == 0x21)
                            entity = (low >= 0x11) ? "TC_Cal.TC_CH" + std::to_string(low - 0x10)
                                                   : "TC.TC_CH" + std::to_string(low);
                        else if (high == 0x22)
                            entity = (low >= 0x11) ? "RTD_Cal.RTD_CH" + std::to_string(low - 0x10)
                                                   : "RTD.RTD_CH" + std::to_string(low);
                        else if (high == 0x23)
                            entity = (low >= 0x11) ? "LC_Cal.LC_CH" + std::to_string(low - 0x10)
                                                   : "LC.LC_CH" + std::to_string(low);
                        else if (high == 0x30)
                            entity = "ACT.Channel_" + std::to_string(low);
                    }

                    // Determine standard components
                    if (high == 0x20 || high == 0x21 || high == 0x22 || high == 0x23) {
                        if (low >= 0x11) {
                            // Calibrated format (float at offset 12)
                            value = *reinterpret_cast<const float *>(payload + 12);
                            if (high == 0x20)
                                component = "pressure_psi";
                            else if (high == 0x21 || high == 0x22)
                                component = "temperature_c";
                            else if (high == 0x23)
                                component = "force_lbf";
                        } else {
                            // Raw format (uint32 at offset 12)
                            value = *reinterpret_cast<const uint32_t *>(payload + 12);
                            if (high == 0x22)
                                component = "raw_resistance";
                            else
                                component = "raw_adc_counts";
                        }
                    } else if (high == 0x30) {
                        component = "raw_adc_counts";
                        value = *reinterpret_cast<const uint32_t *>(payload + 12);
                    }
                }

                if (!entity.empty()) {
                    json update;
                    update["type"] = "sensor_update";
                    update["timestamp"] = sample_ms;
                    update["payload"] = {{"entity", entity},
                                         {"component", component},
                                         {"value", value},
                                         {"timestamp", sample_ms}};

                    std::string message = update.dump();
                    loop->defer([message, &global_app]() {
                        if (global_app) {
                            global_app->publish("broadcast", message, uWS::OpCode::TEXT);
                        }
                    });
                }
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
        }
    });

    app.listen(port,
               [port](auto *listen_socket) {
                   if (listen_socket) {
                       std::cout << "✅ Listening on port " << port << std::endl;
                   } else {
                       std::cerr << "❌ Failed to listen on port " << port << std::endl;
                   }
               })
        .run();

    telemetry_thread.join();
    return 0;
}
