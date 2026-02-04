#ifndef ESP32_CONFIG_PARSER_HPP
#define ESP32_CONFIG_PARSER_HPP

#include <cstdint>
#include <map>
#include <memory>
#include <string>

#include "ESP32SerialHandler.hpp"
#include "PTObservationMatrix.hpp"

/**
 * @brief ESP32 Configuration structure
 */
struct ESP32SystemConfig {
    // Serial configuration
    std::string device_path;
    int baud_rate;
    uint32_t timeout_ms;
    size_t max_buffer_size;
    bool enable_binary_mode;

    // PT sensor configuration
    size_t max_pt_sensors;
    double max_data_age_ms;
    std::map<uint8_t, std::string> pt_location_mapping;

    // Observation matrix configuration
    bool enable_outlier_detection;
    double outlier_threshold_sigma;
    double time_sync_tolerance_ms;
    bool enable_interpolation;
    double interpolation_window_ms;

    // Logging configuration
    std::string log_level;
    bool enable_console_output;
    bool enable_file_logging;
    std::string log_file_path;

    // Development settings
    bool enable_debug_output;
    bool print_raw_data;
    bool print_observation_matrices;
    bool simulate_missing_sensors;
    bool simulate_sensor_delay;

    /**
     * @brief Default constructor with sensible defaults
     */
    ESP32SystemConfig();

    /**
     * @brief Validate configuration settings
     * @return true if configuration is valid, false otherwise
     */
    bool validate() const;

    /**
     * @brief Get error message for invalid configuration
     * @return Error message string
     */
    std::string getValidationError() const;
};

/**
 * @brief ESP32 Configuration Parser
 *
 * Parses TOML configuration files for ESP32 PT sensor system
 */
class ESP32ConfigParser {
public:
    /**
     * @brief Constructor
     */
    ESP32ConfigParser();

    /**
     * @brief Destructor
     */
    ~ESP32ConfigParser();

    /**
     * @brief Load configuration from TOML file
     * @param config_path Path to configuration file
     * @return Shared pointer to configuration, nullptr on error
     */
    std::shared_ptr<ESP32SystemConfig> loadConfig(const std::string& config_path);

    /**
     * @brief Get last error message
     * @return Last error message
     */
    std::string getLastError() const;

    /**
     * @brief Load configuration from default path
     * @return Shared pointer to configuration, nullptr on error
     */
    std::shared_ptr<ESP32SystemConfig> loadDefaultConfig();

    /**
     * @brief Save configuration to TOML file
     * @param config Configuration to save
     * @param config_path Path to save configuration file
     * @return true if successful, false otherwise
     */
    bool saveConfig(const ESP32SystemConfig& config, const std::string& config_path);

    /**
     * @brief Create ESP32SerialHandler from configuration
     * @param config Configuration to use
     * @return Shared pointer to ESP32 handler, nullptr on error
     */
    std::shared_ptr<ESP32SerialHandler> createESP32Handler(const ESP32SystemConfig& config);

    /**
     * @brief Create PTObservationMatrixBuilder from configuration
     * @param config Configuration to use
     * @return Shared pointer to PT observation matrix builder, nullptr on error
     */
    std::shared_ptr<PTObservationMatrixBuilder> createPTObservationMatrixBuilder(
        const ESP32SystemConfig& config);

    /**
     * @brief Get default configuration file path
     * @return Default configuration file path
     */
    static std::string getDefaultConfigPath();

    /**
     * @brief Check if configuration file exists
     * @param config_path Path to configuration file
     * @return true if file exists, false otherwise
     */
    static bool configFileExists(const std::string& config_path);

private:
    std::string last_error_;

    /**
     * @brief Parse TOML file content
     * @param content TOML file content as string
     * @return Shared pointer to configuration, nullptr on error
     */
    std::shared_ptr<ESP32SystemConfig> parseTOMLContent(const std::string& content);

    /**
     * @brief Parse serial configuration section
     * @param config Configuration object to populate
     * @param content TOML content
     * @return true if successful, false otherwise
     */
    bool parseSerialConfig(ESP32SystemConfig& config, const std::string& content);

    /**
     * @brief Parse PT sensor configuration section
     * @param config Configuration object to populate
     * @param content TOML content
     * @return true if successful, false otherwise
     */
    bool parsePTSensorConfig(ESP32SystemConfig& config, const std::string& content);

    /**
     * @brief Parse observation matrix configuration section
     * @param config Configuration object to populate
     * @param content TOML content
     * @return true if successful, false otherwise
     */
    bool parseObservationMatrixConfig(ESP32SystemConfig& config, const std::string& content);

    /**
     * @brief Parse logging configuration section
     * @param config Configuration object to populate
     * @param content TOML content
     * @return true if successful, false otherwise
     */
    bool parseLoggingConfig(ESP32SystemConfig& config, const std::string& content);

    /**
     * @brief Parse development configuration section
     * @param config Configuration object to populate
     * @param content TOML content
     * @return true if successful, false otherwise
     */
    bool parseDevelopmentConfig(ESP32SystemConfig& config, const std::string& content);

    /**
     * @brief Parse PT location mapping
     * @param config Configuration object to populate
     * @param content TOML content
     * @return true if successful, false otherwise
     */
    bool parsePTLocationMapping(ESP32SystemConfig& config, const std::string& content);

    /**
     * @brief Convert PT location string to enum value
     * @param location_str Location string
     * @return PT location enum value, or UNKNOWN if invalid
     */
    uint8_t stringToPTLocation(const std::string& location_str);

    /**
     * @brief Read file content
     * @param file_path Path to file
     * @return File content as string, empty string on error
     */
    std::string readFile(const std::string& file_path);

    /**
     * @brief Set error message
     * @param error Error message
     */
    void setError(const std::string& error);

    // Helper methods for parsing individual config values
    void parseSerialConfigValue(ESP32SystemConfig& config, const std::string& key,
                                const std::string& value);
    void parsePTSensorConfigValue(ESP32SystemConfig& config, const std::string& key,
                                  const std::string& value);
    void parseObservationMatrixConfigValue(ESP32SystemConfig& config, const std::string& key,
                                           const std::string& value);
    void parseLoggingConfigValue(ESP32SystemConfig& config, const std::string& key,
                                 const std::string& value);
    void parseDevelopmentConfigValue(ESP32SystemConfig& config, const std::string& key,
                                     const std::string& value);
    void parsePTLocationMappingValue(ESP32SystemConfig& config, const std::string& key,
                                     const std::string& value);
};

/**
 * @brief Create ESP32 system from configuration file
 * @param config_path Path to configuration file (optional)
 * @return Tuple of (ESP32Handler, PTObservationMatrixBuilder, Config)
 */
std::tuple<std::shared_ptr<ESP32SerialHandler>, std::shared_ptr<PTObservationMatrixBuilder>,
           std::shared_ptr<ESP32SystemConfig>>
createESP32SystemFromConfig(const std::string& config_path = "");

/**
 * @brief Create default configuration file if it doesn't exist
 * @param config_path Path to configuration file (optional)
 * @return true if successful, false otherwise
 */
bool createDefaultConfigFile(const std::string& config_path = "");

#endif  // ESP32_CONFIG_PARSER_HPP
