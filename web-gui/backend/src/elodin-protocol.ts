/**
 * Elodin Protocol Parser
 * Parses binary Elodin messages into structured data.
 *
 * ALL entity names come from config.toml via EntityMaps — NO hardcoded maps.
 * Packet IDs use the direct [high, low] scheme:
 *   PT raw      = [0x20, 0x01..0x0E]
 *   PT cal      = [0x20, 0x11..0x1E]
 *   TC raw      = [0x21, 0x01..0x14]
 *   TC cal      = [0x21, 0x11..0x24]
 *   RTD raw     = [0x22, 0x01..0x04]
 *   RTD cal     = [0x22, 0x11..0x14]
 *   LC raw      = [0x23, 0x01..0x14]
 *   LC cal      = [0x23, 0x11..0x24]
 *   ACT         = [0x30, 0x01..0x0A]
 *   ACT state   = [0x31, 0x01..0x14]
 *   CTRL act    = [0x40, 0x00]   19 bytes: U64+F32+F32+U8+U8+U8
 *   CTRL diag   = [0x41, 0x00]   62 bytes: U64+6×F64+I32+U8+U8
 *   CTRL meas   = [0x42, 0x00]   80 bytes: U64+8×F64
 *   PSM state   = [0x43, 0x00]   11 bytes: U64+U8+U8+U8
 *   FIRE state  = [0x44, 0x00]   18 bytes: U64+U8+F32+F32
 *   PSM act cmd = [0x50, 0x60..0x66]  15 bytes: U64+U8+U8+F32+U8
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

/**
 * Parse raw sensor payload. ADC bytes at offset 12 are interpreted as signed when the
 * hardware is a signed ADC (e.g. ADS1262 for LC/PT); otherwise unsigned.
 */
function parseRawSensorPayload(
  payload: Buffer,
  channelId: number,
  entity: string,
  fieldName: string = 'raw_adc_counts',
  signedAdc: boolean = false,
): ParsedSensorData | null {
  // RawPTMessage layout: u64(0) ts + u8(8) ch + pad3(9-11) + u32(12) raw_adc + u32(16) sample_ts + u8(20)
  if (payload.length < RAW_SENSOR_PAYLOAD_SIZE) return null;
  const rawValue = signedAdc ? payload.readInt32LE(12) : payload.readUInt32LE(12);
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

  if (channelId < 1 || channelId > 20) {
    console.warn(`⚠️ Invalid channel ID in raw LC: ${channelId}`);
  }

  // LC uses signed 24/32-bit ADC (e.g. ADS1262); interpret as int32 to avoid negative codes showing as ~4e9
  const rawAdcCounts = payload.readInt32LE(12);
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
): ParsedSensorData[] {
  const [high, low] = packetId;

  // ── PT Raw: [0x20, 0x01..0x0E] — signed ADC (ADS1262), avoid uint32 → ~4e9 for negative codes
  if (high === 0x20 && low >= 0x01 && low <= 0x0E) {
    const ch = low;
    const payloadCh = payload.length >= 9 ? payload.readUInt8(8) : ch;
    const baseEntity = entityMaps?.channelToEntityMap?.[payloadCh]?.replace('PT_Cal.', 'PT.') || `PT.CH${payloadCh}`;
    const r = parseRawSensorPayload(payload, ch, baseEntity, 'raw_adc_counts', true);
    return r ? [r] : [];
  }

  // ── PT Calibrated: [0x20, 0x11..0x1E] ───────────────────────────────────
  if (high === 0x20 && low >= 0x11 && low <= 0x1E) {
    const ch = low - 0x10;
    const payloadCh = payload.length >= 9 ? payload.readUInt8(8) : ch;
    const entityName = entityMaps?.channelToEntityMap?.[payloadCh] || `PT_Cal.CH${payloadCh}`;
    const r = parseCalibratedSensorPayload(payload, ch, entityName, 'pressure_psi');
    return r ? [r] : [];
  }

  // ── TC Raw: [0x21, 0x01..0x14] — signed ADC (ADS1262), avoid uint32 → 2^31-1 for negative/saturated codes
  if (high === 0x21 && low >= 0x01 && low <= 0x14) {
    const ch = low;
    const r = parseRawSensorPayload(payload, ch, `TC.CH${ch}`, 'raw_adc_counts', true);
    return r ? [r] : [];
  }

  // ── TC Calibrated: [0x21, 0x11..0x24] ───────────────────────────────────
  if (high === 0x21 && low >= 0x11 && low <= 0x24) {
    const ch = low - 0x10;
    const r = parseCalibratedSensorPayload(payload, ch, `TC_Cal.CH${ch}`, 'temperature_c');
    return r ? [r] : [];
  }

  // ── RTD Raw: [0x22, 0x01..0x14] ─────────────────────────────────────────
  if (high === 0x22 && low >= 0x01 && low <= 0x14) {
    const ch = low;
    const r = parseRawSensorPayload(payload, ch, `RTD.CH${ch}`, 'raw_resistance_counts');
    return r ? [r] : [];
  }

  // ── RTD Calibrated: [0x22, 0x11..0x24] ───────────────────────────────────
  if (high === 0x22 && low >= 0x11 && low <= 0x24) {
    const ch = low - 0x10;
    const r = parseCalibratedSensorPayload(payload, ch, `RTD_Cal.CH${ch}`, 'temperature_c');
    return r ? [r] : [];
  }

  // ── LC Raw: [0x23, 0x01..0x14] — signed ADC (ADS1262), avoid uint32 → ~4e9 for negative codes
  if (high === 0x23 && low >= 0x01 && low <= 0x14) {
    const ch = low;
    const r = parseRawSensorPayload(payload, ch, `LC.CH${ch}`, 'raw_adc_counts', true);
    return r ? [r] : [];
  }

  // ── LC Calibrated: [0x23, 0x11..0x24] ───────────────────────────────────
  if (high === 0x23 && low >= 0x11 && low <= 0x24) {
    const ch = low - 0x10;
    const r = parseCalibratedSensorPayload(payload, ch, `LC_Cal.CH${ch}`, 'force_lbf');
    return r ? [r] : [];
  }

  // ── Encoder Raw: [0x24, 0x01..0x02] ──────────────────────────────────────
  if (high === 0x24 && low >= 0x01 && low <= 0x02) {
    const ch = low;
    return parseRawSensorPayload(payload, ch, `ENC.CH${ch}`, 'raw_angle');
  }

  // ── Actuator: [0x30, 0x01..0x0A] ────────────────────────────────────────
  if (high === 0x30 && low >= 0x01 && low <= 0x0A) {
    const ch = low;
    const payloadCh = payload.length >= 9 ? payload.readUInt8(8) : ch;
    const entityName = entityMaps?.actuatorChannelToEntityMap?.[payloadCh] || `ACT.CH${payloadCh}`;
    const r = parseRawSensorPayload(payload, ch, entityName, 'raw_adc_counts');
    return r ? [r] : [];
  }

  // ── Actuator state (0=closed, 1=open): [0x31, 0x01..0x14] ─────────────────
  if (high === 0x31 && low >= 0x01 && payload.length >= 10) {
    const ch = low;
    const payloadCh = payload.readUInt8(8);
    const state = payload.readUInt8(9);
    const entityName = entityMaps?.actuatorChannelToEntityMap?.[payloadCh] || `ACT.CH${payloadCh}`;
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return [{ entity: entityName, component: 'actuator_state', value: state, timestamp: tsMs }];
  }

  // ── Controller Actuation: [0x40, 0x00] ──────────────────────────────────
  // Layout: U64(0) timestamp_ns | F32(8) duty_F | F32(12) duty_O | U8(16) u_F_on | U8(17) u_O_on | U8(18) valid
  if (high === 0x40 && low === 0x00 && payload.length >= 19) {
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return [
      { entity: 'CONTROLLER.actuation', component: 'duty_F', value: payload.readFloatLE(8), timestamp: tsMs },
      { entity: 'CONTROLLER.actuation', component: 'duty_O', value: payload.readFloatLE(12), timestamp: tsMs },
      { entity: 'CONTROLLER.actuation', component: 'u_F_on', value: payload.readUInt8(16), timestamp: tsMs },
      { entity: 'CONTROLLER.actuation', component: 'u_O_on', value: payload.readUInt8(17), timestamp: tsMs },
      { entity: 'CONTROLLER.actuation', component: 'valid', value: payload.readUInt8(18), timestamp: tsMs },
    ];
  }

  // ── Controller Diagnostics: [0x41, 0x00] ────────────────────────────────
  // Layout: U64(0) | F64(8) F_ref | F64(16) MR_ref | F64(24) F_est | F64(32) MR_est | F64(40) P_ch |
  //         F64(48) cost | I32(56) solver_iters | U8(60) safety_filtered | U8(61) cutoff_active
  if (high === 0x41 && low === 0x00 && payload.length >= 62) {
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return [
      { entity: 'CONTROLLER.diagnostics', component: 'F_ref', value: payload.readDoubleLE(8), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'MR_ref', value: payload.readDoubleLE(16), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'F_estimated', value: payload.readDoubleLE(24), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'MR_estimated', value: payload.readDoubleLE(32), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'P_ch', value: payload.readDoubleLE(40), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'cost', value: payload.readDoubleLE(48), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'solver_iters', value: payload.readInt32LE(56), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'safety_filtered', value: payload.readUInt8(60), timestamp: tsMs },
      { entity: 'CONTROLLER.diagnostics', component: 'cutoff_active', value: payload.readUInt8(61), timestamp: tsMs },
    ];
  }

  // ── Controller Measurement: [0x42, 0x00] ────────────────────────────────
  // Layout: U64(0) | F64(8) P_copv | F64(16) P_reg | F64(24) P_u_fuel | F64(32) P_u_ox |
  //         F64(40) P_d_fuel | F64(48) P_d_ox | F64(56) P_ch_mp1 | F64(64) P_ch_mp2
  if (high === 0x42 && low === 0x00 && payload.length >= 56) {
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    const fields: ParsedSensorData[] = [
      { entity: 'CONTROLLER.measurement', component: 'P_copv', value: payload.readDoubleLE(8), timestamp: tsMs },
      { entity: 'CONTROLLER.measurement', component: 'P_reg', value: payload.readDoubleLE(16), timestamp: tsMs },
      { entity: 'CONTROLLER.measurement', component: 'P_u_fuel', value: payload.readDoubleLE(24), timestamp: tsMs },
      { entity: 'CONTROLLER.measurement', component: 'P_u_ox', value: payload.readDoubleLE(32), timestamp: tsMs },
      { entity: 'CONTROLLER.measurement', component: 'P_d_fuel', value: payload.readDoubleLE(40), timestamp: tsMs },
      { entity: 'CONTROLLER.measurement', component: 'P_d_ox', value: payload.readDoubleLE(48), timestamp: tsMs },
    ];
    if (payload.length >= 72) {
      fields.push({ entity: 'CONTROLLER.measurement', component: 'P_ch_mp1', value: payload.readDoubleLE(56), timestamp: tsMs });
      fields.push({ entity: 'CONTROLLER.measurement', component: 'P_ch_mp2', value: payload.readDoubleLE(64), timestamp: tsMs });
    }
    return fields;
  }

  // ── PSM State Transition: [0x43, 0x00] ──────────────────────────────────
  // Layout: U64(0) timestamp_ns | U8(8) from_state | U8(9) to_state | U8(10) reason
  if (high === 0x43 && low === 0x00 && payload.length >= 11) {
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return [
      { entity: 'CONTROLLER.state', component: 'from_state', value: payload.readUInt8(8), timestamp: tsMs },
      { entity: 'CONTROLLER.state', component: 'to_state', value: payload.readUInt8(9), timestamp: tsMs },
      { entity: 'CONTROLLER.state', component: 'reason', value: payload.readUInt8(10), timestamp: tsMs },
    ];
  }

  // ── Fire State Event: [0x44, 0x00] ──────────────────────────────────────
  // Layout: U64(0) timestamp_ns | U8(8) fire_active | F32(9) duty_F | F32(13) duty_O
  if (high === 0x44 && low === 0x00 && payload.length >= 17) {
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return [
      { entity: 'CONTROLLER.fire', component: 'fire_active', value: payload.readUInt8(8), timestamp: tsMs },
      { entity: 'CONTROLLER.fire', component: 'duty_F', value: payload.readFloatLE(9), timestamp: tsMs },
      { entity: 'CONTROLLER.fire', component: 'duty_O', value: payload.readFloatLE(13), timestamp: tsMs },
    ];
  }

  // ── PSM Actuator Command: [0x50, 0x60..0x66] ────────────────────────────
  // Layout: U64(0) | U8(8) actuator_id | U8(9) command_type | F32(10) value | U8(14) status
  if (high === 0x50 && low >= 0x60 && low <= 0x66 && payload.length >= 15) {
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    const actuatorId = payload.readUInt8(8);
    const cmdType = payload.readUInt8(9);
    const cmdValue = payload.readFloatLE(10);
    const status = payload.readUInt8(14);
    return [
      { entity: `PSM.actuator.${actuatorId}`, component: 'command_type', value: cmdType, timestamp: tsMs },
      { entity: `PSM.actuator.${actuatorId}`, component: 'value', value: cmdValue, timestamp: tsMs },
      { entity: `PSM.actuator.${actuatorId}`, component: 'status', value: status, timestamp: tsMs },
    ];
  }

  // ── Self Test Result: [0x60, 0x01..0x3F] ────────────────────────────────
  // Layout: U64(0) timestamp_ns | U8(8) sensor_id | U8(9) result (1=pass, 0=fail)
  if (high === 0x60 && payload.length >= 10) {
    const boardId = low;
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    const sensorId = payload.readUInt8(8);
    const result = payload.readUInt8(9);
    return [
      {
        entity: `SELF_TEST.BOARD_${boardId}`,
        component: `sensor_${sensorId}`,
        value: result,
        timestamp: tsMs,
      },
    ];
  }

  // Log unmapped packet IDs (only when debug enabled)
  if (process.env.ELODIN_DEBUG === '1') {
    console.debug(
      `[Elodin] Unmapped packet id=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}] ` +
      `payloadLen=${payload.length}`
    );
  }

  return [];
}
