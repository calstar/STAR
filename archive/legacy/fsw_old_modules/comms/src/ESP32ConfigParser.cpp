#include "ESP32ConfigParser.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iostream>
#include <sstream>

ESP32SystemConfig::ESP32SystemConfig() {
    // Default serial configuration
    device_path = "/dev/ttyUSB0";
    baud_rate = 115200;
    timeout_ms = 100;
    max_buffer_size = 1024;
    enable_binary_mode = true;

    // Default PT sensor configuration
    max_pt_sensors = 9;
    max_data_age_ms = 1000.0;

    // Default observation matrix configuration
    enable_outlier_detection = true;
    outlier_threshold_sigma = 3.0;
    time_sync_tolerance_ms = 50.0;
    enable_interpolation = false;
    interpolation_window_ms = 100.0;

    // Default logging configuration
    log_level = "INFO";
    enable_console_output = true;
    enable_file_logging = false;
    log_file_path = "/var/log/esp32_pt_sensors.log";

    // Default development settings
    enable_debug_output = false;
    print_raw_data = false;
    print_observation_matrices = false;
    simulate_missing_sensors = false;
    simulate_sensor_delay = false;

    // Default PT location mapping
    pt_location_mapping[0] = "PRESSURANT_TANK";
    pt_location_mapping[1] = "KERO_INLET";
    pt_location_mapping[2] = "KERO_OUTLET";
    pt_location_mapping[3] = "LOX_INLET";
    pt_location_mapping[4] = "LOX_OUTLET";
    pt_location_mapping[5] = "INJECTOR";
    pt_location_mapping[6] = "CHAMBER_WALL_1";
    pt_location_mapping[7] = "CHAMBER_WALL_2";
    pt_location_mapping[8] = "NOZZLE_EXIT";
}

bool ESP32SystemConfig::validate() const {
    if (device_path.empty()) {
        return false;
    }

    if (baud_rate <= 0) {
        return false;
    }

    if (timeout_ms == 0) {
        return false;
    }

    if (max_buffer_size == 0) {
        return false;
    }

    if (max_pt_sensors == 0 || max_pt_sensors > 10) {
        return false;
    }

    if (max_data_age_ms <= 0) {
        return false;
    }

    if (outlier_threshold_sigma <= 0) {
        return false;
    }

    return true;
}

std::string ESP32SystemConfig::getValidationError() const {
    if (device_path.empty()) {
        return "Device path cannot be empty";
    }

    if (baud_rate <= 0) {
        return "Baud rate must be positive";
    }

    if (timeout_ms == 0) {
        return "Timeout must be positive";
    }

    if (max_buffer_size == 0) {
        return "Max buffer size must be positive";
    }

    if (max_pt_sensors == 0 || max_pt_sensors > 10) {
        return "Max PT sensors must be between 1 and 10";
    }

    if (max_data_age_ms <= 0) {
        return "Max data age must be positive";
    }

    if (outlier_threshold_sigma <= 0) {
        return "Outlier threshold must be positive";
    }

    return "Unknown validation error";
}

ESP32ConfigParser::ESP32ConfigParser() {
}

ESP32ConfigParser::~ESP32ConfigParser() {
}

std::shared_ptr<ESP32SystemConfig> ESP32ConfigParser::loadConfig(const std::string& config_path) {
    std::string content = readFile(config_path);
    if (content.empty()) {
        setError("Failed to read configuration file: " + config_path);
        return nullptr;
    }

    return parseTOMLContent(content);
}

std::shared_ptr<ESP32SystemConfig> ESP32ConfigParser::loadDefaultConfig() {
    return loadConfig(getDefaultConfigPath());
}

bool ESP32ConfigParser::saveConfig(const ESP32SystemConfig& config,
                                   const std::string& config_path) {
    std::ofstream file(config_path);
    if (!file.is_open()) {
        setError("Failed to open configuration file for writing: " + config_path);
        return false;
    }

    // Write TOML configuration
    file << "# ESP32 Serial Communication Configuration\n";
    file << "# Configuration file for ESP32 PT sensor integration\n\n";

    file << "[serial]\n";
    file << "device_path = \"" << config.device_path << "\"\n";
    file << "baud_rate = " << config.baud_rate << "\n";
    file << "timeout_ms = " << config.timeout_ms << "\n";
    file << "max_buffer_size = " << config.max_buffer_size << "\n";
    file << "enable_binary_mode = " << (config.enable_binary_mode ? "true" : "false") << "\n\n";

    file << "[pt_sensors]\n";
    file << "max_pt_sensors = " << config.max_pt_sensors << "\n";
    file << "max_data_age_ms = " << config.max_data_age_ms << "\n\n";

    file << "[pt_sensors.location_mapping]\n";
    for (const auto& pair : config.pt_location_mapping) {
        file << "channel_" << static_cast<int>(pair.first) << " = \"" << pair.second << "\"\n";
    }
    file << "\n";

    file << "[observation_matrix]\n";
    file << "enable_outlier_detection = " << (config.enable_outlier_detection ? "true" : "false")
         << "\n";
    file << "outlier_threshold_sigma = " << config.outlier_threshold_sigma << "\n";
    file << "time_sync_tolerance_ms = " << config.time_sync_tolerance_ms << "\n";
    file << "enable_interpolation = " << (config.enable_interpolation ? "true" : "false") << "\n";
    file << "interpolation_window_ms = " << config.interpolation_window_ms << "\n\n";

    file << "[logging]\n";
    file << "log_level = \"" << config.log_level << "\"\n";
    file << "enable_console_output = " << (config.enable_console_output ? "true" : "false") << "\n";
    file << "enable_file_logging = " << (config.enable_file_logging ? "true" : "false") << "\n";
    file << "log_file_path = \"" << config.log_file_path << "\"\n\n";

    file << "[development]\n";
    file << "enable_debug_output = " << (config.enable_debug_output ? "true" : "false") << "\n";
    file << "print_raw_data = " << (config.print_raw_data ? "true" : "false") << "\n";
    file << "print_observation_matrices = "
         << (config.print_observation_matrices ? "true" : "false") << "\n";
    file << "simulate_missing_sensors = " << (config.simulate_missing_sensors ? "true" : "false")
         << "\n";
    file << "simulate_sensor_delay = " << (config.simulate_sensor_delay ? "true" : "false") << "\n";

    file.close();
    return true;
}

std::shared_ptr<ESP32SerialHandler> ESP32ConfigParser::createESP32Handler(
    const ESP32SystemConfig& config) {
    ESP32Config esp32_config;
    esp32_config.device_path = config.device_path;
    esp32_config.baud_rate = config.baud_rate;
    esp32_config.timeout_ms = config.timeout_ms;
    esp32_config.max_buffer_size = config.max_buffer_size;
    esp32_config.enable_binary_mode = config.enable_binary_mode;
    esp32_config.max_sensors = config.max_pt_sensors;

    return std::make_shared<ESP32SerialHandler>(esp32_config);
}

std::shared_ptr<PTObservationMatrixBuilder> ESP32ConfigParser::createPTObservationMatrixBuilder(
    const ESP32SystemConfig& config) {
    PTObservationMatrixConfig pt_config;
    pt_config.max_data_age_ms = config.max_data_age_ms;
    pt_config.time_sync_tolerance_ms = config.time_sync_tolerance_ms;
    pt_config.enable_outlier_detection = config.enable_outlier_detection;
    pt_config.outlier_threshold_sigma = config.outlier_threshold_sigma;
    pt_config.enable_interpolation = config.enable_interpolation;
    pt_config.interpolation_window_ms = config.interpolation_window_ms;
    pt_config.max_pt_sensors = config.max_pt_sensors;

    return std::make_shared<PTObservationMatrixBuilder>(pt_config);
}

std::string ESP32ConfigParser::getDefaultConfigPath() {
    return "config/esp32_config.toml";
}

bool ESP32ConfigParser::configFileExists(const std::string& config_path) {
    std::ifstream file(config_path);
    return file.good();
}

// Simple TOML parser implementation (basic key-value parsing)
std::shared_ptr<ESP32SystemConfig> ESP32ConfigParser::parseTOMLContent(const std::string& content) {
    auto config = std::make_shared<ESP32SystemConfig>();

    std::istringstream stream(content);
    std::string line;
    std::string current_section;

    while (std::getline(stream, line)) {
        // Remove comments and trim whitespace
        size_t comment_pos = line.find('#');
        if (comment_pos != std::string::npos) {
            line = line.substr(0, comment_pos);
        }

        // Trim whitespace
        line.erase(0, line.find_first_not_of(" \t"));
        line.erase(line.find_last_not_of(" \t") + 1);

        if (line.empty())
            continue;

        // Parse section headers
        if (line[0] == '[' && line[line.length() - 1] == ']') {
            current_section = line.substr(1, line.length() - 2);
            continue;
        }

        // Parse key-value pairs
        size_t eq_pos = line.find('=');
        if (eq_pos != std::string::npos) {
            std::string key = line.substr(0, eq_pos);
            std::string value = line.substr(eq_pos + 1);

            // Trim whitespace from key and value
            key.erase(0, key.find_first_not_of(" \t"));
            key.erase(key.find_last_not_of(" \t") + 1);
            value.erase(0, value.find_first_not_of(" \t"));
            value.erase(value.find_last_not_of(" \t") + 1);

            // Remove quotes from value if present
            if (value.length() >= 2 && value[0] == '"' && value[value.length() - 1] == '"') {
                value = value.substr(1, value.length() - 2);
            }

            // Parse based on section and key
            if (current_section == "serial") {
                parseSerialConfigValue(*config, key, value);
            } else if (current_section == "pt_sensors") {
                parsePTSensorConfigValue(*config, key, value);
            } else if (current_section == "observation_matrix") {
                parseObservationMatrixConfigValue(*config, key, value);
            } else if (current_section == "logging") {
                parseLoggingConfigValue(*config, key, value);
            } else if (current_section == "development") {
                parseDevelopmentConfigValue(*config, key, value);
            } else if (current_section == "pt_sensors.location_mapping") {
                parsePTLocationMappingValue(*config, key, value);
            }
        }
    }

    return config;
}

void ESP32ConfigParser::parseSerialConfigValue(ESP32SystemConfig& config, const std::string& key,
                                               const std::string& value) {
    if (key == "device_path") {
        config.device_path = value;
    } else if (key == "baud_rate") {
        config.baud_rate = std::stoi(value);
    } else if (key == "timeout_ms") {
        config.timeout_ms = std::stoul(value);
    } else if (key == "max_buffer_size") {
        config.max_buffer_size = std::stoul(value);
    } else if (key == "enable_binary_mode") {
        config.enable_binary_mode = (value == "true");
    }
}

void ESP32ConfigParser::parsePTSensorConfigValue(ESP32SystemConfig& config, const std::string& key,
                                                 const std::string& value) {
    if (key == "max_pt_sensors") {
        config.max_pt_sensors = std::stoul(value);
    } else if (key == "max_data_age_ms") {
        config.max_data_age_ms = std::stod(value);
    }
}

void ESP32ConfigParser::parseObservationMatrixConfigValue(ESP32SystemConfig& config,
                                                          const std::string& key,
                                                          const std::string& value) {
    if (key == "enable_outlier_detection") {
        config.enable_outlier_detection = (value == "true");
    } else if (key == "outlier_threshold_sigma") {
        config.outlier_threshold_sigma = std::stod(value);
    } else if (key == "time_sync_tolerance_ms") {
        config.time_sync_tolerance_ms = std::stod(value);
    } else if (key == "enable_interpolation") {
        config.enable_interpolation = (value == "true");
    } else if (key == "interpolation_window_ms") {
        config.interpolation_window_ms = std::stod(value);
    }
}

void ESP32ConfigParser::parseLoggingConfigValue(ESP32SystemConfig& config, const std::string& key,
                                                const std::string& value) {
    if (key == "log_level") {
        config.log_level = value;
    } else if (key == "enable_console_output") {
        config.enable_console_output = (value == "true");
    } else if (key == "enable_file_logging") {
        config.enable_file_logging = (value == "true");
    } else if (key == "log_file_path") {
        config.log_file_path = value;
    }
}

void ESP32ConfigParser::parseDevelopmentConfigValue(ESP32SystemConfig& config,
                                                    const std::string& key,
                                                    const std::string& value) {
    if (key == "enable_debug_output") {
        config.enable_debug_output = (value == "true");
    } else if (key == "print_raw_data") {
        config.print_raw_data = (value == "true");
    } else if (key == "print_observation_matrices") {
        config.print_observation_matrices = (value == "true");
    } else if (key == "simulate_missing_sensors") {
        config.simulate_missing_sensors = (value == "true");
    } else if (key == "simulate_sensor_delay") {
        config.simulate_sensor_delay = (value == "true");
    }
}

void ESP32ConfigParser::parsePTLocationMappingValue(ESP32SystemConfig& config,
                                                    const std::string& key,
                                                    const std::string& value) {
    if (key.substr(0, 8) == "channel_") {
        std::string channel_str = key.substr(8);
        uint8_t channel = static_cast<uint8_t>(std::stoi(channel_str));
        config.pt_location_mapping[channel] = value;
    }
}

std::string ESP32ConfigParser::readFile(const std::string& file_path) {
    std::ifstream file(file_path);
    if (!file.is_open()) {
        setError("Cannot open file: " + file_path);
        return "";
    }

    std::stringstream buffer;
    buffer << file.rdbuf();
    file.close();

    return buffer.str();
}

void ESP32ConfigParser::setError(const std::string& error) {
    last_error_ = error;
}

std::string ESP32ConfigParser::getLastError() const {
    return last_error_;
}

// Factory functions
std::tuple<std::shared_ptr<ESP32SerialHandler>, std::shared_ptr<PTObservationMatrixBuilder>,
           std::shared_ptr<ESP32SystemConfig>>
createESP32SystemFromConfig(const std::string& config_path) {
    ESP32ConfigParser parser;

    std::shared_ptr<ESP32SystemConfig> config;
    if (config_path.empty()) {
        config = parser.loadDefaultConfig();
    } else {
        config = parser.loadConfig(config_path);
    }

    if (!config) {
        std::cerr << "Failed to load configuration: " << parser.getLastError() << std::endl;
        return {nullptr, nullptr, nullptr};
    }

    if (!config->validate()) {
        std::cerr << "Invalid configuration: " << config->getValidationError() << std::endl;
        return {nullptr, nullptr, nullptr};
    }

    auto esp32_handler = parser.createESP32Handler(*config);
    auto pt_builder = parser.createPTObservationMatrixBuilder(*config);

    return {esp32_handler, pt_builder, config};
}

bool createDefaultConfigFile(const std::string& config_path) {
    std::string path =
        config_path.empty() ? ESP32ConfigParser::getDefaultConfigPath() : config_path;

    ESP32SystemConfig default_config;
    ESP32ConfigParser parser;

    return parser.saveConfig(default_config, path);
}
