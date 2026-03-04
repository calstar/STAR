/**
 * Elodin Protocol Parser
 * Parses binary Elodin messages into structured data.
 *
 * ALL entity names come from config.toml via EntityMaps — NO hardcoded maps.
 * Packet IDs use the direct [high, low] scheme:
 *   PT raw      = [0x20, 0x01..0x0E]
 *   PT cal      = [0x20, 0x11..0x1E]
 *   TC raw      = [0x21, 0x01..0x04]
 *   TC cal      = [0x21, 0x11..0x14]
 *   RTD raw     = [0x22, 0x01..0x04]
 *   RTD cal     = [0x22, 0x11..0x14]
 *   LC raw      = [0x23, 0x01..0x04]
 *   LC cal      = [0x23, 0x11..0x14]
 *   ACT         = [0x30, 0x01..0x0A]
 *   CTRL act    = [0x40, 0x00]
 *   CTRL diag   = [0x41, 0x00]
 *   CTRL meas   = [0x42, 0x00]
 */

export interface ParsedSensorData {
  entity: string;
  component: string;
  value: number;
  timestamp: number;
}

/** Config-driven entity maps (from config.toml sensor_roles / actuator_roles). */
export interface EntityMaps {
  /** channel_id → "PT_Cal.FUEL_UP" etc (from sensor_roles) */
  channelToEntityMap?: Record<number, string>;
  /** channel_id → "ACT.LOX_Main" etc (from actuator_roles) */
  actuatorChannelToEntityMap?: Record<number, string>;
}

// ── 21-byte message parsers (shared layout) ─────────────────────────────────
// Layout: uint64_t(8) + uint8_t(1) + pad[3](3) + uint32_t/float(4) + uint32_t(4) + uint8_t(1)

const RAW_SENSOR_PAYLOAD_SIZE = 21; // u64(8) + u8(1) + pad(3) + u32(4) + u32(4) + u8(1)

function parseRawSensorPayload(
  payload: Buffer,
  channelId: number,
  entity: string,
  fieldName: string = 'raw_adc_counts',
): ParsedSensorData | null {
  // RawPTMessage layout: u64(0) ts + u8(8) ch + pad3(9-11) + u32(12) raw_adc + u32(16) sample_ts + u8(20)
  // Require full 21 bytes to avoid reading garbage from truncated/malformed packets.
  if (payload.length < RAW_SENSOR_PAYLOAD_SIZE) return null;
  const rawValue = payload.readUInt32LE(12);
  const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
  return { entity, component: fieldName, value: rawValue, timestamp: tsMs };
}

function parseCalibratedSensorPayload(
  payload: Buffer,
  channelId: number,
  entity: string,
  fieldName: string = 'pressure_psi',
): ParsedSensorData | null {
  // CalibratedPTMessage: u64(0) ts + u8(8) ch + pad3(9-11) + float(12) psi + u32(16) raw + u8(20)
  if (payload.length < RAW_SENSOR_PAYLOAD_SIZE) return null;
  const calibratedValue = payload.readFloatLE(12);
  if (!Number.isFinite(calibratedValue) || Number.isNaN(calibratedValue)) return null;
  if (fieldName === 'pressure_psi' && (calibratedValue < -100 || calibratedValue > 10000)) return null;
  const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
  return { entity, component: fieldName, value: calibratedValue, timestamp: tsMs };
}

/**
 * Parse LC (Load Cell) Raw Message (21 bytes)
 * Layout: same as PT/TC raw — uint64_t (8) + uint8_t (1) + padding[3] (3) + uint32_t (4) + uint32_t (4) + uint8_t (1)
 * Entity names match FSW DatabaseConfig: LC.CH1 .. LC.CH4
 */
export function parseRawLCMessage(
  payload: Buffer,
  packetId: [number, number]
): ParsedSensorData | null {
  if (payload.length < 21) {
    console.warn(`⚠️ LC Raw payload too short: ${payload.length} bytes (expected 21)`);
    return null;
  }

  const channelId = payload.readUInt8(8);

  if (channelId < 1 || channelId > 4) {
    console.warn(`⚠️ Invalid channel ID in raw LC: ${channelId}`);
  }

  const rawAdcCounts = payload.readUInt32LE(12);
  const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);

  return {
    entity: `LC.CH${channelId}`,
    component: 'raw_adc_counts',
    value: rawAdcCounts,
    timestamp: tsMs,
  };
}

/**
 * Parse Elodin packet based on packet_id. If entityMaps (from config) are provided, use them so backend and DB are a replica of config.
 *
 * Parse Elodin packet using direct [high, low] packet_id scheme.
 */
export function parseElodinPacket(
  packetId: [number, number],
  payload: Buffer,
  entityMaps?: EntityMaps
): ParsedSensorData | null {
  const [high, low] = packetId;

  // ── PT Raw: [0x20, 0x01..0x0E] ──────────────────────────────────────────
  if (high === 0x20 && low >= 0x01 && low <= 0x0E) {
    const ch = low;
    const payloadCh = payload.length >= 9 ? payload.readUInt8(8) : ch;
    const baseEntity = entityMaps?.channelToEntityMap?.[payloadCh]?.replace('PT_Cal.', 'PT.') || `PT.CH${payloadCh}`;
    return parseRawSensorPayload(payload, ch, baseEntity, 'raw_adc_counts');
  }

  // ── PT Calibrated: [0x20, 0x11..0x1E] ───────────────────────────────────
  if (high === 0x20 && low >= 0x11 && low <= 0x1E) {
    const ch = low - 0x10;
    const payloadCh = payload.length >= 9 ? payload.readUInt8(8) : ch;
    const entityName = entityMaps?.channelToEntityMap?.[payloadCh] || `PT_Cal.CH${payloadCh}`;
    return parseCalibratedSensorPayload(payload, ch, entityName, 'pressure_psi');
  }

  // ── TC Raw: [0x21, 0x01..0x14] ──────────────────────────────────────────
  if (high === 0x21 && low >= 0x01 && low <= 0x14) {
    const ch = low;
    return parseRawSensorPayload(payload, ch, `TC.CH${ch}`, 'raw_adc_counts');
  }

  // ── TC Calibrated: [0x21, 0x11..0x24] ───────────────────────────────────
  if (high === 0x21 && low >= 0x11 && low <= 0x24) {
    const ch = low - 0x10;
    return parseCalibratedSensorPayload(payload, ch, `TC_Cal.CH${ch}`, 'temperature_c');
  }

  // ── RTD Raw: [0x22, 0x01..0x14] ─────────────────────────────────────────
  if (high === 0x22 && low >= 0x01 && low <= 0x14) {
    const ch = low;
    return parseRawSensorPayload(payload, ch, `RTD.CH${ch}`, 'raw_resistance_counts');
  }

  // ── RTD Calibrated: [0x22, 0x11..0x24] ───────────────────────────────────
  if (high === 0x22 && low >= 0x11 && low <= 0x24) {
    const ch = low - 0x10;
    return parseCalibratedSensorPayload(payload, ch, `RTD_Cal.CH${ch}`, 'temperature_c');
  }

  // ── LC Raw: [0x23, 0x01..0x14] ──────────────────────────────────────────
  if (high === 0x23 && low >= 0x01 && low <= 0x14) {
    const ch = low;
    return parseRawSensorPayload(payload, ch, `LC.CH${ch}`, 'raw_adc_counts');
  }

  // ── LC Calibrated: [0x23, 0x11..0x24] ───────────────────────────────────
  if (high === 0x23 && low >= 0x11 && low <= 0x24) {
    const ch = low - 0x10;
    return parseCalibratedSensorPayload(payload, ch, `LC_Cal.CH${ch}`, 'force_lbf');
  }

  // ── Actuator: [0x30, 0x01..0x0A] ────────────────────────────────────────
  if (high === 0x30 && low >= 0x01 && low <= 0x0A) {
    const ch = low;
    const payloadCh = payload.length >= 9 ? payload.readUInt8(8) : ch;
    const entityName = entityMaps?.actuatorChannelToEntityMap?.[payloadCh] || `ACT.CH${payloadCh}`;
    return parseRawSensorPayload(payload, ch, entityName, 'raw_adc_counts');
  }

  // ── Actuator state (0=closed, 1=open): [0x31, 0x01..0x14] ─────────────────
  if (high === 0x31 && low >= 0x01 && payload.length >= 10) {
    const ch = low;
    const payloadCh = payload.readUInt8(8);
    const state = payload.readUInt8(9);
    const entityName = entityMaps?.actuatorChannelToEntityMap?.[payloadCh] || `ACT.CH${payloadCh}`;
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return { entity: entityName, component: 'actuator_state', value: state, timestamp: tsMs };
  }

  // ── Controller Actuation: [0x40, 0x00] ──────────────────────────────────
  // Layout: u64(8) timestamp_ns | f32(4) duty_F | f32(4) duty_O | u8 u_F_on | u8 u_O_on | u8 valid
  // Uses boot-relative ns
  if (high === 0x40 && low === 0x00 && payload.length >= 19) {
    const duty_F = payload.readFloatLE(8);
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return { entity: 'CONTROLLER.actuation', component: 'duty_F', value: duty_F, timestamp: tsMs };
  }

  // ── Controller Diagnostics: [0x41, 0x00] ────────────────────────────────
  // Layout: u64(8) ts | f64(8) F_ref | f64 MR_ref | f64 F_estimated | f64 MR_estimated | f64 P_ch | ...
  if (high === 0x41 && low === 0x00 && payload.length >= 48) {
    const F_estimated = payload.readDoubleLE(24);
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return { entity: 'CONTROLLER.diagnostics', component: 'F_estimated', value: F_estimated, timestamp: tsMs };
  }

  // ── Controller Measurement: [0x42, 0x00] ────────────────────────────────
  // Layout: u64(8) ts | f64(8) P_copv | f64 P_reg | f64 P_u_fuel | f64 P_u_ox | f64 P_d_fuel | f64 P_d_ox
  if (high === 0x42 && low === 0x00 && payload.length >= 32) {
    const P_u_fuel = payload.readDoubleLE(24);
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return { entity: 'CONTROLLER.measurement', component: 'P_u_fuel', value: P_u_fuel, timestamp: tsMs };
  }

  // Log unmapped packet IDs (only when debug enabled)
  if (process.env.ELODIN_DEBUG === '1') {
    console.debug(
      `[Elodin] Unmapped packet id=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}] ` +
      `payloadLen=${payload.length}`
    );
  }

  return null;
}
