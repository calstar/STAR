#pragma once

#include "DiabloEnums.h"   // For enums like PacketType
#include "DiabloPackets.h" // For all packet data structures
#include <stdint.h>        // For standard integer types
#include <vector>          // For std::vector

namespace Diablo {

//==============================================================================
// PACKET SERIALIZATION (Struct -> uint8_t* Buffer)
//
// These functions take high-level data structs, serialize them into a
// byte buffer, and return the final number of bytes to be sent.
// A return value of 0 indicates an error.
//==============================================================================

/**
 * @brief Creates a complete Board Heartbeat packet in the provided buffer.
 *
 * This is a fixed-size packet sent periodically by a board to the server to
 * indicate it is online and operational.
 *
 * @param data The heartbeat data to encode (firmware SHA-256 hash, board ID, state, etc.).
 * @param timestamp_ms Value for PacketHeader.timestamp (e.g. Arduino millis() on firmware).
 * @param buffer The output buffer to write the final packet into.
 * @param buffer_size The total size of the output buffer, used for safety
 * checks.
 * @return The number of bytes written to the buffer (always
 * sizeof(PacketHeader) + sizeof(BoardHeartbeatPacket)), or 0 on error.
 */
size_t create_board_heartbeat_packet(const BoardHeartbeatPacket &data,
                                     uint32_t timestamp_ms,
                                     uint8_t *buffer, size_t buffer_size);

/**
 * @brief Creates a complete Sensor Data packet in the provided buffer.
 *
 * This is a variable-size packet containing readings from one or more sensor
 * data chunks. It consists of a header, a fixed-size body specifying the number
 * of chunks and sensors, followed by the actual sensor data chunks and their
 * datapoints.
 *
 * @param chunks A vector of SensorDataChunkCollection structs containing the
 * sensor data.
 * @param num_sensors The number of sensors that are included in the packet
 * @param timestamp_ms Value for PacketHeader.timestamp.
 * @param buffer The output buffer to write the final packet into.
 * @param buffer_size The total size of the output buffer.
 * @return The total number of bytes written to the buffer, or 0 on error.
 */
size_t
create_sensor_data_packet(const std::vector<SensorDataChunkCollection> &chunks, const uint8_t num_sensors,
                          uint32_t timestamp_ms,
                          uint8_t *buffer, size_t buffer_size);

/**
 * @brief Creates a simple Abort Done packet.
 *
 * This packet is sent from a board to the server to acknowledge that it has
 * successfully completed its abort sequence. It has no data payload.
 *
 * @param timestamp_ms Value for PacketHeader.timestamp.
 * @param buffer The output buffer to write the final packet into.
 * @param buffer_size The total size of the output buffer.
 * @return The number of bytes written (always sizeof(PacketHeader)), or 0 on
 * error.
 */
size_t create_abort_done_packet(uint32_t timestamp_ms,
                                uint8_t *buffer, size_t buffer_size);

/**
 * @brief Creates a complete Sensor Config packet in the provided buffer.
 *
 * Packet layout: PacketHeader + num_sensors (1B) + N sensor_ids (1B each) +
 * reference_voltage (1B) + necessary_for_abort (1B) +
 * [controller_ip (4B) if necessary_for_abort] + enable_serial_printing (1B).
 *
 * @param sensor_ids List of sensor IDs to include in the config.
 * @param reference_voltage ADC reference voltage selection.
 * @param necessary_for_abort Whether this board's sensors are needed for abort.
 * @param controller_ip IP of the abort controller (only written when necessary_for_abort is true).
 * @param enable_serial_printing 1 to enable serial printing, 0 to disable.
 * @param timestamp_ms Value for PacketHeader.timestamp.
 * @param buffer The output buffer to write the packet into.
 * @param buffer_size The size of the provided buffer.
 * @return The total size of the created packet, or 0 on error.
 */
size_t create_sensor_config_packet(const std::vector<uint8_t> &sensor_ids,
                                   uint8_t reference_voltage,
                                   bool necessary_for_abort,
                                   uint32_t controller_ip,
                                   uint8_t enable_serial_printing,
                                   uint32_t timestamp_ms,
                                   uint8_t *buffer, size_t buffer_size);

/**
 * @brief Creates a complete Actuator Command packet in the provided buffer.
 *
 * Packet layout: PacketHeader + ActuatorCommandPacket + N ActuatorCommand.
 *
 * @param commands The list of actuator commands to serialize.
 * @param timestamp_ms Value for PacketHeader.timestamp.
 * @param buffer The output buffer to write the packet into.
 * @param buffer_size The size of the provided buffer.
 * @return The total size of the created packet, or 0 on error.
 */
size_t create_actuator_command_packet(const std::vector<ActuatorCommand> &commands,
                                      uint32_t timestamp_ms,
                                      uint8_t *buffer, size_t buffer_size);

/**
 * @brief Creates a complete Self Test packet in the provided buffer.
 *
 * Packet layout: PacketHeader + SelfTestPacket (adc_good + num_sensors) + N SelfTestResult.
 *
 * @param adc_good   1 if the TDAC self-test passed (ADC is good), 0 if it failed.
 * @param results    The list of per-sensor self-test results to serialize.
 * @param timestamp_ms Value for PacketHeader.timestamp.
 * @param buffer     The output buffer to write the packet into.
 * @param buffer_size The size of the provided buffer.
 * @return The total size of the created packet, or 0 on error.
 */
size_t create_self_test_packet(uint8_t adc_good,
                               const std::vector<SelfTestResult> &results,
                               uint32_t timestamp_ms,
                               uint8_t *buffer, size_t buffer_size);

/**
 * @brief Creates a complete Environmental Data packet in the provided buffer.
 *
 * Packet layout: PacketHeader + EnvironmentalDataPacket (temperature float °C,
 * pressure uint32 Pa, humidity float %RH).
 */
size_t create_environmental_data_packet(float temperature_c,
                                        uint32_t pressure_pa,
                                        float humidity_rh,
                                        uint32_t timestamp_ms,
                                        uint8_t *buffer, size_t buffer_size);

/**
 * @brief Creates a complete Stacklight Command packet in the provided buffer.
 *
 * Packet layout: PacketHeader + StacklightCommandPacket (red, yellow, green, buzzer; 1 = on).
 */
size_t create_stacklight_command_packet(const StacklightCommandPacket &data,
                                        uint32_t timestamp_ms,
                                        uint8_t *buffer, size_t buffer_size);

//==============================================================================
// PACKET DESERIALIZATION (uint8_t* Buffer -> Struct)
//==============================================================================

/**
 * @brief Parses a Board Heartbeat packet from buffer.
 * @return true on success, false on error (size/type mismatch).
 */
bool parse_board_heartbeat_packet(const uint8_t *buffer, size_t buffer_size,
                                  PacketHeader &header_out,
                                  BoardHeartbeatPacket &data_out);

/**
 * @brief Parses a Server Heartbeat packet from buffer.
 * @return true on success, false on error (size/type mismatch).
 */
bool parse_server_heartbeat_packet(const uint8_t *buffer, size_t buffer_size,
                                    PacketHeader &header_out,
                                    ServerHeartbeatPacket &data_out);

/**
 * @brief Parses a Sensor Data packet from buffer into chunk collections.
 * @return true on success, false on error.
 */
bool parse_sensor_data_packet(const uint8_t *buffer, size_t buffer_size,
                              PacketHeader &header_out,
                              std::vector<SensorDataChunkCollection> &chunks_out);

/**
 * @brief Parses an Abort Done packet from buffer.
 * @return true on success, false on error.
 */
bool parse_abort_done_packet(const uint8_t *buffer, size_t buffer_size,
                             PacketHeader &header_out);

/**
 * @brief Parses an Actuator Command packet from buffer.
 * @return true on success, false on error.
 */
bool parse_actuator_command_packet(const uint8_t *buffer, size_t buffer_size,
                                   PacketHeader &header_out,
                                   std::vector<ActuatorCommand> &commands_out);

/**
 * @brief Parses a Self Test packet from buffer.
 * @param adc_good_out Set to 1 if the TDAC self-test passed, 0 if it failed.
 * @return true on success, false on error.
 */
bool parse_self_test_packet(const uint8_t *buffer, size_t buffer_size,
                            PacketHeader &header_out,
                            uint8_t &adc_good_out,
                            std::vector<SelfTestResult> &results_out);

/**
 * @brief Parses an Environmental Data packet from buffer.
 * @return true on success, false on error (size/type mismatch).
 */
bool parse_environmental_data_packet(const uint8_t *buffer, size_t buffer_size,
                                       PacketHeader &header_out,
                                       EnvironmentalDataPacket &data_out);

/**
 * @brief Parses a Stacklight Command packet from buffer.
 * @return true on success, false on error (size/type mismatch).
 */
bool parse_stacklight_command_packet(const uint8_t *buffer, size_t buffer_size,
                                     PacketHeader &header_out,
                                     StacklightCommandPacket &data_out);

/**
 * @brief Parses a Sensor Config packet from buffer.
 *
 * Mirrors the on-wire format produced by create_sensor_config_packet.
 * If necessary_for_abort is false the controller_ip_out is set to 0.
 *
 * @return true on success, false on error (type/size mismatch or buffer too small).
 */
bool parse_sensor_config_packet(const uint8_t *buffer, size_t buffer_size,
                                PacketHeader &header_out,
                                std::vector<uint8_t> &sensor_ids_out,
                                uint8_t &reference_voltage_out,
                                bool &necessary_for_abort_out,
                                uint32_t &controller_ip_out,
                                uint8_t &enable_serial_printing_out);

/**
 * @brief Creates a complete PWM Actuator Command packet in the provided buffer.
 *
 * Packet layout: PacketHeader + PWMActuatorCommandPacket + N PWMActuatorCommand.
 *
 * @param commands The list of PWM actuator commands to serialize.
 * @param timestamp_ms Value for PacketHeader.timestamp.
 * @param buffer The output buffer to write the packet into.
 * @param buffer_size The size of the provided buffer.
 * @return The total size of the created packet, or 0 on error.
 */
size_t create_pwm_actuator_packet(const std::vector<PWMActuatorCommand> &commands,
                                  uint32_t timestamp_ms,
                                  uint8_t *buffer, size_t buffer_size);

/**
 * @brief Parses a PWM Actuator Command packet from buffer.
 * @return true on success, false on error.
 */
bool parse_pwm_actuator_packet(const uint8_t *buffer, size_t buffer_size,
                               PacketHeader &header_out,
                               std::vector<PWMActuatorCommand> &commands_out);

/**
 * @brief Creates a complete Actuator Config packet in the provided buffer.
 *
 * Packet layout: standard PacketHeader (ACTUATOR_CONFIG, version, timestamp),
 * then config body: is_abort_controller (1B), N (1B), N x AbortActuatorLocation (7B each),
 * then X (1B), X x AbortPTLocation (9B each), then enable_serial_printing (1B).
 *
 * @param is_abort_controller 1 if this board is the abort controller, 0 otherwise.
 * @param abort_actuators List of abort actuator entries (N entries, 7 bytes each).
 * @param abort_pts List of abort PT entries (X entries, 9 bytes each).
 * @param enable_serial_printing 1 to enable serial printing, 0 to disable.
 * @param timestamp_ms Value for PacketHeader.timestamp.
 * @param buffer The output buffer to write the packet into.
 * @param buffer_size The size of the provided buffer.
 * @return The total size of the created packet, or 0 on error (e.g. buffer too small).
 */
size_t create_actuator_config_packet(
    uint8_t is_abort_controller,
    const std::vector<AbortActuatorLocation> &abort_actuators,
    const std::vector<AbortPTLocation> &abort_pts,
    uint8_t enable_serial_printing,
    uint32_t timestamp_ms,
    uint8_t *buffer, size_t buffer_size);

/**
 * @brief Parses an Actuator Config packet from buffer.
 * Reads standard PacketHeader (must be ACTUATOR_CONFIG), then config body into outputs.
 * @return true on success, false on error (type/size mismatch or buffer too small).
 */
bool parse_actuator_config_packet(const uint8_t *buffer, size_t buffer_size,
                                  PacketHeader &header_out,
                                  uint8_t &is_abort_controller_out,
                                  std::vector<AbortActuatorLocation> &abort_actuators_out,
                                  std::vector<AbortPTLocation> &abort_pts_out,
                                  uint8_t &enable_serial_printing_out);

} // namespace Diablo
