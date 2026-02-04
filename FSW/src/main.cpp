#include <signal.h>

#include <chrono>
#include <exception>
#include <iostream>
#include <memory>
#include <thread>

// Control system includes
#include "../control/include/EngineControl.hpp"
#include "../control/include/GainScheduling.hpp"
#include "../control/include/OptimalController.hpp"
#include "../control/include/ValveController.hpp"

// Communication system includes
#include "../comms/include/CommunicationProtocol.hpp"
#include "../comms/include/PacketProtocol.hpp"

// Calibration system includes
#include "../calibration/include/EncoderCalibration.hpp"
#include "../calibration/include/SensorCalibration.hpp"

// Navigation system includes
#include "../nav/include/EKFNavigation.hpp"
#include "../nav/include/SensorFusion.hpp"

// State management includes
#include "../state/include/StateMachine.hpp"

// Global variables for graceful shutdown
std::atomic<bool> running{true};
std::unique_ptr<EngineControl> engine_control;
std::unique_ptr<StateMachine> state_machine;
std::unique_ptr<EKFNavigation> navigation_system;
std::unique_ptr<PacketProtocol> packet_protocol;
std::unique_ptr<CommunicationProtocol> comm_protocol;
std::unique_ptr<GainScheduling> gain_scheduling;
std::unique_ptr<SensorCalibration> sensor_calibration;
std::unique_ptr<OptimalController> optimal_controller;
std::unique_ptr<MultiEncoderCalibrationManager> encoder_calibration_manager;

// Signal handler for graceful shutdown
void signalHandler(int signum) {
    (void)signum;  // Suppress unused parameter warning
    std::cout << "\n🛑 Shutdown signal received. Initiating graceful shutdown..." << std::endl;
    running = false;
}

// Initialize all subsystems
bool initializeSubsystems() {
    std::cout << "🚀 Initializing Liquid Engine Flight Software..." << std::endl;

    try {
        // Initialize state machine first (all other systems depend on it)
        std::cout << "  📊 Initializing State Machine..." << std::endl;
        state_machine = std::make_unique<StateMachine>();
        if (!state_machine->initialize()) {
            std::cerr << "❌ Failed to initialize State Machine" << std::endl;
            return false;
        }

        // Initialize sensor calibration system
        std::cout << "  🔧 Initializing Sensor Calibration..." << std::endl;
        sensor_calibration = std::make_unique<SensorCalibration>();

        // Initialize encoder calibration manager
        std::cout << "  🎯 Initializing Encoder Calibration..." << std::endl;
        encoder_calibration_manager = std::make_unique<MultiEncoderCalibrationManager>();
        if (!encoder_calibration_manager->initialize()) {
            std::cerr << "❌ Failed to initialize Encoder Calibration Manager" << std::endl;
            return false;
        }

        // Initialize navigation system
        std::cout << "  🧭 Initializing Navigation System..." << std::endl;
        navigation_system = std::make_unique<EKFNavigation>();

        EKFNavigation::EKFConfig nav_config;
        nav_config.position_process_noise = 1e-6;
        nav_config.velocity_process_noise = 1e-4;
        nav_config.attitude_process_noise = 1e-5;
        nav_config.bias_process_noise = 1e-8;
        nav_config.scale_process_noise = 1e-8;
        nav_config.engine_process_noise = 1e-4;

        nav_config.imu_accel_noise = 1e-4;
        nav_config.imu_gyro_noise = 1e-6;
        nav_config.gps_position_noise = 1e-2;
        nav_config.gps_velocity_noise = 1e-3;
        nav_config.barometer_noise = 1e-2;
        nav_config.engine_noise = 1e-3;

        nav_config.initial_position_uncertainty = 1.0;
        nav_config.initial_velocity_uncertainty = 0.1;
        nav_config.initial_attitude_uncertainty = 0.1;
        nav_config.initial_bias_uncertainty = 1e-3;

        nav_config.enable_adaptive_filtering = true;
        nav_config.enable_outlier_rejection = true;
        nav_config.outlier_threshold = 3.0;
        nav_config.innovation_threshold = 0.95;
        nav_config.enable_robust_estimation = true;

        // Initialize with default state
        EKFNavigation::NavigationState initial_nav_state;
        initial_nav_state.state_vector = Eigen::VectorXd::Zero(EKFNavigation::STATE_DIM);
        initial_nav_state.state_vector(0) = 0.0;  // X position
        initial_nav_state.state_vector(1) = 0.0;  // Y position
        initial_nav_state.state_vector(2) = 0.0;  // Z position
        initial_nav_state.state_vector(6) = 1.0;  // Quaternion W
        initial_nav_state.covariance_matrix =
            Eigen::MatrixXd::Identity(EKFNavigation::STATE_DIM, EKFNavigation::STATE_DIM) * 0.01;
        initial_nav_state.mode = EKFNavigation::NavigationMode::INITIALIZATION;
        initial_nav_state.valid = true;
        initial_nav_state.quality = 0.0;
        initial_nav_state.timestamp = std::chrono::steady_clock::now();

        if (!navigation_system->initialize(nav_config, initial_nav_state)) {
            std::cerr << "❌ Failed to initialize Navigation System" << std::endl;
            return false;
        }

        // Initialize gain scheduling
        std::cout << "  ⚙️  Initializing Gain Scheduling..." << std::endl;
        gain_scheduling = std::make_unique<GainScheduling>();

        GainScheduling::SchedulingConfig scheduling_config;
        scheduling_config.primary_variables = {GainScheduling::SchedulingVariable::CHAMBER_PRESSURE,
                                               GainScheduling::SchedulingVariable::THRUST};
        scheduling_config.secondary_variables = {GainScheduling::SchedulingVariable::MIXTURE_RATIO,
                                                 GainScheduling::SchedulingVariable::TEMPERATURE};
        scheduling_config.interpolation_threshold = 0.1;
        scheduling_config.enable_adaptive_scheduling = true;
        scheduling_config.enable_robust_scheduling = true;
        scheduling_config.robustness_factor = 0.8;
        scheduling_config.update_rate = std::chrono::milliseconds(100);  // 10 Hz

        if (!gain_scheduling->initialize(scheduling_config)) {
            std::cerr << "❌ Failed to initialize Gain Scheduling" << std::endl;
            return false;
        }

        // Initialize optimal controller
        std::cout << "  🎛️  Initializing Optimal Controller..." << std::endl;
        optimal_controller = std::make_unique<OptimalController>();

        OptimalController::ControlState initial_control_state;
        initial_control_state.thrust = 0.0;
        initial_control_state.chamber_pressure = 101325.0;  // Atmospheric pressure
        initial_control_state.fuel_flow_rate = 0.0;
        initial_control_state.ox_flow_rate = 0.0;
        initial_control_state.mixture_ratio = 6.0;
        initial_control_state.specific_impulse = 0.0;
        initial_control_state.fuel_valve_position = 0.0;
        initial_control_state.ox_valve_position = 0.0;
        initial_control_state.temperature = 298.15;  // 25°C
        initial_control_state.pressure_ambient = 101325.0;
        initial_control_state.humidity = 50.0;
        initial_control_state.efficiency = 0.0;
        initial_control_state.vibration_level = 0.0;
        initial_control_state.noise_level = 0.0;
        initial_control_state.timestamp = std::chrono::steady_clock::now();

        if (!optimal_controller->initialize(
                OptimalController::ControlAlgorithm::MODEL_PREDICTIVE_CONTROL,
                initial_control_state)) {
            std::cerr << "❌ Failed to initialize Optimal Controller" << std::endl;
            return false;
        }

        // Initialize packet protocol for Jetson communication
        std::cout << "  📦 Initializing Packet Protocol..." << std::endl;
        packet_protocol = std::make_unique<PacketProtocol>();

        if (!packet_protocol->initialize(2244)) {  // Listen on port 2244
            std::cerr << "❌ Failed to initialize Packet Protocol" << std::endl;
            return false;
        }

        // Initialize communication protocol for ground station
        std::cout << "  📡 Initializing Communication Protocol..." << std::endl;
        comm_protocol = std::make_unique<CommunicationProtocol>();

        CommunicationProtocol::CommunicationConfig comm_config;
        comm_config.network.ground_station_ip = "192.168.1.100";
        comm_config.network.ground_station_port = 2240;
        comm_config.network.local_ip = "192.168.1.50";
        comm_config.network.telemetry_port = 2241;
        comm_config.network.control_port = 2242;
        comm_config.network.discovery_port = 2243;
        comm_config.network.max_packet_size = 1024;
        comm_config.network.buffer_size = 8192;

        comm_config.telemetry.telemetry_types = {CommunicationProtocol::MessageType::ENGINE_STATUS,
                                                 CommunicationProtocol::MessageType::SENSOR_DATA,
                                                 CommunicationProtocol::MessageType::SYSTEM_HEALTH};
        comm_config.telemetry.telemetry_rate = std::chrono::milliseconds(50);  // 20 Hz
        comm_config.telemetry.enable_compression = true;
        comm_config.telemetry.enable_encryption = false;
        comm_config.telemetry.data_quality_threshold = 0.8;

        comm_config.reliability.max_retransmissions = 3;
        comm_config.reliability.ack_timeout = std::chrono::milliseconds(1000);
        comm_config.reliability.heartbeat_interval = std::chrono::milliseconds(5000);
        comm_config.reliability.enable_sequence_numbering = true;
        comm_config.reliability.enable_checksum_validation = true;

        if (!comm_protocol->initialize(comm_config)) {
            std::cerr << "❌ Failed to initialize Communication Protocol" << std::endl;
            return false;
        }

        // Initialize engine control system
        std::cout << "  🚀 Initializing Engine Control..." << std::endl;
        engine_control = std::make_unique<EngineControl>();

        // Set up subsystem communication
        std::cout << "  🔗 Setting up subsystem communication..." << std::endl;

        // Register packet protocol handlers for Jetson sensor data
        packet_protocol->registerSensorHandler(
            PacketProtocol::SensorType::PRESSURE_TRANSDUCER,
            [](const PacketProtocol::SensorData& sensor_data) {
                // Route pressure transducer data to navigation and control systems
                std::cout << "📊 Received pressure transducer data from sensor "
                          << (int)sensor_data.sensor_id << std::endl;
                // TODO: Process sensor data and update navigation/control systems
            });

        packet_protocol->registerSensorHandler(PacketProtocol::SensorType::IMU_ACCELEROMETER,
                                               [](const PacketProtocol::SensorData& sensor_data) {
                                                   // Route IMU data to navigation system
                                                   std::cout << "🧭 Received IMU accelerometer data"
                                                             << std::endl;
                                                   // TODO: Process IMU data and update navigation
                                                   // system
                                               });

        packet_protocol->registerSensorHandler(PacketProtocol::SensorType::GPS_POSITION,
                                               [](const PacketProtocol::SensorData& sensor_data) {
                                                   // Route GPS data to navigation system
                                                   std::cout << "🛰️ Received GPS position data"
                                                             << std::endl;
                                                   // TODO: Process GPS data and update navigation
                                                   // system
                                               });

        // Register communication protocol handlers for ground station commands
        comm_protocol->registerMessageHandler(
            CommunicationProtocol::MessageType::ENGINE_COMMAND,
            [](const CommunicationProtocol::Message& msg) {
                std::cout << "📨 Received engine command from ground station" << std::endl;
                // TODO: Process engine command
            });

        comm_protocol->registerMessageHandler(
            CommunicationProtocol::MessageType::VALVE_COMMAND,
            [](const CommunicationProtocol::Message& msg) {
                std::cout << "📨 Received valve command from ground station" << std::endl;
                // TODO: Process valve command
            });

        comm_protocol->registerMessageHandler(
            CommunicationProtocol::MessageType::ABORT_COMMAND,
            [](const CommunicationProtocol::Message& msg) {
                std::cout << "🚨 Received abort command from ground station" << std::endl;
                if (state_machine) {
                    state_machine->requestAbort("Ground station abort command");
                }
            });

        std::cout << "✅ All subsystems initialized successfully!" << std::endl;
        return true;

    } catch (const std::exception& e) {
        std::cerr << "❌ Exception during initialization: " << e.what() << std::endl;
        return false;
    }
}

// Run all subsystems
void runSubsystems() {
    std::cout << "🏃 Starting all subsystems..." << std::endl;

    // Start navigation system
    if (navigation_system) {
        navigation_system->run();
    }

    // Start packet protocol
    if (packet_protocol) {
        packet_protocol->run();
    }

    // Start communication protocol
    if (comm_protocol) {
        comm_protocol->run();
    }

    // Start state machine
    if (state_machine) {
        state_machine->run();
    }

    // Start optimal controller
    if (optimal_controller) {
        optimal_controller->run();
    }

    // Start engine control
    if (engine_control) {
        engine_control->run();
    }

    std::cout << "✅ All subsystems started!" << std::endl;
}

// Shutdown all subsystems
void shutdownSubsystems() {
    std::cout << "🛑 Shutting down subsystems..." << std::endl;

    // Stop engine control first
    if (engine_control) {
        engine_control->stop();
    }

    // Stop optimal controller
    if (optimal_controller) {
        optimal_controller->stop();
    }

    // Stop state machine
    if (state_machine) {
        state_machine->stop();
    }

    // Stop communication protocol
    if (comm_protocol) {
        comm_protocol->stop();
    }

    // Stop packet protocol
    if (packet_protocol) {
        packet_protocol->stop();
    }

    // Stop navigation system
    if (navigation_system) {
        navigation_system->stop();
    }

    std::cout << "✅ All subsystems shut down!" << std::endl;
}

// Main control loop
void mainControlLoop() {
    std::cout << "🔄 Starting main control loop..." << std::endl;

    auto last_status_time = std::chrono::steady_clock::now();
    auto last_telemetry_time = std::chrono::steady_clock::now();
    auto last_control_time = std::chrono::steady_clock::now();

    while (running) {
        try {
            auto current_time = std::chrono::steady_clock::now();

            // Status updates every 1 second
            if (current_time - last_status_time >= std::chrono::seconds(1)) {
                if (state_machine) {
                    auto current_state = state_machine->getCurrentState();
                    std::cout << "📊 Current State: " << static_cast<int>(current_state)
                              << std::endl;
                }

                if (navigation_system) {
                    auto nav_state = navigation_system->getCurrentState();
                    std::cout << "🧭 Navigation Mode: " << static_cast<int>(nav_state.mode)
                              << ", Quality: " << nav_state.quality << std::endl;
                }

                if (packet_protocol) {
                    auto stats = packet_protocol->getStatistics();
                    std::cout << "📦 Packets Received: " << stats.total_packets_received
                              << ", Dropped: " << stats.packets_dropped << std::endl;
                }

                last_status_time = current_time;
            }

            // Control updates every 10ms (100 Hz)
            if (current_time - last_control_time >= std::chrono::milliseconds(10)) {
                // TODO: Implement main control logic
                // 1. Get current navigation state
                // 2. Get current engine state from state machine
                // 3. Compute optimal control commands
                // 4. Apply encoder calibration mapping
                // 5. Send commands to Jetson via packet protocol

                last_control_time = current_time;
            }

            // Telemetry updates every 100ms
            if (current_time - last_telemetry_time >= std::chrono::milliseconds(100)) {
                // Send telemetry data to ground station
                if (comm_protocol && navigation_system) {
                    auto nav_state = navigation_system->getCurrentState();

                    // Create telemetry message
                    CommunicationProtocol::Message telemetry_msg;
                    telemetry_msg.type = CommunicationProtocol::MessageType::SENSOR_DATA;
                    telemetry_msg.priority = CommunicationProtocol::Priority::NORMAL;
                    telemetry_msg.timestamp = current_time;
                    telemetry_msg.source_id = "engine_controller";
                    telemetry_msg.destination_id = "ground_station";

                    // Serialize navigation state data
                    std::vector<uint8_t> data;
                    data.reserve(1024);

                    // Add position data
                    if (nav_state.state_vector.size() >= 3) {
                        double x_pos = nav_state.state_vector(0);
                        double y_pos = nav_state.state_vector(1);
                        double z_pos = nav_state.state_vector(2);
                        data.insert(data.end(), reinterpret_cast<const uint8_t*>(&x_pos),
                                    reinterpret_cast<const uint8_t*>(&x_pos) + sizeof(x_pos));
                        data.insert(data.end(), reinterpret_cast<const uint8_t*>(&y_pos),
                                    reinterpret_cast<const uint8_t*>(&y_pos) + sizeof(y_pos));
                        data.insert(data.end(), reinterpret_cast<const uint8_t*>(&z_pos),
                                    reinterpret_cast<const uint8_t*>(&z_pos) + sizeof(z_pos));
                    }

                    telemetry_msg.payload = data;
                    comm_protocol->sendMessage(telemetry_msg);
                }
                last_telemetry_time = current_time;
            }

            // Sleep for control loop period
            std::this_thread::sleep_for(std::chrono::milliseconds(5));  // 200 Hz main loop

        } catch (const std::exception& e) {
            std::cerr << "❌ Exception in main control loop: " << e.what() << std::endl;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }

    std::cout << "🔄 Main control loop stopped" << std::endl;
}

int main(int argc, char* argv[]) {
    std::cout << "🚀 Liquid Engine Flight Software v2.0" << std::endl;
    std::cout << "=====================================" << std::endl;

    // Set up signal handlers for graceful shutdown
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    try {
        // Initialize all subsystems
        if (!initializeSubsystems()) {
            std::cerr << "❌ Failed to initialize subsystems. Exiting." << std::endl;
            return 1;
        }

        // Start all subsystems
        runSubsystems();

        // Start main control loop
        std::thread control_thread(mainControlLoop);

        // Wait for shutdown signal
        while (running) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // Join control thread
        if (control_thread.joinable()) {
            control_thread.join();
        }

        // Shutdown all subsystems
        shutdownSubsystems();

        std::cout << "👋 Liquid Engine Flight Software shutdown complete." << std::endl;
        return 0;

    } catch (const std::exception& e) {
        std::cerr << "❌ Fatal exception: " << e.what() << std::endl;
        shutdownSubsystems();
        return 1;
    } catch (...) {
        std::cerr << "❌ Unknown fatal exception" << std::endl;
        shutdownSubsystems();
        return 1;
    }
}
