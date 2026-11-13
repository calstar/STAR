#include "DiabloPacketUtils.h"
#include "daq-protocol.h"
#include <cstring> // For memcpy
#include <cstddef> // For size_t

namespace daq {

//==============================================================================
// PACKET SERIALIZATION IMPLEMENTATIONS
//==============================================================================


size_t create_board_heartbeat_packet(const BoardHeartbeatPacket &data,
                                     uint32_t timestamp_ms,
                                     uint8_t *buffer, size_t buffer_size) {
  // Calculate the total packet size
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(BoardHeartbeatPacket);
  const size_t total_size = header_size + body_size;
  
  // Check if buffer is large enough
  if (buffer_size < total_size) {
    return 0; // Error: buffer too small
  }
  
  // Create the packet header
  PacketHeader header;
  header.packet_type = PacketType::BOARD_HEARTBEAT;
  header.version = DIABLO_COMMS_VERSION; // Current protocol version
  header.timestamp = timestamp_ms;
  
  // Copy header to buffer
  memcpy(buffer, &header, header_size);
  
  // Copy body data to buffer
  memcpy(buffer + header_size, &data, body_size);
  
  return total_size;
}

size_t create_sensor_data_packet(const std::vector<SensorDataChunkCollection> &chunks, const uint8_t num_sensors,
                                uint32_t timestamp_ms,
                                uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_header_size = sizeof(SensorDataPacket);

  const size_t num_chunks = chunks.size();

  // Compute total size: header + body + per-chunk (timestamp + datapoints)
  const size_t per_chunk_size = sizeof(SensorDataChunk) + (static_cast<size_t>(num_sensors) * sizeof(SensorDatapoint));
  const size_t total_size = header_size + body_header_size + (num_chunks * per_chunk_size);

  if (buffer_size < total_size) {
    return 0; // Buffer too small
  }

  // Prepare header
  PacketHeader header;
  header.packet_type = PacketType::SENSOR_DATA;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  // Write header
  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;

  // Write body header
  SensorDataPacket body;
  body.num_chunks = num_chunks;
  body.num_sensors = num_sensors;
  memcpy(ptr, &body, body_header_size);
  ptr += body_header_size;

  // Write chunks and datapoints
  for (uint8_t i = 0; i < num_chunks; ++i) {
    // Chunk header (timestamp)
    SensorDataChunk chunk_hdr;
    chunk_hdr.timestamp = chunks[i].timestamp;
    memcpy(ptr, &chunk_hdr, sizeof(SensorDataChunk));
    ptr += sizeof(SensorDataChunk);

    // Datapoints (assume exactly num_sensors datapoints are present)
    const SensorDatapoint *dp = chunks[i].datapoints.data();
    size_t datapoints_total_size = static_cast<size_t>(num_sensors) * sizeof(SensorDatapoint);
    memcpy(ptr, dp, datapoints_total_size);
    ptr += datapoints_total_size;
  }

  return total_size;
}

size_t create_abort_done_packet(uint32_t timestamp_ms,
                                uint8_t *buffer, size_t buffer_size) {
  // Calculate the total packet size (header only, no body)
  const size_t header_size = sizeof(PacketHeader);
  
  // Check if buffer is large enough
  if (buffer_size < header_size) {
    return 0; // Error: buffer too small
  }
  
  // Create the packet header
  PacketHeader header;
  header.packet_type = PacketType::ABORT_DONE;
  header.version = 1; // Current protocol version
  header.timestamp = timestamp_ms;
  
  // Copy header to buffer
  memcpy(buffer, &header, header_size);
  
  return header_size;
}

size_t create_actuator_command_packet(const std::vector<ActuatorCommand> &commands,
                                      uint32_t timestamp_ms,
                                      uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(ActuatorCommandPacket);
  const size_t num_commands = commands.size();

  if (num_commands > 255 || num_commands == 0) {
    return 0; // num_commands must be between 1 and 255
  }

  const size_t commands_bytes = num_commands * sizeof(ActuatorCommand);
  const size_t total_size = header_size + body_size + commands_bytes;

  if (buffer_size < total_size) {
    return 0; // Buffer too small
  }

  // Header
  PacketHeader header;
  header.packet_type = PacketType::ACTUATOR_COMMAND;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;

  // Body
  ActuatorCommandPacket body;
  body.num_commands = static_cast<uint8_t>(num_commands);
  memcpy(ptr, &body, body_size);
  ptr += body_size;

  // Commands array
  if (num_commands) {
    memcpy(ptr, commands.data(), commands_bytes);
  }

  return total_size;
}

size_t create_self_test_packet(uint8_t adc_good,
                               const std::vector<SelfTestResult> &results,
                               uint32_t timestamp_ms,
                               uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(SelfTestPacket);
  const size_t num_sensors = results.size();

  if (num_sensors > 255) {
    return 0; // num_sensors must be <= 255
  }

  const size_t results_bytes = num_sensors * sizeof(SelfTestResult);
  const size_t total_size = header_size + body_size + results_bytes;

  if (buffer_size < total_size) {
    return 0; // Buffer too small
  }

  // Header
  PacketHeader header;
  header.packet_type = PacketType::SELF_TEST;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;

  // Body: adc_good byte first, then num_sensors
  SelfTestPacket body;
  body.adc_good = adc_good;
  body.num_sensors = static_cast<uint8_t>(num_sensors);
  memcpy(ptr, &body, body_size);
  ptr += body_size;

  // Results array
  if (num_sensors) {
    memcpy(ptr, results.data(), results_bytes);
  }

  return total_size;
}

size_t create_environmental_data_packet(float temperature_c,
                                        uint32_t pressure_pa,
                                        float humidity_rh,
                                        uint32_t timestamp_ms,
                                        uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(EnvironmentalDataPacket);
  const size_t total_size = header_size + body_size;

  if (!buffer || buffer_size < total_size) {
    return 0;
  }

  PacketHeader header;
  header.packet_type = PacketType::ENVIRONMENTAL_DATA;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  EnvironmentalDataPacket body;
  body.temperature_c = temperature_c;
  body.pressure_pa = pressure_pa;
  body.humidity_rh = humidity_rh;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;
  memcpy(ptr, &body, body_size);
  return total_size;
}

size_t create_stacklight_command_packet(const StacklightCommandPacket &data,
                                        uint32_t timestamp_ms,
                                        uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(StacklightCommandPacket);
  const size_t total_size = header_size + body_size;

  if (!buffer || buffer_size < total_size) {
    return 0;
  }

  PacketHeader header;
  header.packet_type = PacketType::STACKLIGHT_COMMAND;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;
  memcpy(ptr, &data, body_size);
  return total_size;
}

bool parse_board_heartbeat_packet(const uint8_t *buffer, size_t buffer_size,
                                  PacketHeader &header_out,
                                  BoardHeartbeatPacket &data_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(BoardHeartbeatPacket);
  const size_t total_size = header_size + body_size;
  if (!buffer || buffer_size < total_size) return false;

  // Read header
  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::BOARD_HEARTBEAT) return false;

  // Read body
  memcpy(&data_out, buffer + header_size, body_size);
  header_out = hdr;
  return true;
}

bool parse_server_heartbeat_packet(const uint8_t *buffer, size_t buffer_size,
                                    PacketHeader &header_out,
                                    ServerHeartbeatPacket &data_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(ServerHeartbeatPacket);
  const size_t total_size = header_size + body_size;
  if (!buffer || buffer_size < total_size) return false;

  // Read header
  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::SERVER_HEARTBEAT) return false;

  // Read body
  memcpy(&data_out, buffer + header_size, body_size);
  header_out = hdr;
  return true;
}

bool parse_environmental_data_packet(const uint8_t *buffer, size_t buffer_size,
                                     PacketHeader &header_out,
                                     EnvironmentalDataPacket &data_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(EnvironmentalDataPacket);
  const size_t total_size = header_size + body_size;
  if (!buffer || buffer_size < total_size) return false;

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::ENVIRONMENTAL_DATA) return false;

  memcpy(&data_out, buffer + header_size, body_size);
  header_out = hdr;
  return true;
}

bool parse_stacklight_command_packet(const uint8_t *buffer, size_t buffer_size,
                                     PacketHeader &header_out,
                                     StacklightCommandPacket &data_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(StacklightCommandPacket);
  const size_t total_size = header_size + body_size;
  if (!buffer || buffer_size < total_size) return false;

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::STACKLIGHT_COMMAND) return false;

  memcpy(&data_out, buffer + header_size, body_size);
  header_out = hdr;
  return true;
}

bool parse_sensor_data_packet(const uint8_t *buffer, size_t buffer_size,
                              PacketHeader &header_out,
                              std::vector<SensorDataChunkCollection> &chunks_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_hdr_size = sizeof(SensorDataPacket);

  if (!buffer || buffer_size < header_size + body_hdr_size) return false;

  // Header
  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::SENSOR_DATA) return false;

  const uint8_t *ptr = buffer + header_size;
  // Body header
  SensorDataPacket body;
  memcpy(&body, ptr, body_hdr_size);
  ptr += body_hdr_size;

  const size_t per_chunk_size = sizeof(SensorDataChunk) + (static_cast<size_t>(body.num_sensors) * sizeof(SensorDatapoint));
  const size_t expected_size = header_size + body_hdr_size + (static_cast<size_t>(body.num_chunks) * per_chunk_size);
  if (buffer_size < expected_size) return false;

  chunks_out.clear();
  chunks_out.reserve(body.num_chunks);

  for (uint8_t c = 0; c < body.num_chunks; ++c) {
    // Chunk header
    SensorDataChunk chunk_hdr;
    memcpy(&chunk_hdr, ptr, sizeof(SensorDataChunk));
    ptr += sizeof(SensorDataChunk);

    // Datapoints
    SensorDataChunkCollection col(chunk_hdr.timestamp, body.num_sensors);
    if (body.num_sensors) {
      col.datapoints.resize(body.num_sensors);
      memcpy(col.datapoints.data(), ptr, static_cast<size_t>(body.num_sensors) * sizeof(SensorDatapoint));
      ptr += static_cast<size_t>(body.num_sensors) * sizeof(SensorDatapoint);
    }
    chunks_out.push_back(std::move(col));
  }

  header_out = hdr;
  return true;
}

bool parse_abort_done_packet(const uint8_t *buffer, size_t buffer_size,
                             PacketHeader &header_out) {
  const size_t header_size = sizeof(PacketHeader);
  if (!buffer || buffer_size < header_size) return false;

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::ABORT_DONE) return false;
  header_out = hdr;
  return true;
}

bool parse_actuator_command_packet(const uint8_t *buffer, size_t buffer_size,
                                   PacketHeader &header_out,
                                   std::vector<ActuatorCommand> &commands_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(ActuatorCommandPacket);
  if (!buffer || buffer_size < header_size + body_size) return false;

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::ACTUATOR_COMMAND) return false;

  const uint8_t *ptr = buffer + header_size;
  ActuatorCommandPacket body;
  memcpy(&body, ptr, body_size);
  ptr += body_size;

  const size_t commands_bytes = static_cast<size_t>(body.num_commands) * sizeof(ActuatorCommand);
  const size_t expected_size = header_size + body_size + commands_bytes;
  if (buffer_size < expected_size) return false;

  commands_out.clear();
  if (body.num_commands) {
    commands_out.resize(body.num_commands);
    memcpy(commands_out.data(), ptr, commands_bytes);
  }

  header_out = hdr;
  return true;
}

bool parse_self_test_packet(const uint8_t *buffer, size_t buffer_size,
                            PacketHeader &header_out,
                            uint8_t &adc_good_out,
                            std::vector<SelfTestResult> &results_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(SelfTestPacket);
  if (!buffer || buffer_size < header_size + body_size) return false;

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::SELF_TEST) return false;

  const uint8_t *ptr = buffer + header_size;
  SelfTestPacket body;
  memcpy(&body, ptr, body_size);
  ptr += body_size;

  const size_t results_bytes = static_cast<size_t>(body.num_sensors) * sizeof(SelfTestResult);
  const size_t expected_size = header_size + body_size + results_bytes;
  if (buffer_size < expected_size) return false;

  adc_good_out = body.adc_good;

  results_out.clear();
  if (body.num_sensors) {
    results_out.resize(body.num_sensors);
    memcpy(results_out.data(), ptr, results_bytes);
  }

  header_out = hdr;
  return true;
}

size_t create_pwm_actuator_packet(const std::vector<PWMActuatorCommand> &commands,
                                  uint32_t timestamp_ms,
                                  uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(PWMActuatorCommandPacket);
  const size_t num_commands = commands.size();

  if (num_commands > 255 || num_commands == 0) {
    return 0; // num_commands must be between 1 and 255
  }

  const size_t commands_bytes = num_commands * sizeof(PWMActuatorCommand);
  const size_t total_size = header_size + body_size + commands_bytes;

  if (buffer_size < total_size) {
    return 0; // Buffer too small
  }

  // Header
  PacketHeader header;
  header.packet_type = PacketType::PWM_ACTUATOR_COMMAND;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;

  // Body
  PWMActuatorCommandPacket body;
  body.num_commands = static_cast<uint8_t>(num_commands);
  memcpy(ptr, &body, body_size);
  ptr += body_size;

  // Commands array
  if (num_commands) {
    memcpy(ptr, commands.data(), commands_bytes);
  }

  return total_size;
}

bool parse_pwm_actuator_packet(const uint8_t *buffer, size_t buffer_size,
                               PacketHeader &header_out,
                               std::vector<PWMActuatorCommand> &commands_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t body_size = sizeof(PWMActuatorCommandPacket);
  if (!buffer || buffer_size < header_size + body_size) return false;

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::PWM_ACTUATOR_COMMAND) return false;

  const uint8_t *ptr = buffer + header_size;
  PWMActuatorCommandPacket body;
  memcpy(&body, ptr, body_size);
  ptr += body_size;

  const size_t commands_bytes = static_cast<size_t>(body.num_commands) * sizeof(PWMActuatorCommand);
  const size_t expected_size = header_size + body_size + commands_bytes;
  if (buffer_size < expected_size) return false;

  commands_out.clear();
  if (body.num_commands) {
    commands_out.resize(body.num_commands);
    memcpy(commands_out.data(), ptr, commands_bytes);
  }

  header_out = hdr;
  return true;
}

size_t create_sensor_config_packet(const std::vector<uint8_t> &sensor_ids,
                                   uint8_t reference_voltage,
                                   bool necessary_for_abort,
                                   uint32_t controller_ip,
                                   uint8_t enable_serial_printing,
                                   uint32_t timestamp_ms,
                                   uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t num_sensors = sensor_ids.size();

  if (num_sensors > 255) {
    return 0;
  }

  const size_t body_size = 1u                              // num_sensors
                         + num_sensors                     // sensor_ids
                         + 1u                              // reference_voltage
                         + 1u                              // necessary_for_abort
                         + (necessary_for_abort ? 4u : 0u) // controller_ip (conditional)
                         + 1u;                             // enable_serial_printing
  const size_t total_size = header_size + body_size;

  if (buffer_size < total_size) {
    return 0;
  }

  PacketHeader header;
  header.packet_type = PacketType::SENSOR_CONFIG;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;

  *ptr = static_cast<uint8_t>(num_sensors);
  ptr += 1;

  if (num_sensors) {
    memcpy(ptr, sensor_ids.data(), num_sensors);
    ptr += num_sensors;
  }

  *ptr = reference_voltage;
  ptr += 1;

  *ptr = necessary_for_abort ? 1u : 0u;
  ptr += 1;

  if (necessary_for_abort) {
    memcpy(ptr, &controller_ip, sizeof(uint32_t));
    ptr += sizeof(uint32_t);
  }

  *ptr = enable_serial_printing;

  return total_size;
}

bool parse_sensor_config_packet(const uint8_t *buffer, size_t buffer_size,
                                PacketHeader &header_out,
                                std::vector<uint8_t> &sensor_ids_out,
                                uint8_t &reference_voltage_out,
                                bool &necessary_for_abort_out,
                                uint32_t &controller_ip_out,
                                uint8_t &enable_serial_printing_out) {
  const size_t header_size = sizeof(PacketHeader);
  // Minimum body: num_sensors(1) + ref_voltage(1) + necessary_for_abort(1) + enable_serial(1)
  const size_t min_body = 4u;

  if (!buffer || buffer_size < header_size + min_body) {
    return false;
  }

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::SENSOR_CONFIG) {
    return false;
  }

  const uint8_t *ptr = buffer + header_size;

  const uint8_t num_sensors = *ptr;
  ptr += 1;

  // Verify remaining bytes can hold sensor_ids + fixed tail
  // fixed tail = ref_voltage(1) + necessary_for_abort(1) + enable_serial(1) = 3
  const size_t min_remaining = static_cast<size_t>(num_sensors) + 3u;
  if (buffer_size < header_size + 1u + min_remaining) {
    return false;
  }

  sensor_ids_out.clear();
  if (num_sensors) {
    sensor_ids_out.resize(num_sensors);
    memcpy(sensor_ids_out.data(), ptr, num_sensors);
    ptr += num_sensors;
  }

  reference_voltage_out = *ptr;
  ptr += 1;

  const uint8_t abort_flag = *ptr;
  ptr += 1;
  necessary_for_abort_out = (abort_flag != 0);

  if (necessary_for_abort_out) {
    // Need 4 more bytes for controller_ip + 1 for enable_serial_printing
    const size_t consumed = static_cast<size_t>(ptr - buffer);
    if (buffer_size < consumed + sizeof(uint32_t) + 1u) {
      return false;
    }
    memcpy(&controller_ip_out, ptr, sizeof(uint32_t));
    ptr += sizeof(uint32_t);
  } else {
    controller_ip_out = 0;
  }

  // Final byte: enable_serial_printing
  const size_t consumed = static_cast<size_t>(ptr - buffer);
  if (buffer_size < consumed + 1u) {
    return false;
  }
  enable_serial_printing_out = *ptr;

  header_out = hdr;
  return true;
}

size_t create_actuator_config_packet(
    uint8_t is_abort_controller,
    const std::vector<AbortActuatorLocation> &abort_actuators,
    const std::vector<AbortPTLocation> &abort_pts,
    uint8_t enable_serial_printing,
    uint32_t timestamp_ms,
    uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t config_header_size = sizeof(ActuatorConfigPacket);
  const size_t N = abort_actuators.size();
  const size_t X = abort_pts.size();

  if (N > MAX_ABORT_ACTUATORS || X > MAX_ABORT_PTS) {
    return 0;
  }

  const size_t actuator_bytes = N * sizeof(AbortActuatorLocation);
  const size_t pt_count_size = sizeof(AbortPTSectionHeader);
  const size_t pt_entries_bytes = X * sizeof(AbortPTLocation);
  const size_t trailer_size = 1u;  // enable_serial_printing
  const size_t body_size = config_header_size + actuator_bytes + pt_count_size + pt_entries_bytes + trailer_size;
  const size_t total_size = header_size + body_size;

  if (buffer_size < total_size) {
    return 0;
  }

  PacketHeader header;
  header.packet_type = PacketType::ACTUATOR_CONFIG;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;

  ActuatorConfigPacket config;
  config.is_abort_controller = is_abort_controller;
  config.num_abort_actuators = static_cast<uint8_t>(N);
  memcpy(ptr, &config, config_header_size);
  ptr += config_header_size;

  if (N) {
    memcpy(ptr, abort_actuators.data(), actuator_bytes);
    ptr += actuator_bytes;
  }

  AbortPTSectionHeader pt_header;
  pt_header.num_abort_pts = static_cast<uint8_t>(X);
  memcpy(ptr, &pt_header, pt_count_size);
  ptr += pt_count_size;

  if (X) {
    memcpy(ptr, abort_pts.data(), pt_entries_bytes);
    ptr += pt_entries_bytes;
  }

  *ptr = enable_serial_printing;

  return total_size;
}

bool parse_actuator_config_packet(const uint8_t *buffer, size_t buffer_size,
                                  PacketHeader &header_out,
                                  uint8_t &is_abort_controller_out,
                                  std::vector<AbortActuatorLocation> &abort_actuators_out,
                                  std::vector<AbortPTLocation> &abort_pts_out,
                                  uint8_t &enable_serial_printing_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t config_header_size = sizeof(ActuatorConfigPacket);
  const size_t pt_count_size = sizeof(AbortPTSectionHeader);
  const size_t trailer_size = 1u;  // enable_serial_printing

  if (!buffer || buffer_size < header_size + config_header_size + pt_count_size + trailer_size) {
    return false;
  }

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::ACTUATOR_CONFIG) {
    return false;
  }

  const uint8_t *ptr = buffer + header_size;
  ActuatorConfigPacket config;
  memcpy(&config, ptr, config_header_size);
  ptr += config_header_size;

  const size_t N = config.num_abort_actuators;
  const size_t actuator_bytes = N * sizeof(AbortActuatorLocation);
  const size_t min_size_after_config = actuator_bytes + pt_count_size + trailer_size;
  if (buffer_size < header_size + config_header_size + min_size_after_config) {
    return false;
  }

  abort_actuators_out.clear();
  if (N > MAX_ABORT_ACTUATORS) {
    return false;
  }
  if (N) {
    abort_actuators_out.resize(N);
    memcpy(abort_actuators_out.data(), ptr, actuator_bytes);
    ptr += actuator_bytes;
  }

  AbortPTSectionHeader pt_header;
  memcpy(&pt_header, ptr, pt_count_size);
  ptr += pt_count_size;

  const size_t X = pt_header.num_abort_pts;
  const size_t pt_entries_bytes = X * sizeof(AbortPTLocation);
  const size_t expected_total = header_size + config_header_size + actuator_bytes + pt_count_size + pt_entries_bytes + trailer_size;
  if (buffer_size < expected_total) {
    return false;
  }
  if (X > MAX_ABORT_PTS) {
    return false;
  }

  abort_pts_out.clear();
  if (X) {
    abort_pts_out.resize(X);
    memcpy(abort_pts_out.data(), ptr, pt_entries_bytes);
    ptr += pt_entries_bytes;
  }

  enable_serial_printing_out = *ptr;
  is_abort_controller_out = config.is_abort_controller;
  header_out = hdr;
  return true;
}

size_t create_log_packet(uint8_t flags, const uint8_t *text, uint16_t text_len,
                         uint32_t timestamp_ms,
                         uint8_t *buffer, size_t buffer_size) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t total_size = header_size + 1 /*flags*/ + 2 /*text_len*/ + text_len;
  if (buffer_size < total_size) {
    return 0; // Buffer too small
  }

  PacketHeader header;
  header.packet_type = PacketType::LOGS;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;

  uint8_t *ptr = buffer;
  memcpy(ptr, &header, header_size);
  ptr += header_size;

  *ptr++ = flags;
  memcpy(ptr, &text_len, sizeof(text_len)); // uint16 LE (host is little-endian)
  ptr += sizeof(text_len);
  if (text_len && text) {
    memcpy(ptr, text, text_len);
  }
  return total_size;
}

bool parse_log_packet(const uint8_t *buffer, size_t buffer_size,
                      PacketHeader &header_out,
                      uint8_t &flags_out,
                      const uint8_t *&text_out,
                      uint16_t &text_len_out) {
  const size_t header_size = sizeof(PacketHeader);
  const size_t fixed_body = 1u /*flags*/ + 2u /*text_len*/;
  if (!buffer || buffer_size < header_size + fixed_body) return false;

  PacketHeader hdr;
  memcpy(&hdr, buffer, header_size);
  if (hdr.packet_type != PacketType::LOGS) return false;

  const uint8_t *ptr = buffer + header_size;
  const uint8_t flags = *ptr++;

  uint16_t text_len;
  memcpy(&text_len, ptr, sizeof(text_len)); // uint16 LE (host is little-endian)
  ptr += sizeof(text_len);

  if (buffer_size < header_size + fixed_body + text_len) return false;

  header_out = hdr;
  flags_out = flags;
  text_len_out = text_len;
  text_out = ptr;
  return true;
}


//==============================================================================
// Bluetooth switch relay
//==============================================================================

namespace {
void put_header(uint8_t *buf, PacketType type, uint32_t timestamp_ms) {
  PacketHeader header;
  header.packet_type = type;
  header.version = DIABLO_COMMS_VERSION;
  header.timestamp = timestamp_ms;
  memcpy(buf, &header, sizeof(PacketHeader));
}

bool get_header(const uint8_t *buf, size_t size, PacketType type, PacketHeader &out) {
  if (!buf || size < sizeof(PacketHeader)) return false;
  memcpy(&out, buf, sizeof(PacketHeader));
  return out.packet_type == type;
}
} // namespace

uint32_t switch_config_hash(const SwitchConfig &config) {
  uint32_t h = 2166136261u;
  auto mix = [&h](uint8_t b) {
    h ^= b;
    h *= 16777619u;
  };
  mix(config.count);
  for (uint8_t i = 0; i < config.count && i < MAX_SWITCHES; ++i) {
    mix(config.entries[i].role);
    for (uint8_t b : config.entries[i].mac) mix(b);
  }
  return h;
}

size_t create_switch_config_packet(const SwitchConfig &config, uint32_t timestamp_ms,
                                   uint8_t *buffer, size_t buffer_size) {
  if (config.count > MAX_SWITCHES) return 0;
  const size_t total = sizeof(PacketHeader) + 4 + 1 + config.count * sizeof(SwitchConfigEntry);
  if (!buffer || buffer_size < total) return 0;
  put_header(buffer, PacketType::SWITCH_CONFIG, timestamp_ms);
  uint8_t *p = buffer + sizeof(PacketHeader);
  const uint32_t hash = switch_config_hash(config);
  memcpy(p, &hash, 4);
  p += 4;
  *p++ = config.count;
  memcpy(p, config.entries, config.count * sizeof(SwitchConfigEntry));
  return total;
}

bool parse_switch_config_packet(const uint8_t *buffer, size_t buffer_size,
                                PacketHeader &header_out, SwitchConfig &config_out,
                                uint32_t &hash_out) {
  PacketHeader hdr;
  if (!get_header(buffer, buffer_size, PacketType::SWITCH_CONFIG, hdr)) return false;
  const size_t fixed = sizeof(PacketHeader) + 4 + 1;
  if (buffer_size < fixed) return false;
  const uint8_t *p = buffer + sizeof(PacketHeader);
  uint32_t hash;
  memcpy(&hash, p, 4);
  const uint8_t count = p[4];
  if (count > MAX_SWITCHES) return false;
  if (buffer_size < fixed + count * sizeof(SwitchConfigEntry)) return false;
  SwitchConfig cfg;
  cfg.count = count;
  memcpy(cfg.entries, p + 5, count * sizeof(SwitchConfigEntry));
  for (uint8_t i = 0; i < count; ++i)
    if (cfg.entries[i].role >= MAX_SWITCHES) return false;
  if (switch_config_hash(cfg) != hash) return false;
  header_out = hdr;
  config_out = cfg;
  hash_out = hash;
  return true;
}

size_t create_switch_status_packet(const SwitchStatusReport &r, uint32_t timestamp_ms,
                                   uint8_t *buffer, size_t buffer_size) {
  if (r.status_len > MAX_SWITCH_STATUS_BYTES) return 0;
  const size_t total = sizeof(PacketHeader) + 10 + r.status_len;
  if (!buffer || buffer_size < total) return 0;
  put_header(buffer, PacketType::SWITCH_STATUS, timestamp_ms);
  uint8_t *p = buffer + sizeof(PacketHeader);
  *p++ = r.role;
  *p++ = static_cast<uint8_t>(r.link);
  *p++ = static_cast<uint8_t>(r.rssi);
  memcpy(p, &r.age_ms, 2);
  p += 2;
  memcpy(p, &r.config_hash, 4);
  p += 4;
  *p++ = r.status_len;
  memcpy(p, r.status, r.status_len);
  return total;
}

bool parse_switch_status_packet(const uint8_t *buffer, size_t buffer_size,
                                PacketHeader &header_out, SwitchStatusReport &out) {
  PacketHeader hdr;
  if (!get_header(buffer, buffer_size, PacketType::SWITCH_STATUS, hdr)) return false;
  const size_t fixed = sizeof(PacketHeader) + 10;
  if (buffer_size < fixed) return false;
  const uint8_t *p = buffer + sizeof(PacketHeader);
  SwitchStatusReport r;
  r.role = p[0];
  if (p[1] > static_cast<uint8_t>(SwitchLink::UP)) return false;
  r.link = static_cast<SwitchLink>(p[1]);
  r.rssi = static_cast<int8_t>(p[2]);
  memcpy(&r.age_ms, p + 3, 2);
  memcpy(&r.config_hash, p + 5, 4);
  r.status_len = p[9];
  if (r.role >= MAX_SWITCHES || r.status_len > MAX_SWITCH_STATUS_BYTES) return false;
  if (buffer_size < fixed + r.status_len) return false;
  memcpy(r.status, p + 10, r.status_len);
  header_out = hdr;
  out = r;
  return true;
}


size_t create_switch_command_packet(const SwitchCommandPacket &cmd, uint32_t timestamp_ms,
                                    uint8_t *buffer, size_t buffer_size) {
  const size_t total = sizeof(PacketHeader) + sizeof(SwitchCommandPacket);
  if (!buffer || buffer_size < total) return 0;
  put_header(buffer, PacketType::SWITCH_COMMAND, timestamp_ms);
  memcpy(buffer + sizeof(PacketHeader), &cmd, sizeof cmd);
  return total;
}

bool parse_switch_command_packet(const uint8_t *buffer, size_t buffer_size,
                                 PacketHeader &header_out, SwitchCommandPacket &cmd_out) {
  PacketHeader hdr;
  if (!get_header(buffer, buffer_size, PacketType::SWITCH_COMMAND, hdr)) return false;
  if (buffer_size != sizeof(PacketHeader) + sizeof(SwitchCommandPacket)) return false;
  SwitchCommandPacket cmd;
  memcpy(&cmd, buffer + sizeof(PacketHeader), sizeof cmd);
  if (cmd.role >= MAX_SWITCHES || cmd.output > 1) return false;
  header_out = hdr;
  cmd_out = cmd;
  return true;
}

size_t create_switch_command_result_packet(const SwitchCommandResultPacket &res,
                                           uint32_t timestamp_ms, uint8_t *buffer,
                                           size_t buffer_size) {
  const size_t total = sizeof(PacketHeader) + sizeof(SwitchCommandResultPacket);
  if (!buffer || buffer_size < total) return 0;
  put_header(buffer, PacketType::SWITCH_COMMAND_RESULT, timestamp_ms);
  memcpy(buffer + sizeof(PacketHeader), &res, sizeof res);
  return total;
}

bool parse_switch_command_result_packet(const uint8_t *buffer, size_t buffer_size,
                                        PacketHeader &header_out,
                                        SwitchCommandResultPacket &res_out) {
  PacketHeader hdr;
  if (!get_header(buffer, buffer_size, PacketType::SWITCH_COMMAND_RESULT, hdr)) return false;
  if (buffer_size != sizeof(PacketHeader) + sizeof(SwitchCommandResultPacket)) return false;
  SwitchCommandResultPacket res;
  memcpy(&res, buffer + sizeof(PacketHeader), sizeof res);
  if (static_cast<uint8_t>(res.result) > static_cast<uint8_t>(SwitchCommandResult::BAD_COMMAND))
    return false;
  header_out = hdr;
  res_out = res;
  return true;
}

} // namespace daq
