/**
 * Elodin Protocol Parser
 * Parses binary Elodin messages into structured data
 */

export interface ParsedSensorData {
  entity: string;
  component: string;
  value: number;
  timestamp: number;
}

/**
 * Parse RawPTMessage (21 bytes)
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + uint32_t (4) + uint32_t (4) + uint8_t (1)
 */
export function parseRawPTMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 21) {
    console.warn(`⚠️ Raw PT payload too short: ${payload.length} bytes (expected 21)`);
    return null;
  }

  const timestampNs = Number(payload.readBigUInt64LE(0));
  const channelId = payload.readUInt8(8);

  // Validate channel ID
  if (channelId < 1 || channelId > 10) {
    console.warn(`⚠️ Invalid channel ID in raw PT: ${channelId}`);
  }
  // Skip padding (bytes 9-11)
  const rawAdcCounts = payload.readUInt32LE(12);
  const sampleTimestampMs = payload.readUInt32LE(16);
  const statusFlags = payload.readUInt8(20);

  // Channel ID from packet is 1-based, map to entity names (matches DatabaseConfig.cpp)
  // Note: Channels 8-10 may be mapped to different names based on sensor_roles config
  const entityMap: Record<number, string> = {
    1: 'PT.Fuel_Upstream',
    2: 'PT.GSE_Low',
    3: 'PT.Fuel_Downstream',
    4: 'PT.Fuel_Fill_Tank',
    5: 'PT.Ox_Upstream',
    6: 'PT.GN2_Regulated',
    7: 'PT.Ox_Downstream',
    8: 'PT.PT_CH8',  // May be mapped to Fuel_Transfer_Tank, GSE_High, or GN2_High
    9: 'PT.PT_CH9',  // May be mapped to Lox_Fill_Pressure or other
    10: 'PT.PT_CH10', // May be mapped to other sensors
  };

  const entity = entityMap[channelId] || `PT.Channel_${channelId}`;

  return {
    entity,
    component: 'raw_adc_counts',
    value: rawAdcCounts,
    timestamp: sampleTimestampMs,
  };
}

/**
 * Parse CalibratedPTMessage (21 bytes)
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + float (4) + uint32_t (4) + uint8_t (1)
 */
export function parseCalibratedPTMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 21) {
    console.warn(`⚠️ Calibrated PT payload too short: ${payload.length} bytes (expected 21)`);
    return null;
  }

  const timestampNs = Number(payload.readBigUInt64LE(0));
  const channelId = payload.readUInt8(8);

  // Validate channel ID
  if (channelId < 1 || channelId > 10) {
    console.warn(`⚠️ Invalid channel ID in calibrated PT: ${channelId}`);
    return null;
  }
  // Skip padding (bytes 9-11)
  const calibratedPressurePsi = payload.readFloatLE(12);
  const rawAdcCounts = payload.readUInt32LE(16);
  const calibrationStatus = payload.readUInt8(20);

  // Channel ID from packet is 1-based, map to entity names (matches DatabaseConfig.cpp)
  // The actual entity names registered in Elodin DB are PT_CH8, PT_CH9, PT_CH10 for channels 8-10
  // But the GUI may expect alternative names. We'll emit both the base name and create aliases
  const baseEntityMap: Record<number, string> = {
    1: 'PT_Cal.Fuel_Upstream',
    2: 'PT_Cal.GSE_Low',
    3: 'PT_Cal.Fuel_Downstream',
    4: 'PT_Cal.Fuel_Fill_Tank',
    5: 'PT_Cal.Ox_Upstream',
    6: 'PT_Cal.GN2_Regulated',
    7: 'PT_Cal.Ox_Downstream',
    8: 'PT_Cal.PT_CH8',  // Registered name in DB
    9: 'PT_Cal.PT_CH9',  // Registered name in DB
    10: 'PT_Cal.PT_CH10', // Registered name in DB
  };

  const entity = baseEntityMap[channelId] || `PT_Cal.Channel_${channelId}`;

  return {
    entity,
    component: 'pressure_psi',
    value: calibratedPressurePsi,
    timestamp: Date.now(), // Use current time since we don't have ms timestamp in this message
  };
}

/**
 * Parse Actuator Message
 * This is a simplified parser - actual format may vary
 */
export function parseActuatorMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 8) {
    return null;
  }

  // Actuator message format: same 21-byte layout as PT
  if (payload.length < 21) {
    return null;
  }

  const timestampNs = Number(payload.readBigUInt64LE(0));
  const channelId = payload.readUInt8(8); // 1-based channel ID
  // Skip padding (bytes 9-11)
  const rawAdcCounts = payload.readUInt32LE(12);
  const sampleTimestampMs = payload.readUInt32LE(16);
  const statusFlags = payload.readUInt8(20);

  // Channel ID from packet is 1-based, map to actuator names (matches DatabaseConfig.cpp)
  const actuatorMap: Record<number, string> = {
    1: 'ACT.LOX_Main',
    2: 'ACT.Fuel_Vent',
    3: 'ACT.Fuel_Press',
    4: 'ACT.ACT_CH4',
    5: 'ACT.GSE_Low_Vent',
    6: 'ACT.LOX_Vent',
    7: 'ACT.Fuel_Main',
    8: 'ACT.LOX_Press',
    9: 'ACT.Fuel_Fill_Vent',
    10: 'ACT.Fuel_Fill_Press',
  };

  const entity = actuatorMap[channelId] || `ACT.Channel_${channelId}`;

  return {
    entity,
    component: 'raw_adc_counts',
    value: rawAdcCounts,
    timestamp: sampleTimestampMs || Date.now(),
  };
}

/**
 * Parse TC (Thermocouple) Raw Message (21 bytes)
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + uint32_t (4) + uint32_t (4) + uint8_t (1)
 * Same layout as PT Raw
 */
export function parseRawTCMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 21) {
    console.warn(`⚠️ TC Raw payload too short: ${payload.length} bytes (expected 21)`);
    return null;
  }

  const timestampNs = Number(payload.readBigUInt64LE(0));
  const channelId = payload.readUInt8(8);

  // Validate channel ID
  if (channelId < 1 || channelId > 4) {
    console.warn(`⚠️ Invalid channel ID in raw TC: ${channelId}`);
  }

  // Skip padding (bytes 9-11)
  const rawAdcCounts = payload.readUInt32LE(12);
  const sampleTimestampMs = payload.readUInt32LE(16);
  const statusFlags = payload.readUInt8(20);

  // Channel ID from packet is 1-based, map to entity names (matches DatabaseConfig.cpp)
  const entityMap: Record<number, string> = {
    1: 'TC.TC_CH1',
    2: 'TC.TC_CH2',
    3: 'TC.TC_CH3',
    4: 'TC.TC_CH4',
  };

  const entity = entityMap[channelId] || `TC.TC_CH${channelId}`;

  return {
    entity,
    component: 'raw_adc_counts',
    value: rawAdcCounts,
    timestamp: sampleTimestampMs,
  };
}

/**
 * Parse TC Calibrated Message (21 bytes)
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + float (4) + uint32_t (4) + uint8_t (1)
 * Same layout as PT Calibrated
 */
export function parseCalibratedTCMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 21) {
    console.warn(`⚠️ TC Calibrated payload too short: ${payload.length} bytes (expected 21)`);
    return null;
  }

  const timestampNs = Number(payload.readBigUInt64LE(0));
  const channelId = payload.readUInt8(8);

  // Validate channel ID
  if (channelId < 1 || channelId > 4) {
    console.warn(`⚠️ Invalid channel ID in calibrated TC: ${channelId}`);
    return null;
  }

  // Skip padding (bytes 9-11)
  const calibratedTemperatureC = payload.readFloatLE(12);
  const rawAdcCounts = payload.readUInt32LE(16);
  const calibrationStatus = payload.readUInt8(20);

  // Channel ID from packet is 1-based, map to entity names (matches DatabaseConfig.cpp)
  const entityMap: Record<number, string> = {
    1: 'TC_Cal.TC_CH1',
    2: 'TC_Cal.TC_CH2',
    3: 'TC_Cal.TC_CH3',
    4: 'TC_Cal.TC_CH4',
  };

  const entity = entityMap[channelId] || `TC_Cal.TC_CH${channelId}`;

  return {
    entity,
    component: 'temperature_c',
    value: calibratedTemperatureC,
    timestamp: Date.now(),
  };
}

/**
 * Parse RTD (Resistance Temperature Detector) Raw Message (21 bytes)
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + uint32_t (4) + uint32_t (4) + uint8_t (1)
 */
export function parseRawRTDMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 21) {
    console.warn(`⚠️ RTD Raw payload too short: ${payload.length} bytes (expected 21)`);
    return null;
  }

  const timestampNs = Number(payload.readBigUInt64LE(0));
  const channelId = payload.readUInt8(8);

  // Validate channel ID
  if (channelId < 1 || channelId > 4) {
    console.warn(`⚠️ Invalid channel ID in raw RTD: ${channelId}`);
  }

  // Skip padding (bytes 9-11)
  const rawResistance = payload.readUInt32LE(12);
  const sampleTimestampMs = payload.readUInt32LE(16);
  const statusFlags = payload.readUInt8(20);

  // Channel ID from packet is 1-based, map to entity names (matches DatabaseConfig.cpp)
  const entityMap: Record<number, string> = {
    1: 'RTD.RTD_CH1',
    2: 'RTD.RTD_CH2',
    3: 'RTD.RTD_CH3',
    4: 'RTD.RTD_CH4',
  };

  const entity = entityMap[channelId] || `RTD.RTD_CH${channelId}`;

  return {
    entity,
    component: 'raw_resistance',
    value: rawResistance,
    timestamp: sampleTimestampMs,
  };
}

/**
 * Parse RTD Calibrated Message (21 bytes)
 * Layout: uint64_t (8) + uint8_t (1) + padding[3] (3) + float (4) + uint32_t (4) + uint8_t (1)
 */
export function parseCalibratedRTDMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 21) {
    console.warn(`⚠️ RTD Calibrated payload too short: ${payload.length} bytes (expected 21)`);
    return null;
  }

  const timestampNs = Number(payload.readBigUInt64LE(0));
  const channelId = payload.readUInt8(8);

  // Validate channel ID
  if (channelId < 1 || channelId > 4) {
    console.warn(`⚠️ Invalid channel ID in calibrated RTD: ${channelId}`);
    return null;
  }

  // Skip padding (bytes 9-11)
  const calibratedTemperatureC = payload.readFloatLE(12);
  const rawResistance = payload.readUInt32LE(16);
  const calibrationStatus = payload.readUInt8(20);

  // Channel ID from packet is 1-based, map to entity names (matches DatabaseConfig.cpp)
  const entityMap: Record<number, string> = {
    1: 'RTD_Cal.RTD_CH1',
    2: 'RTD_Cal.RTD_CH2',
    3: 'RTD_Cal.RTD_CH3',
    4: 'RTD_Cal.RTD_CH4',
  };

  const entity = entityMap[channelId] || `RTD_Cal.RTD_CH${channelId}`;

  return {
    entity,
    component: 'temperature_c',
    value: calibratedTemperatureC,
    timestamp: Date.now(),
  };
}

/**
 * Parse Elodin packet based on packet_id
 */
export function parseElodinPacket(
  packetId: [number, number],
  payload: Buffer
): ParsedSensorData | null {
  // Packet ID format: [high_byte, low_byte]
  const [high, low] = packetId;

  // PT Raw: [0x20, channel_id] where channel_id is 1-based (0x01-0x0A)
  if (high === 0x20 && low >= 0x01 && low <= 0x0A) {
    return parseRawPTMessage(payload, packetId);
  }

  // PT Calibrated: [0x20, 0x10 + channel_id] where channel_id is 1-based (0x11-0x1A)
  if (high === 0x20 && low >= 0x11 && low <= 0x1A) {
    return parseCalibratedPTMessage(payload, packetId);
  }

  // TC Raw: [0x21, channel_id] where channel_id is 1-based (0x01-0x04)
  if (high === 0x21 && low >= 0x01 && low <= 0x04) {
    return parseRawTCMessage(payload, packetId);
  }

  // TC Calibrated: [0x21, 0x10 + channel_id] where channel_id is 1-based (0x11-0x14)
  if (high === 0x21 && low >= 0x11 && low <= 0x14) {
    return parseCalibratedTCMessage(payload, packetId);
  }

  // RTD Raw: [0x22, channel_id] where channel_id is 1-based (0x01-0x04)
  if (high === 0x22 && low >= 0x01 && low <= 0x04) {
    return parseRawRTDMessage(payload, packetId);
  }

  // RTD Calibrated: [0x22, 0x10 + channel_id] where channel_id is 1-based (0x11-0x14)
  if (high === 0x22 && low >= 0x11 && low <= 0x14) {
    return parseCalibratedRTDMessage(payload, packetId);
  }

  // Actuator data: [0x30, channel_id] where channel_id is 1-based (0x01-0x0A)
  if (high === 0x30 && low >= 0x01 && low <= 0x0A) {
    return parseActuatorMessage(payload, packetId);
  }

  // Unknown packet type - return null (will be logged in handleElodinPacket)
  return null;
}
