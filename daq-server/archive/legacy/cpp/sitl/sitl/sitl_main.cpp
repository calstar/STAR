#include <signal.h>
#include <unistd.h>

#include <iostream>

#include "../../daq_comms/include/config/ConfigParser.hpp"
#include "SITLSimulator.hpp"

static std::atomic<bool> g_running{true};

void signal_handler(int sig) {
    (void)sig;
    g_running = false;
}

int main(int argc, char* argv[]) {
    std::cout << "=== Diablo FSW SITL Simulator ===" << std::endl;

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Parse configuration
    std::string config_path = "config/config_sitl.toml";
    if (argc > 1) {
        config_path = argv[1];
    }

    // TODO: Load configuration from TOML
    // For now, use defaults
    fsw::sitl::SITLSimulator::SITLConfig config;
    config.elodin_host = "127.0.0.1";
    config.elodin_port = 2240;
    config.simulation_rate_hz = 100.0;
    config.realtime = true;

    // Initialize simulator
    fsw::sitl::SITLSimulator simulator;
    if (!simulator.initialize(config)) {
        std::cerr << "Failed to initialize SITL simulator" << std::endl;
        return 1;
    }

    // Start simulation
    simulator.start();

    std::cout << "SITL simulator running. Press Ctrl+C to stop." << std::endl;

    // Main loop
    while (g_running && simulator.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        // Print status periodically
        static int counter = 0;
        if (++counter % 50 == 0) {
            auto state = simulator.get_state();
            std::cout << "Time: " << simulator.get_simulation_time() << "s | "
                      << "Alt: " << state.altitude << "m | " << "Vel: " << state.velocity
                      << "m/s | " << "Thrust: " << state.thrust << "N" << std::endl;
        }
    }

    // Stop simulator
    simulator.stop();

    std::cout << "SITL simulator stopped." << std::endl;
    return 0;
}
