#pragma once

#include "DiabloEnums.h"
#include <stdint.h>
#include <vector>

namespace daq {

/**
 * @brief The standard 6-byte header preceding every packet.
 */
struct __attribute__((packed)) PacketHeader {
  PacketType packet_type; // 1 byte
  uint8_t version;        // 1 byte
  uint32_t timestamp;     // 4 bytes
};

//==============================================================================
// Board Heartbeat
//==============================================================================

/**
 * @brief Body of a Board Heartbeat packet. Sent from a board to the server.
 */
struct __attribute__((packed)) BoardHeartbeatPacket {
    uint8_t firmware_hash[32]; // SHA-256 hash of the firmware binary
	  uint8_t board_id;
    EngineState engine_state;
    BoardState board_state;
};

//==============================================================================
// Server Heartbeat
//==============================================================================

/**
 * @brief Body of a Server Heartbeat packet. Sent from the server to all boards.
 */
struct __attribute__((packed)) ServerHeartbeatPacket {
  EngineState engine_state;
};

//==============================================================================
// Sensor Data
//
// Variable length, but having structs separate is so we can read them from
// buffer in parts
//
//==============================================================================

/**
 * @brief Body of a Sensor Data packet. Contains the fixed-size fields.
 * @note The actual packet sent over Ethernet will have this struct followed
 * by a variable number of Chunks and SensorDatapoints.
 */
struct __attribute__((packed)) SensorDataPacket {
  uint8_t num_chunks;
  uint8_t num_sensors;
  // Followed by N Chunks in the data payload
};

/**
 * @brief Chunk of a Sensor Data packet.
 * @note In the actual packet sent over Ethernet, each chunk will be followed by
 * num_sensors defined in the data packet
 */

struct __attribute__((packed)) SensorDataChunk {
  uint32_t timestamp;
};

/**
 * @brief Represents a single sensor reading. Used in the SensorDataPacket.
 */
struct __attribute__((packed)) SensorDatapoint {
  uint8_t sensor_id; // Which sensor on the board this data is from
  uint32_t data;     // The sensor value
};

//-----------------------------------------------------------------------------
// High-Level Data Collection Structures
//-----------------------------------------------------------------------------
// This structure is used for collecting and managing sensor data before
// serializing into network packets. It provides a higher-level interface
// for data collection compared to the packed network structures above.

/**
 * @brief Represents a single data chunk with timestamp and sensor datapoints.
 *
 * This struct represents one data chunk containing a timestamp and a vector with
 * num_sensors datapoints. It's used for collecting sensor data before serializing
 * into network packets.
 *
 * @note This is NOT a packed struct as it's used for data collection,
 *       not network transmission. Use the packed SensorDataChunk for network
 * packets.
 */
struct SensorDataChunkCollection {
  uint32_t timestamp; // Timestamp for this data chunk
  std::vector<SensorDatapoint> datapoints;
  uint8_t num_sensors;

  /**
   * @brief Constructor with timestamp
   * @param ts The timestamp for this data chunk
   * @param num_sensors The number of sensor datapoints for this chunk
   */
  SensorDataChunkCollection(uint32_t ts, uint8_t num_sensors) : timestamp(ts), num_sensors(num_sensors) {}

  /**
   * @brief Add a sensor datapoint to this chunk
   * @param sensor_id The ID of the sensor
   * @param data The sensor reading value
   * @return True if successfully added, false if array is full
   */
  bool add_datapoint(uint8_t sensor_id, uint32_t data) {
    if (datapoints.size() >= num_sensors) {
      return false; // Array is full
    }
    datapoints.push_back({sensor_id, data});
    return true;
  }

  /**
   * @brief Get the number of datapoints in this chunk
   * @return The number of datapoints
   */
  size_t size() const { return datapoints.size(); }

  /**
   * @brief Check if the chunk is empty
   * @return True if no datapoints, false otherwise
   */
  bool empty() const { return datapoints.empty(); }

  /**
   * @brief Check if the chunk is full
   * @return True if at maximum capacity, false otherwise
   */
  bool full() const { return datapoints.size() >= num_sensors; }

  /**
   * @brief Clear all datapoints from this chunk
   */
  void clear() { datapoints.clear(); }
};

//==============================================================================
// Sensor Config
//==============================================================================

/**
 * @brief Fixed-size header of a Sensor Config packet.
 *
 * Full packet layout (after standard PacketHeader):
 * - This struct (1 byte): num_sensors (N)
 * - N x uint8_t sensor_id
 * - uint8_t reference_voltage
 * - uint8_t necessary_for_abort (0 or 1)
 * - If necessary_for_abort: uint32_t controller_ip (4 bytes)
 * - uint8_t enable_serial_printing
 */
struct __attribute__((packed)) SensorConfigPacket {
  uint8_t num_sensors;
};

/**
 * @brief High-level representation of a parsed Sensor Config payload.
 *
 * @note This is NOT a packed struct; it is used for collecting / returning
 *       sensor config fields in a convenient form (similar in spirit to
 *       SensorDataChunkCollection).
 */
struct SensorConfigData {
  std::vector<uint8_t> sensor_ids;
  uint8_t reference_voltage;
  bool necessary_for_abort;
  uint32_t controller_ip;
  uint8_t enable_serial_printing;
};

//==============================================================================
// Actuator Command
//==============================================================================

/**
 * @brief Body of an Actuator Command packet.
 * @note The actual packet will have this struct followed by N ActuatorCommands.
 */
struct __attribute__((packed)) ActuatorCommandPacket {
  uint8_t num_commands;
  // Followed by 'num_commands' instances of ActuatorCommand
};

/**
 * @brief Represents a command for a single actuator.
 */
struct __attribute__((packed)) ActuatorCommand {
  uint8_t actuator_id;
  uint8_t actuator_state;
};

/**
 * @brief Body of a PWM Actuator Command packet.
 * @note The actual packet will have this struct followed by N PWMActuatorCommands.
 */
struct __attribute__((packed)) PWMActuatorCommandPacket {
  uint8_t num_commands;
  // Followed by 'num_commands' instances of PWMActuatorCommand
};

/**
 * @brief Represents a PWM command for a single actuator.
 */
struct __attribute__((packed)) PWMActuatorCommand {
  uint8_t actuator_id;
  uint32_t duration;   // Duration in milliseconds
  float duty_cycle;    // Duty cycle in percentage (0.0 - 1.0)
  float frequency;     // Frequency in Hz
};

//==============================================================================
// Actuator Config (Abort)
//==============================================================================

/**
 * @brief Fixed-size header of an Actuator Config packet for abort configuration.
 *
 * Full packet layout (after standard PacketHeader):
 * - This struct (2 bytes): is_abort_controller, num_abort_actuators (N)
 * - N x AbortActuatorLocation (7 bytes each)
 * - 1 byte: num_abort_pts (X)
 * - X x AbortPTLocation (9 bytes each)
 * - 1 byte: enable_serial_printing
 */
struct __attribute__((packed)) ActuatorConfigPacket {
  uint8_t is_abort_controller;  // 1 if this board is the abort controller, 0 otherwise
  uint8_t num_abort_actuators;   // N = number of abort actuator entries following
};

/**
 * @brief Defines one abort actuator: location (IP), ID, vent state, and abort state.
 * 7 bytes on wire: 4B IP + 1B actuator_id + 1B vent_state + 1B abort_state.
 */
struct __attribute__((packed)) AbortActuatorLocation {
  uint32_t ip_address;   // IP address of the board where this actuator lives
  uint8_t actuator_id;
  uint8_t vent_state;    // 1 = on, 0 = off
  uint8_t abort_state;   // 1 = on, 0 = off
};

/**
 * @brief Single byte count of abort PT entries; appears after N actuator blocks.
 */
struct __attribute__((packed)) AbortPTSectionHeader {
  uint8_t num_abort_pts;  // X = number of AbortPTLocation entries following
};

/**
 * @brief Defines the location of a pressure transducer needed for an abort
 * sequence, and its pressure threshold as an ADC code.
 * 9 bytes on wire: 4B IP + 1B sensor_id + 4B pressure_threshold_adc.
 */
struct __attribute__((packed)) AbortPTLocation {
  uint32_t ip_address;
  uint8_t sensor_id;
  uint32_t pressure_threshold_adc;  // Pressure threshold as ADC code
};

//==============================================================================
// Self Test
//==============================================================================

/**
 * @brief Body of a Self Test packet.
 * @note The actual packet will have this struct followed by N SelfTestResults.
 *
 * On-wire layout (after PacketHeader):
 *   adc_good   (1 byte) – 1 if TDAC self-test passed, 0 if failed
 *   num_sensors (1 byte) – number of SelfTestResult entries that follow
 *   N x SelfTestResult
 */
struct __attribute__((packed)) SelfTestPacket {
  uint8_t adc_good;   // 1 = ADC passed TDAC self-test, 0 = failed
  uint8_t num_sensors;
  // Followed by 'num_sensors' instances of SelfTestResult
};

/**
 * @brief Represents a self test result for a single sensor.
 */
struct __attribute__((packed)) SelfTestResult {
  uint8_t sensor_id;
  uint8_t result; // boolean, 1 = good, 0 = bad
};

//==============================================================================
// Environmental Data
//==============================================================================

/**
 * @brief Body of an Environmental Data packet (after PacketHeader).
 * Temperature in degrees Celsius, absolute pressure in Pa, relative humidity in %RH.
 */
struct __attribute__((packed)) EnvironmentalDataPacket {
  float temperature_c;
  uint32_t pressure_pa;
  float humidity_rh;
};

//==============================================================================
// Stacklight Command
//==============================================================================

/**
 * @brief Body of a stacklight command packet (after PacketHeader).
 * Order: red, yellow, green, buzzer. Each byte is 1 = on, 0 = off.
 */
struct __attribute__((packed)) StacklightCommandPacket {
  uint8_t red;
  uint8_t yellow;
  uint8_t green;
  uint8_t buzzer;
};


//==============================================================================
// Bluetooth switch relay (environmental board)
//==============================================================================

// At most this many switches per environmental board.
constexpr uint8_t MAX_SWITCHES = 5;
// Room for the switch's raw status (17 bytes at STATUS_VERSION 1) to grow.
constexpr uint8_t MAX_SWITCH_STATUS_BYTES = 32;

/** One configured switch. `role` is the server's index (0..MAX_SWITCHES-1);
 *  names stay on the server. `mac` is the switch's BT MAC, most significant
 *  byte first, as it is printed. */
struct __attribute__((packed)) SwitchConfigEntry {
  uint8_t role;
  uint8_t mac[6];
};

/** The whole switch list (not the wire layout: on the wire it is
 *  hash (u32) + count (u8) + count x SwitchConfigEntry). */
struct SwitchConfig {
  uint8_t count = 0;
  SwitchConfigEntry entries[MAX_SWITCHES] = {};
};

enum class SwitchLink : uint8_t {
  DOWN = 0, // not connected (searching, or never seen)
  UP = 1,   // connected
};

/** SWITCH_COMMAND body: set a role's output. Absolute, never a toggle, so a repeated or
 *  duplicated packet cannot flip the switch back. */
struct __attribute__((packed)) SwitchCommandPacket {
  uint16_t command_id; // chosen by the DAQ; echoed in the result
  uint8_t role;
  uint8_t output;      // 1 = arm (output on), 0 = disarm
};

enum class SwitchCommandResult : uint8_t {
  WRITTEN = 0,      // the switch accepted the write (its status says what it did)
  NO_LINK = 1,      // that switch is not connected; nothing was sent, nothing queued
  WRITE_FAILED = 2, // connected, but the write was not acknowledged
  UNKNOWN_ROLE = 3, // no switch is listed under that role
  NO_CONFIG = 4,    // the env board holds no switch list yet
  BAD_COMMAND = 5,  // output other than 0/1, or the relay was busy
};

/** SWITCH_COMMAND_RESULT body. */
struct __attribute__((packed)) SwitchCommandResultPacket {
  uint16_t command_id;
  uint8_t role;
  uint8_t output; // as requested
  SwitchCommandResult result;
};

/** One role's link and its switch's last status, as the env board holds them.
 *  `status` is the switch's StatusPacket bytes untouched (SwitchStatus.h);
 *  `status_len` is 0 until the first one arrives. While the link is down the
 *  last status is still sent, and `age_ms` says how old it is. */
struct SwitchStatusReport {
  uint8_t role = 0;
  SwitchLink link = SwitchLink::DOWN;
  int8_t rssi = 0;                  // dBm, 0 when unknown
  uint16_t age_ms = 0xFFFF;         // since the last status notification, saturating
  uint32_t config_hash = 0;         // of the switch list the env board holds
  uint8_t status_len = 0;
  uint8_t status[MAX_SWITCH_STATUS_BYTES] = {};
};

} // namespace daq
