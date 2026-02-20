/**
 * Elodin DB Publisher
 * Encodes sensor data into Elodin DB TABLE packet format and publishes to Elodin DB
 * This allows the backend to act as a publisher (like DAQ Bridge) while also receiving UDP packets
 */

/**
 * Encode RawPTMessage for Elodin DB
 * Format: uint64_t timestamp_ns (8) + uint8_t channel_id (1) + padding[3] (3) + uint32_t raw_adc_counts (4) + uint32_t sample_timestamp_ms (4) + uint8_t status_flags (1) = 21 bytes
 */
export function encodeRawPTMessage(
  timestampNs: bigint,
  channelId: number,
  rawAdcCounts: number,
  sampleTimestampMs: number,
  statusFlags: number = 0
): Buffer {
  const buffer = Buffer.alloc(21);

  // uint64_t timestamp_ns (little-endian)
  buffer.writeBigUInt64LE(timestampNs, 0);

  // uint8_t channel_id
  buffer.writeUInt8(channelId, 8);

  // padding[3] (bytes 9-11) - already zero-filled

  // uint32_t raw_adc_counts (little-endian)
  buffer.writeUInt32LE(rawAdcCounts, 12);

  // uint32_t sample_timestamp_ms (little-endian)
  buffer.writeUInt32LE(sampleTimestampMs, 16);

  // uint8_t status_flags
  buffer.writeUInt8(statusFlags, 20);

  return buffer;
}

/**
 * Encode CalibratedPTMessage for Elodin DB
 * Format: uint64_t timestamp_ns (8) + uint8_t channel_id (1) + padding[3] (3) + float pressure_psi (4) + uint32_t raw_adc (4) + uint8_t cal_status (1) = 21 bytes
 */
export function encodeCalibratedPTMessage(
  timestampNs: bigint,
  channelId: number,
  pressurePsi: number,
  rawAdc: number,
  calStatus: number = 0
): Buffer {
  const buffer = Buffer.alloc(21);

  // uint64_t timestamp_ns (little-endian)
  buffer.writeBigUInt64LE(timestampNs, 0);

  // uint8_t channel_id
  buffer.writeUInt8(channelId, 8);

  // padding[3] (bytes 9-11) - already zero-filled

  // float pressure_psi (little-endian)
  buffer.writeFloatLE(pressurePsi, 12);

  // uint32_t raw_adc (little-endian)
  buffer.writeUInt32LE(rawAdc, 16);

  // uint8_t cal_status
  buffer.writeUInt8(calStatus, 20);

  return buffer;
}

/**
 * Encode Raw Actuator Message (same format as RawPTMessage)
 */
export function encodeRawActuatorMessage(
  timestampNs: bigint,
  channelId: number,
  rawAdcCounts: number,
  sampleTimestampMs: number,
  statusFlags: number = 0
): Buffer {
  return encodeRawPTMessage(timestampNs, channelId, rawAdcCounts, sampleTimestampMs, statusFlags);
}



