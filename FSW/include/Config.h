#ifndef CONFIG_H
#define CONFIG_H

#include <array>
#include <string>
#include <map>
#include <cstdint>

// Note: If tomlplusplus is not available, we can use a simple TOML parser
// For now, using basic file reading until tomlplusplus is integrated

class Config {
   public:
    // Constructor, loads config
    explicit Config(const std::string& configFile);
    void loadConfigMatrix(double* mat, int m, int n, const char* group,
                          const char* id);

    struct NetworkConfig {
        std::string host_ip;
        std::string local_ip;
        std::string jetson_ip;
        std::string root_fsw_dir;
        int port_min;
    };

    struct HITLConfig {
        bool HITL_flag;
        bool simulate_velocity_flag;
        std::array<double, 3> simulated_velocity_NED;
        bool simulate_accel_flag;
        std::array<double, 3> simulated_accel_NED;
    };

    // Telemetry struct
    struct TelemetryConfig {
        std::string publish_ip;
        int publish_port;
        int publish_max_clients;
        double frequency;
        size_t buffer_size;
    };

    // Diablo Sensor System config
    struct DiabloSensorConfig {
        std::string udp_bind_ip;
        int udp_listen_port;
        std::string publish_ip;
        int publish_port;
        int publish_max_clients;
        bool logger_flag;
        int max_buffer;
        double packet_timeout_sec;
        std::string calibration_file_path;  // Path to calibration backup JSON file
    };

    // Navigation struct
    struct NavigationConfig {
        double initial_accel_bias_x;
        double initial_accel_bias_y;
        double initial_accel_bias_z;
        double initial_gyro_bias_x;
        double initial_gyro_bias_y;
        double initial_gyro_bias_z;
        std::string publish_ip;
        int publish_port;
        int publish_max_clients;
        bool logger_flag;
        double calibration_time_length;
        int max_buffer;
    };

    // Control struct
    struct ControlConfig {
        std::string publish_ip;
        std::string can_interface;
        int node_id;
        std::array<int, 4> node_index;
        int publish_port;
        int publish_max_clients;
        bool logger_flag;
    };

    struct StateMachineConfig {
        std::string publish_ip;
        int state_machine_loop_time_ns;
        int publish_port;
        int publish_max_clients;
        double abort_pressure_threshold;
        double abort_temperature_threshold;
        double abort_cutoff_time;
    };

    // Message IDs
    struct MessageIDs {
        uint8_t mfPTMessage;
        uint8_t mfTCMessage;
        uint8_t mfRTDMessage;
        uint8_t mfLCMessage;
        uint8_t mfNavigationMessage;
        uint8_t ControlMessage;
        uint8_t StateMachineOutput;
        uint8_t EngineControlMessage;
        uint8_t ValveControlMessage;
    };

    // Public access to configurations
    NetworkConfig network;
    HITLConfig hitl;
    TelemetryConfig telemetry;
    DiabloSensorConfig diablo_sensor;
    NavigationConfig navigation;
    ControlConfig control;
    StateMachineConfig state_machine;
    MessageIDs messageIDs;

   private:
    // Simple TOML-like config storage (can be replaced with tomlplusplus)
    std::map<std::string, std::map<std::string, std::string>> configData;
    
    // Private method to load configuration from file
    void loadConfig(const std::string& configFile);
    std::string getValue(const std::string& section, const std::string& key, const std::string& default_val);
    double getDouble(const std::string& section, const std::string& key, double default_val);
    int getInt(const std::string& section, const std::string& key, int default_val);
    bool getBool(const std::string& section, const std::string& key, bool default_val);
    std::array<double, 3> getArray3(const std::string& section, const std::string& key, std::array<double, 3> default_val);
    std::array<int, 4> getArray4Int(const std::string& section, const std::string& key, std::array<int, 4> default_val);
};

#endif  // CONFIG_H

