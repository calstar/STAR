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

/** Config-driven entity maps (from config.toml sensor_roles / actuator_roles). When set, used instead of hardcoded maps so DB and backend share the same mapping. */
export interface EntityMaps {
  /** channel_id → "PT_Cal.Fuel_Upstream" etc (from sensor_roles); raw PT uses PT. prefix */
  channelToEntityMap?: Record<number, string>;
  /** channel_id → "ACT.LOX_Main" etc (from actuator_roles) */
  actuatorChannelToEntityMap?: Record<number, string>;
}

/**
 * Parse Elodin packet based on packet_id. If entityMaps (from config) are provided, use them so backend and DB are a replica of config.
 */

export const ELODIN_HASH_MAP: Record<string, {entity: string, type: string}> = {
  // PT Raw — keys are the Elodin stream packet IDs (observed from relay log)
  '6b_8b': { entity: 'PT.Fuel_Upstream', type: 'PT' },    // was '10b_8b' (overflowed)
  '9a_8f': { entity: 'PT.GSE_Low', type: 'PT' },          // was '15a_8f'
  '9b_b6': { entity: 'PT.GSE_Mid', type: 'PT' },          // was '155_b6'
  '3a_d':  { entity: 'PT.Fuel_Downstream', type: 'PT' },  // was '3a_10d'
  '4a_a8': { entity: 'PT.Ox_Upstream', type: 'PT' },      // was '14a_a8'
  'a9_b5': { entity: 'PT.GN2_Regulated', type: 'PT' },    // was '169_b5'
  'b8_20': { entity: 'PT.Ox_Downstream', type: 'PT' },
  '1a_c2': { entity: 'PT.PT_CH8', type: 'PT' },           // was '1a_194'
  '6b_b9': { entity: 'PT.PT_CH9', type: 'PT' },           // was '10b_185'
  'eb_a1': { entity: 'PT.PT_CH10', type: 'PT' },
  // PT Calibrated
  '1d_9a': { entity: 'PT_Cal.Fuel_Upstream', type: 'PT_Cal' },
  'd_be':  { entity: 'PT_Cal.GSE_Low', type: 'PT_Cal' },
  'fe_2e': { entity: 'PT_Cal.GSE_Mid', type: 'PT_Cal' },
  '31_82': { entity: 'PT_Cal.Fuel_Downstream', type: 'PT_Cal' },
  '4d_65': { entity: 'PT_Cal.Ox_Upstream', type: 'PT_Cal' },
  'cd_a3': { entity: 'PT_Cal.GN2_Regulated', type: 'PT_Cal' },
  'c3_c0': { entity: 'PT_Cal.Ox_Downstream', type: 'PT_Cal' },
  'f7_3b': { entity: 'PT_Cal.PT_CH8', type: 'PT_Cal' },
  '86_32': { entity: 'PT_Cal.PT_CH9', type: 'PT_Cal' },
  '62_ca': { entity: 'PT_Cal.PT_CH10', type: 'PT_Cal' },
  // Actuators
  '39_32': { entity: 'ACT.LOX_Main', type: 'ACT' },
  '45_de': { entity: 'ACT.Fuel_Vent', type: 'ACT' },
  'fd_4e': { entity: 'ACT.Fuel_Press', type: 'ACT' },
  'c_b5':  { entity: 'ACT.ACT_CH4', type: 'ACT' },
  'f3_84': { entity: 'ACT.GSE_Low_Vent', type: 'ACT' },
  '4a_fb': { entity: 'ACT.LOX_Vent', type: 'ACT' },
  '79_46': { entity: 'ACT.Fuel_Main', type: 'ACT' },
  'ce_65': { entity: 'ACT.LOX_Press', type: 'ACT' },      // was 'ce_101'
  'd4_30': { entity: 'ACT.Fuel_Fill_Vent', type: 'ACT' },
  '24_15': { entity: 'ACT.Fuel_Fill_Press', type: 'ACT' },
  '19_1a': { entity: 'ACT.GSE_LOX_Fill_Vent', type: 'ACT' },
  'd8_b8': { entity: 'ACT.GSE_High_Press_Control', type: 'ACT' },
  '47_67': { entity: 'ACT.GSE_Med_Press_Control', type: 'ACT' },
  'c0_c3': { entity: 'ACT.GSE_High_Press_Vent', type: 'ACT' }, // was '192_c3'
  'a3_f5': { entity: 'ACT.GN2_Vent', type: 'ACT' },
  'db_be': { entity: 'ACT.LOX_Fill', type: 'ACT' },
  'c3_5f': { entity: 'ACT.LOX_Dump', type: 'ACT' },
  // TC Raw (two entries for TC_CH1 — both observed IDs kept)
  'fb_e6': { entity: 'TC.TC_CH1', type: 'TC' },
  '38_c0': { entity: 'TC.TC_CH1', type: 'TC' },
  'a5_c7': { entity: 'TC.TC_CH2', type: 'TC' },
  'd6_c2': { entity: 'TC.TC_CH3', type: 'TC' },
  '43_c2': { entity: 'TC.TC_CH4', type: 'TC' },
  // TC Calibrated
  'f0_91': { entity: 'TC_Cal.TC_CH1', type: 'TC_Cal' },
  '5d_96': { entity: 'TC_Cal.TC_CH2', type: 'TC_Cal' },
  'ca_92': { entity: 'TC_Cal.TC_CH3', type: 'TC_Cal' },
  'cf_b6': { entity: 'TC_Cal.TC_CH4', type: 'TC_Cal' },
  // RTD Raw
  '4_36':  { entity: 'RTD.RTD_CH1', type: 'RTD' },
  'bd_3c': { entity: 'RTD.RTD_CH2', type: 'RTD' },
  '22_3d': { entity: 'RTD.RTD_CH3', type: 'RTD' },
  'db_35': { entity: 'RTD.RTD_CH4', type: 'RTD' },
  // RTD Calibrated
  'e4_ec': { entity: 'RTD_Cal.RTD_CH1', type: 'RTD_Cal' },
  '9_eb':  { entity: 'RTD_Cal.RTD_CH2', type: 'RTD_Cal' },
  'be_f5': { entity: 'RTD_Cal.RTD_CH3', type: 'RTD_Cal' },
  'bb_d3': { entity: 'RTD_Cal.RTD_CH4', type: 'RTD_Cal' },
  // LC Raw
  '75_31': { entity: 'LC.CH1', type: 'LC' },
  'bc_6b': { entity: 'LC.LC_CH1', type: 'LC' },
  '41_69': { entity: 'LC.LC_CH2', type: 'LC' },
  'd2_6e': { entity: 'LC.LC_CH3', type: 'LC' },
  '67_6a': { entity: 'LC.LC_CH4', type: 'LC' },
  // LC Calibrated
  '24_d5': { entity: 'LC_Cal.LC_CH1', type: 'LC_Cal' },
  '89_ca': { entity: 'LC_Cal.LC_CH2', type: 'LC_Cal' },
  '7e_ce': { entity: 'LC_Cal.LC_CH3', type: 'LC_Cal' },
  '7b_d2': { entity: 'LC_Cal.LC_CH4', type: 'LC_Cal' },
};


export function parseElodinPacket(
  packetId: [number, number],
  payload: Buffer,
  entityMaps?: EntityMaps
): ParsedSensorData | null {
  const [high, low] = packetId;
  const hashKey = `${high.toString(16)}_${low.toString(16)}`;
  
  // First try to look up the hash directly from ELODIN_HASH_MAP
  const mapEntry = ELODIN_HASH_MAP[hashKey];
  
  if (mapEntry) {
    // Try full 21-byte parser first; fall back to compact Stream{} format
    // Compact format: [u64 timestamp (8 bytes)] + [field value (N bytes)]
    //   9 bytes  → 8-byte ts + 1-byte u8  (valve state, channel id, status)
    //   12 bytes → 8-byte ts + 4-byte u32/f32 (raw ADC counts or calibrated float)
    //   16 bytes → 8-byte ts + 8-byte u64 or two u32s

    if (mapEntry.type === 'PT') {
      const parsed = parseRawPTMessage(payload, packetId);
      if (parsed) { parsed.entity = mapEntry.entity; return parsed; }
      // Compact fallback
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component: 'raw_adc_counts',
                 value: payload.readUInt32LE(8), timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component: 'raw_adc_counts',
                 value: payload.readUInt8(8), timestamp: Date.now() };
      }
      return null;
    }

    if (mapEntry.type === 'PT_Cal') {
      const parsed = parseCalibratedPTMessage(payload, packetId);
      if (parsed) { parsed.entity = mapEntry.entity; return parsed; }
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component: 'pressure_psi',
                 value: payload.readFloatLE(8), timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component: 'pressure_psi',
                 value: payload.readUInt8(8), timestamp: Date.now() };
      }
      return null;
    }

    if (mapEntry.type === 'ACT') {
      const parsed = parseActuatorMessage(payload, packetId);
      if (parsed) { parsed.entity = mapEntry.entity; return parsed; }
      // ACT compact: 9-byte → valve state byte; 12-byte → raw ADC u32
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component: 'raw_adc_counts',
                 value: payload.readUInt32LE(8), timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component: 'valve_state',
                 value: payload.readUInt8(8), timestamp: Date.now() };
      }
      return null;
    }

    if (mapEntry.type === 'TC') {
      const parsed = parseRawTCMessage(payload, packetId);
      if (parsed) { parsed.entity = mapEntry.entity; return parsed; }
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component: 'raw_adc_counts',
                 value: payload.readUInt32LE(8), timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component: 'raw_adc_counts',
                 value: payload.readUInt8(8), timestamp: Date.now() };
      }
      return null;
    }

    if (mapEntry.type === 'TC_Cal') {
      const parsed = parseCalibratedTCMessage(payload, packetId);
      if (parsed) { parsed.entity = mapEntry.entity; return parsed; }
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component: 'temperature_c',
                 value: payload.readFloatLE(8), timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component: 'temperature_c',
                 value: payload.readUInt8(8), timestamp: Date.now() };
      }
      return null;
    }

    if (mapEntry.type === 'RTD') {
      const parsed = parseRawRTDMessage(payload, packetId);
      if (parsed) { parsed.entity = mapEntry.entity; return parsed; }
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component: 'raw_resistance_counts',
                 value: payload.readUInt32LE(8), timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component: 'raw_resistance_counts',
                 value: payload.readUInt8(8), timestamp: Date.now() };
      }
      return null;
    }

    if (mapEntry.type === 'RTD_Cal') {
      const parsed = parseCalibratedRTDMessage(payload, packetId);
      if (parsed) { parsed.entity = mapEntry.entity; return parsed; }
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component: 'temperature_c',
                 value: payload.readFloatLE(8), timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component: 'temperature_c',
                 value: payload.readUInt8(8), timestamp: Date.now() };
      }
      return null;
    }

    if (mapEntry.type === 'LC' || mapEntry.type === 'LC_Cal') {
      const component = mapEntry.type === 'LC_Cal' ? 'force_lbf' : 'raw_adc_counts';
      if (payload.length >= 12) {
        return { entity: mapEntry.entity, component,
                 value: mapEntry.type === 'LC_Cal' ? payload.readFloatLE(8) : payload.readUInt32LE(8),
                 timestamp: Date.now() };
      }
      if (payload.length >= 9) {
        return { entity: mapEntry.entity, component, value: payload.readUInt8(8),
                 timestamp: Date.now() };
      }
      return null;
    }
  }

  // Fallback: direct packet_id scheme (0x20=PT, 0x21=TC, 0x22=RTD, 0x23=LC, 0x30=ACT)
  // PT raw: channels 1-14 (boards 1 and 2)
  if (high === 0x20 && low >= 0x01 && low <= 0x0E) {
    const parsed = parseRawPTMessage(payload, packetId);
    if (parsed && entityMaps?.channelToEntityMap && payload.length >= 9) {
      const ch = payload.readUInt8(8);
      const cal = entityMaps.channelToEntityMap[ch];
      if (cal) parsed.entity = cal.replace('PT_Cal.', 'PT.');
    }
    return parsed;
  }
  // PT calibrated: channels 1-14 (boards 1 and 2; lo = 0x10+ch, so ch14 → lo=0x1E)
  if (high === 0x20 && low >= 0x11 && low <= 0x1E) {
    return parseCalibratedPTMessage(payload, packetId);
  }
  if (high === 0x21 && low >= 0x01 && low <= 0x04) {
    return parseRawTCMessage(payload, packetId);
  }
  if (high === 0x21 && low >= 0x11 && low <= 0x14) {
    return parseCalibratedTCMessage(payload, packetId);
  }
  if (high === 0x22 && low >= 0x01 && low <= 0x04) {
    return parseRawRTDMessage(payload, packetId);
  }
  if (high === 0x22 && low >= 0x11 && low <= 0x14) {
    return parseCalibratedRTDMessage(payload, packetId);
  }
  if (high === 0x30 && low >= 0x01 && low <= 0x0A) {
    let parsed = parseActuatorMessage(payload, packetId);
    if (parsed && entityMaps?.actuatorChannelToEntityMap && payload.length >= 9) {
      const ch = payload.readUInt8(8);
      if (entityMaps.actuatorChannelToEntityMap[ch]) parsed.entity = entityMaps.actuatorChannelToEntityMap[ch];
    }
    return parsed;
  }
  
  // Log unmapped packet IDs so they can be identified and added to ELODIN_HASH_MAP
  if (process.env.ELODIN_DEBUG === '1') {
    console.debug(
      `[Elodin] Unmapped packet id=[0x${high.toString(16).padStart(2,'0')}, 0x${low.toString(16).padStart(2,'0')}] ` +
      `hashKey=${hashKey} payloadLen=${payload.length}`
    );
  }

  return null;
}
