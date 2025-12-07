/**
 * @file live_esp32_elodin_stream.cpp
 * @brief Live ESP32 to Elodin DB streaming with real-time calibration
 * 
 * This system:
 * 1. Connects to ESP32 serial port (/dev/ttyACM0)
 * 2. Streams all PT data to Elodin DB in real-time
 * 3. Performs live calibration on channels 2 and 3
 * 4. Shows convergence plots and variance reduction
 * 5. Handles human-in-the-loop calibration feedback
 */

#include <iostream>
#include <iomanip>
#include <thread>
#include <chrono>
#include <signal.h>
#include <memory>
#include <vector>
#include <atomic>
#include <map>

// Flight software includes
#include "ESP32SerialHandler.hpp"
#include "ElodinDBInterface.hpp"
#include "PTCalibrationTool.hpp"
#include "EnvironmentalRobustCalibration.hpp"
#include "PTCalibrationFramework.hpp"
#include "Timer.hpp"

class LiveESP32ElodinStream {
private:
    std::shared_ptr<ESP32SerialHandler> esp32_handler_;
    std::shared_ptr<ElodinDBInterface> elodin_interface_;
    std::shared_ptr<RealTimeCalibrationMonitor> calibration_monitor_;
    std::shared_ptr<PTCalibrationTool> calibration_tool_;
    
    std::atomic<bool> running_;
    std::thread processing_thread_;
    
    // Calibration sessions for channels 2 and 3
    std::map<uint8_t, std::string> active_calibration_sessions_;
    std::map<uint8_t, std::vector<std::pair<double, double>>> calibration_data_; // voltage, reference_pressure
    
    // Statistics
    std::map<uint8_t, uint64_t> packet_counts_;
    std::map<uint8_t, std::chrono::steady_clock::time_point> last_seen_;

public:
    LiveESP32ElodinStream() : running_(false) {
        std::cout << "=== LIVE ESP32 TO ELODIN DB STREAMING SYSTEM ===" << std::endl;
        std::cout << "Initializing real-time PT data streaming and calibration..." << std::endl;
        
        // Initialize Elodin DB interface
        ElodinDBInterface::ElodinConfig elodin_config;
        elodin_config.host = "localhost";
        elodin_config.port = 8080;
        elodin_config.database_name = "live_pt_stream";
        elodin_config.flush_interval_ms = 100; // Very fast updates for real-time
        elodin_config.batch_size = 50; // Smaller batches for lower latency
        
        elodin_interface_ = std::make_shared<ElodinDBInterface>(elodin_config);
        if (!elodin_interface_->initialize()) {
            throw std::runtime_error("Failed to initialize Elodin DB interface");
        }
        if (!elodin_interface_->start()) {
            throw std::runtime_error("Failed to start Elodin DB streaming");
        }
        
        calibration_monitor_ = std::make_shared<RealTimeCalibrationMonitor>(elodin_interface_);
        calibration_tool_ = std::make_shared<PTCalibrationTool>("standard");
        
        // Initialize ESP32 handler for channels 2 and 3
        esp32_handler_ = createESP32Handler("/dev/ttyACM0", 115200);
        
        // Register callback for sensor data
        esp32_handler_->registerPTCallback(
            [this](uint8_t sensor_id, double raw_voltage_v, uint64_t timestamp, uint8_t pt_location) {
                this->onSensorData(sensor_id, raw_voltage_v, timestamp, pt_location);
            }
        );
        
        std::cout << "✓ Elodin DB interface initialized" << std::endl;
        std::cout << "✓ Calibration system ready" << std::endl;
        std::cout << "✓ ESP32 handler configured for /dev/ttyACM0" << std::endl;
        std::cout << "✓ Focusing on channels 2 and 3 for calibration" << std::endl;
    }
    
    ~LiveESP32ElodinStream() {
        stop();
    }
    
    bool start() {
        if (running_) {
            return true;
        }
        
        if (!esp32_handler_->start()) {
            std::cerr << "Failed to start ESP32 handler" << std::endl;
            return false;
        }
        
        running_ = true;
        processing_thread_ = std::thread(&LiveESP32ElodinStream::processingLoop, this);
        
        std::cout << "\n🚀 LIVE STREAMING STARTED!" << std::endl;
        std::cout << "📡 ESP32 data → Elodin DB" << std::endl;
        std::cout << "🔧 Real-time calibration on channels 2 & 3" << std::endl;
        std::cout << "📊 Live plots and variance tracking" << std::endl;
        std::cout << "\nPress Ctrl+C to stop..." << std::endl;
        
        return true;
    }
    
    void stop() {
        if (!running_) {
            return;
        }
        
        running_ = false;
        
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }
        
        if (esp32_handler_) {
            esp32_handler_->stop();
        }
        
        if (elodin_interface_) {
            elodin_interface_->stop();
        }
        
        std::cout << "\n🛑 Live streaming stopped" << std::endl;
    }
    
    void startCalibrationForChannel(uint8_t channel_id) {
        if (channel_id != 2 && channel_id != 3) {
            std::cout << "⚠️  Only channels 2 and 3 are supported for calibration" << std::endl;
            return;
        }
        
        if (active_calibration_sessions_.find(channel_id) != active_calibration_sessions_.end()) {
            std::cout << "⚠️  Calibration already active for channel " << static_cast<int>(channel_id) << std::endl;
            return;
        }
        
        // Create calibration procedure
        auto procedure = calibration_tool_->createCalibrationProcedure(
            "live_calibration_ch" + std::to_string(channel_id),
            0.0, 300000.0, // 0 to 300 kPa range
            10, // 10 data points
            true // Include environmental variations
        );
        
        // Start calibration session
        std::string session_id = calibration_tool_->startCalibrationSession(
            channel_id, channel_id, procedure);
        
        active_calibration_sessions_[channel_id] = session_id;
        calibration_data_[channel_id].clear();
        
        std::cout << "\n🔧 Started calibration for channel " << static_cast<int>(channel_id) 
                  << " (Session: " << session_id << ")" << std::endl;
        std::cout << "📝 Provide reference pressure values when prompted..." << std::endl;
    }
    
    void provideReferencePressure(uint8_t channel_id, double reference_pressure_pa) {
        auto it = active_calibration_sessions_.find(channel_id);
        if (it == active_calibration_sessions_.end()) {
            std::cout << "⚠️  No active calibration session for channel " << static_cast<int>(channel_id) << std::endl;
            return;
        }
        
        // Get latest voltage reading for this channel
        auto data_it = calibration_data_.find(channel_id);
        if (data_it == calibration_data_.end() || data_it->second.empty()) {
            std::cout << "⚠️  No recent voltage data for channel " << static_cast<int>(channel_id) << std::endl;
            return;
        }
        
        double voltage = data_it->second.back().first;
        std::string session_id = it->second;
        
        // Create environmental conditions (simplified for live operation)
        EnvironmentalState environment;
        environment.temperature = 25.0; // Room temperature
        environment.humidity = 50.0;    // Normal humidity
        environment.vibration_level = 0.1; // Low vibration
        environment.aging_factor = 1.0;    // No aging
        environment.mounting_torque = 25.0; // Standard torque
        
        // Add calibration data point
        calibration_tool_->addCalibrationDataPoint(session_id, voltage, reference_pressure_pa, environment);
        
        std::cout << "✓ Added calibration point: " << std::fixed << std::setprecision(2) 
                  << voltage << "V → " << reference_pressure_pa << "Pa" << std::endl;
        
        // Stream human feedback to Elodin DB
        calibration_monitor_->processHumanFeedback(
            "PT_" + std::to_string(channel_id),
            reference_pressure_pa,
            voltage,
            true // accepted
        );
        
        // Check if we have enough data points for calibration
        if (data_it->second.size() >= 5) {
            completeCalibrationForChannel(channel_id);
        }
    }
    
    void completeCalibrationForChannel(uint8_t channel_id) {
        auto it = active_calibration_sessions_.find(channel_id);
        if (it == active_calibration_sessions_.end()) {
            return;
        }
        
        std::string session_id = it->second;
        std::cout << "\n🔄 Completing calibration for channel " << static_cast<int>(channel_id) << "..." << std::endl;
        
        try {
            // Complete calibration with default priors
            Eigen::VectorXd default_mean = Eigen::VectorXd::Zero(3);
            default_mean(0) = 1000.0; // slope
            default_mean(1) = 100.0;  // offset
            default_mean(2) = 0.0;    // environmental factor
            
            Eigen::MatrixXd default_cov = Eigen::MatrixXd::Identity(3, 3) * 100.0;
            
            CalibrationSession session = calibration_tool_->completeCalibrationSession(
                session_id, &default_mean, &default_cov);
            
            if (session.calibration_successful) {
                std::cout << "✅ Calibration successful for channel " << static_cast<int>(channel_id) << "!" << std::endl;
                
                // Stream calibration results to Elodin DB
                calibration_monitor_->processCalibrationUpdate(
                    "PT_" + std::to_string(channel_id),
                    session.calibration_result,
                    1 // iteration
                );
                
                // Create real-time plots
                calibration_monitor_->createAllPlots("PT_" + std::to_string(channel_id));
                
                std::cout << "📊 Parameters: [";
                for (int i = 0; i < session.calibration_result.theta.size(); ++i) {
                    std::cout << std::fixed << std::setprecision(3) << session.calibration_result.theta(i);
                    if (i < session.calibration_result.theta.size() - 1) std::cout << ", ";
                }
                std::cout << "]" << std::endl;
                
                std::cout << "🎯 Real-time plots updated in Elodin DB!" << std::endl;
                
            } else {
                std::cout << "❌ Calibration failed for channel " << static_cast<int>(channel_id) << std::endl;
            }
            
        } catch (const std::exception& e) {
            std::cerr << "Calibration error: " << e.what() << std::endl;
        }
        
        // Clear the session
        active_calibration_sessions_.erase(it);
    }

private:
    void onSensorData(uint8_t sensor_id, double raw_voltage_v, uint64_t timestamp, uint8_t pt_location) {
        // Update statistics
        packet_counts_[sensor_id]++;
        last_seen_[sensor_id] = std::chrono::steady_clock::now();
        
        // Store latest voltage for calibration channels
        if (sensor_id == 2 || sensor_id == 3) {
            calibration_data_[sensor_id].push_back({raw_voltage_v, 0.0}); // reference pressure will be added later
            
            // Keep only last 100 points
            if (calibration_data_[sensor_id].size() > 100) {
                calibration_data_[sensor_id].erase(calibration_data_[sensor_id].begin());
            }
        }
        
        // Stream to Elodin DB
        std::string sensor_name = "PT_" + std::to_string(static_cast<int>(sensor_id));
        
        // Create PTMessage for streaming
        auto pt_message = std::make_shared<PTMessage>();
        pt_message->setField<0>(timestamp);
        pt_message->setField<1>(sensor_id);
        pt_message->setField<2>(raw_voltage_v);
        pt_message->setField<3>(pt_location);
        
        // Stream PT measurement to Elodin DB
        calibration_monitor_->processPTMeasurement(pt_message.get(), 0.0); // No reference pressure yet
        
        // Stream environmental conditions (simplified)
        EnvironmentalState environment;
        environment.temperature = 25.0;
        environment.humidity = 50.0;
        environment.vibration_level = 0.1;
        environment.aging_factor = 1.0;
        environment.mounting_torque = 25.0;
        
        elodin_interface_->streamEnvironmentalConditions(sensor_name, &environment, timestamp);
        
        // Print live status for channels 2 and 3
        if (sensor_id == 2 || sensor_id == 3) {
            std::cout << "📡 Ch" << static_cast<int>(sensor_id) 
                      << ": " << std::fixed << std::setprecision(4) << raw_voltage_v << "V"
                      << " [STREAMED TO ELODIN DB]";
            
            if (active_calibration_sessions_.find(sensor_id) != active_calibration_sessions_.end()) {
                std::cout << " [CALIBRATING]";
            }
            std::cout << std::endl;
        }
    }
    
    void processingLoop() {
        auto last_stats_time = std::chrono::steady_clock::now();
        
        while (running_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            
            auto now = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::seconds>(now - last_stats_time).count() >= 10) {
                printStatistics();
                last_stats_time = now;
            }
        }
    }
    
    void printStatistics() {
        std::cout << "\n📊 LIVE STREAMING STATISTICS:" << std::endl;
        std::cout << "================================" << std::endl;
        
        auto elodin_stats = elodin_interface_->getStreamingStats();
        std::cout << "Elodin DB: " << elodin_stats.total_points_sent << " points sent, "
                  << elodin_stats.queue_size << " in queue" << std::endl;
        
        for (const auto& pair : packet_counts_) {
            uint8_t sensor_id = pair.first;
            uint64_t count = pair.second;
            
            auto last_seen_it = last_seen_.find(sensor_id);
            if (last_seen_it != last_seen_.end()) {
                auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - last_seen_it->second).count();
                
                std::cout << "Ch" << static_cast<int>(sensor_id) << ": " << count 
                          << " packets, " << age << "ms ago";
                
                if (active_calibration_sessions_.find(sensor_id) != active_calibration_sessions_.end()) {
                    std::cout << " [CALIBRATING]";
                }
                std::cout << std::endl;
            }
        }
        
        std::cout << "Active calibration sessions: " << active_calibration_sessions_.size() << std::endl;
        std::cout << "================================" << std::endl;
    }
};

// Global instance for signal handling
std::unique_ptr<LiveESP32ElodinStream> g_stream;

void signalHandler(int signal) {
    std::cout << "\nReceived signal " << signal << ", shutting down..." << std::endl;
    if (g_stream) {
        g_stream->stop();
    }
}

void printUsage() {
    std::cout << "\n🎯 LIVE ESP32 TO ELODIN DB STREAMING SYSTEM" << std::endl;
    std::cout << "=============================================" << std::endl;
    std::cout << "Commands:" << std::endl;
    std::cout << "  start_cal_2    - Start calibration for channel 2" << std::endl;
    std::cout << "  start_cal_3    - Start calibration for channel 3" << std::endl;
    std::cout << "  ref_pressure_2 <pressure> - Provide reference pressure for channel 2" << std::endl;
    std::cout << "  ref_pressure_3 <pressure> - Provide reference pressure for channel 3" << std::endl;
    std::cout << "  complete_cal_2 - Complete calibration for channel 2" << std::endl;
    std::cout << "  complete_cal_3 - Complete calibration for channel 3" << std::endl;
    std::cout << "  stats          - Show current statistics" << std::endl;
    std::cout << "  help           - Show this help" << std::endl;
    std::cout << "  quit           - Exit the program" << std::endl;
    std::cout << "=============================================" << std::endl;
}

int main() {
    // Set up signal handling
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);
    
    try {
        // Create and start the streaming system
        g_stream = std::make_unique<LiveESP32ElodinStream>();
        
        if (!g_stream->start()) {
            std::cerr << "Failed to start live streaming system" << std::endl;
            return 1;
        }
        
        printUsage();
        
        // Interactive command loop
        std::string command;
        while (true) {
            std::cout << "\n> ";
            std::getline(std::cin, command);
            
            if (command == "quit" || command == "exit") {
                break;
            } else if (command == "start_cal_2") {
                g_stream->startCalibrationForChannel(2);
            } else if (command == "start_cal_3") {
                g_stream->startCalibrationForChannel(3);
            } else if (command.find("ref_pressure_2 ") == 0) {
                double pressure = std::stod(command.substr(15));
                g_stream->provideReferencePressure(2, pressure);
            } else if (command.find("ref_pressure_3 ") == 0) {
                double pressure = std::stod(command.substr(15));
                g_stream->provideReferencePressure(3, pressure);
            } else if (command == "complete_cal_2") {
                g_stream->completeCalibrationForChannel(2);
            } else if (command == "complete_cal_3") {
                g_stream->completeCalibrationForChannel(3);
            } else if (command == "stats") {
                // Stats are printed automatically every 10 seconds
                std::cout << "Statistics are printed automatically every 10 seconds." << std::endl;
            } else if (command == "help") {
                printUsage();
            } else if (command.empty()) {
                // Do nothing for empty commands
            } else {
                std::cout << "Unknown command: " << command << std::endl;
                std::cout << "Type 'help' for available commands." << std::endl;
            }
        }
        
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }
    
    std::cout << "\n👋 Live streaming system shutdown complete." << std::endl;
    return 0;
}
