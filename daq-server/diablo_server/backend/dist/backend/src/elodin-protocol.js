/**
 * Elodin Protocol Parser
 * Parses binary Elodin messages into structured data.
 *
 * All entity names are board-namespaced channel-based (PT1.CH1, ACT2.CH3, TC1_Cal.CH5).
 * Role names ("Fuel Upstream") are frontend display metadata only.
 * Packet IDs use the board-aware [high, low] scheme:
 *   low byte = (board_number - 1) * 0x20 + channel  (raw)
 *              (board_number - 1) * 0x20 + 0x10 + channel  (calibrated)
 *   board_number = board_id % 10
 *   Example: PT board 1 raw CH3 = [0x20, 0x03], PT board 1 cal CH3 = [0x20, 0x13]
 *            PT board 2 raw CH1 = [0x20, 0x11], ACT board 4 raw CH5 = [0x30, 0x45]
 *   CTRL act    = [0x40, 0x00]   19 bytes: U64+F32+F32+U8+U8+U8
 *   CTRL diag   = [0x41, 0x00]   62 bytes: U64+6×F64+I32+U8+U8
 *   CTRL meas   = [0x42, 0x00]   80 bytes: U64+8×F64
 *   PSM state   = [0x43, 0x00]   11 bytes: U64+U8+U8+U8
 *   FIRE state  = [0x44, 0x00]   18 bytes: U64+U8+F32+F32
 *   Sequencer   = [0x50, 0x00]   17 bytes: U64+U8+pad3+U32+u8 (see docs/adding-sensor-streams.md)
 *   PSM act cmd = [0x50, 0x60..0x66]  15 bytes: U64+U8+U8+F32+U8
 */
// ── 21-byte message parsers (shared layout) ─────────────────────────────────
// Layout: uint64_t(8) + uint8_t(1) + pad[3](3) + uint32_t/float(4) + uint32_t(4) + uint8_t(1)
const RAW_SENSOR_PAYLOAD_SIZE = 21; // u64(8) + u8(1) + pad(3) + u32(4) + u32(4) + u8(1)
/**
 * Parse raw sensor payload. ADC bytes at offset 12 are interpreted as signed when the
 * hardware is a signed ADC (e.g. ADS1262 for LC/PT); otherwise unsigned.
 */
function parseRawSensorPayload(payload, channelId, entity, fieldName = 'raw_adc_counts', signedAdc = false) {
    // RawPTMessage layout: u64(0) ts + u8(8) ch + pad3(9-11) + u32(12) raw_adc + u32(16) sample_ts + u8(20)
    if (payload.length < RAW_SENSOR_PAYLOAD_SIZE)
        return null;
    const rawValue = signedAdc ? payload.readInt32LE(12) : payload.readUInt32LE(12);
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    return { entity, component: fieldName, value: rawValue, timestamp: tsMs };
}
function parseCalibratedSensorPayload(payload, channelId, entity, fieldName = 'pressure_psi', rawFields = ['raw_adc_counts', 'raw_adc'], 
/** HP PT board (slot 2, board_id 22): wire raw is unsigned 0..2³¹ scale; LP PT uses signed ADS1262 codes. */
rawAdcUnsigned = false) {
    // CalibratedPTMessage (and TC/RTD/LC/ACT siblings): u64(0) ts + u8(8) ch + pad3(9-11) + float(12)
    // + u32(16) raw + u8(20). LP PT: C++ uses static_cast<uint32_t>(int32_t adc) — interpret as int32.
    // HP PT: C++ stores adc_u32 (4–20 mA); readInt32LE misreads codes ≥0x80000000 as negative → plot chaos.
    if (payload.length < RAW_SENSOR_PAYLOAD_SIZE)
        return [];
    const calibratedValue = payload.readFloatLE(12);
    if (!Number.isFinite(calibratedValue) || Number.isNaN(calibratedValue))
        return [];
    if (fieldName === 'pressure_psi' && (calibratedValue < -50 || calibratedValue > 10000))
        return [];
    // TC/RTD: allow cryogenic / high-temp lab sensors; calibration_service clamps before publish.
    // Reject only obvious garbage (e.g. polynomial blow-up misread as °C).
    if (fieldName === 'temperature_c' && (calibratedValue < -500 || calibratedValue > 10000))
        return [];
    if (fieldName === 'force_kg' && (calibratedValue < -10000 || calibratedValue > 50000))
        return [];
    const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
    const rawValue = rawAdcUnsigned ? payload.readUInt32LE(16) : payload.readInt32LE(16);
    const out = [{ entity, component: fieldName, value: calibratedValue, timestamp: tsMs }];
    for (const rawField of rawFields) {
        out.push({ entity, component: rawField, value: rawValue, timestamp: tsMs });
    }
    return out;
}
/**
 * Parse LC (Load Cell) Raw Message (21 bytes)
 * Layout: same as PT/TC raw — uint64_t (8) + uint8_t (1) + padding[3] (3) + uint32_t (4) + uint32_t (4) + uint8_t (1)
 * Entity names match FSW DatabaseConfig: LC1.CH1 .. LC2.CH6
 */
export function parseRawLCMessage(payload, packetId) {
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
export function parseElodinPacket(packetId, payload, entityMaps) {
    const [high, low] = packetId;
    // ── Generic sensor type decoder ──────────────────────────────────────────
    // New packet ID scheme: low byte = (board_number - 1) * 0x20 + channel (raw)
    //                                   (board_number - 1) * 0x20 + 0x10 + channel (calibrated)
    // Each board gets a 32-slot block. Within a block:
    //   0x01-0x0A = raw channels 1-10
    //   0x11-0x1A = calibrated channels 1-10
    // Helper to decode board_number and channel from low byte
    const decodeLow = (low) => {
        const blockOffset = low & 0x1F; // position within 32-slot block
        const isRaw = blockOffset < 0x10;
        const boardNumber = (low >> 5) + 1;
        const channel = blockOffset & 0x0F;
        return { boardNumber, channel, isRaw };
    };
    // ── PT: [0x20, ...] ──────────────────────────────────────────────────────
    // Board slot 2 (board_id …22) = HP 4–20 mA PTs: unsigned ADC full-scale to 2³¹ (see FSW convert_hp_pt_to_pressure).
    // Other PT boards: signed ADS1262-style codes.
    if (high === 0x20 && low >= 0x01) {
        const { boardNumber, channel, isRaw } = decodeLow(low);
        if (channel >= 1 && channel <= 10) {
            const hpPtSlot = boardNumber === 2;
            if (isRaw) {
                const r = parseRawSensorPayload(payload, channel, `PT${boardNumber}.CH${channel}`, 'raw_adc_counts', !hpPtSlot);
                return r ? [r] : [];
            }
            else {
                const r = parseCalibratedSensorPayload(payload, channel, `PT${boardNumber}_Cal.CH${channel}`, 'pressure_psi', ['raw_adc_counts', 'raw_adc'], hpPtSlot);
                return r;
            }
        }
    }
    // ── TC: [0x21, ...] ──────────────────────────────────────────────────────
    if (high === 0x21 && low >= 0x01) {
        const { boardNumber, channel, isRaw } = decodeLow(low);
        if (channel >= 1 && channel <= 10) {
            if (isRaw) {
                const r = parseRawSensorPayload(payload, channel, `TC${boardNumber}.CH${channel}`, 'raw_adc_counts', true);
                return r ? [r] : [];
            }
            else {
                const r = parseCalibratedSensorPayload(payload, channel, `TC${boardNumber}_Cal.CH${channel}`, 'temperature_c');
                return r;
            }
        }
    }
    // ── RTD: [0x22, ...] ─────────────────────────────────────────────────────
    if (high === 0x22 && low >= 0x01) {
        const { boardNumber, channel, isRaw } = decodeLow(low);
        if (channel >= 1 && channel <= 10) {
            if (isRaw) {
                const r = parseRawSensorPayload(payload, channel, `RTD${boardNumber}.CH${channel}`, 'raw_resistance_counts');
                return r ? [r] : [];
            }
            else {
                const r = parseCalibratedSensorPayload(payload, channel, `RTD${boardNumber}_Cal.CH${channel}`, 'temperature_c', ['raw_resistance_counts', 'raw_adc_counts', 'raw_adc']);
                return r;
            }
        }
    }
    // ── LC: [0x23, ...] ──────────────────────────────────────────────────────
    if (high === 0x23 && low >= 0x01) {
        const { boardNumber, channel, isRaw } = decodeLow(low);
        if (channel >= 1 && channel <= 10) {
            if (isRaw) {
                const r = parseRawSensorPayload(payload, channel, `LC${boardNumber}.CH${channel}`, 'raw_adc_counts', true);
                return r ? [r] : [];
            }
            else {
                const r = parseCalibratedSensorPayload(payload, channel, `LC${boardNumber}_Cal.CH${channel}`, 'force_kg');
                return r;
            }
        }
    }
    // ── Encoder: [0x24, ...] ──────────────────────────────────────────────────
    if (high === 0x24 && low >= 0x01) {
        const { boardNumber, channel, isRaw } = decodeLow(low);
        if (channel >= 1 && channel <= 10) {
            const r = parseRawSensorPayload(payload, channel, `ENC${boardNumber}.CH${channel}`, 'raw_angle');
            return r ? [r] : [];
        }
    }
    // ── Actuator raw: [0x30, ...] ─────────────────────────────────────────────
    if (high === 0x30 && low >= 0x01) {
        const { boardNumber, channel, isRaw } = decodeLow(low);
        if (channel >= 1 && channel <= 10) {
            if (isRaw) {
                const r = parseRawSensorPayload(payload, channel, `ACT${boardNumber}.CH${channel}`, 'raw_adc_counts');
                return r ? [r] : [];
            }
            else {
                const r = parseCalibratedSensorPayload(payload, channel, `ACT${boardNumber}_Cal.CH${channel}`, 'current_a');
                return r;
            }
        }
    }
    // ── Actuator cal/state: [0x31, ...] ────────────────────────────────────────
    // Calibrated current_a uses the same 21-byte calibrated payload convention with
    // low-byte calibrated offsets (+0x10). Actuator state uses the compact 10-byte
    // payload on raw offsets.
    if (high === 0x31 && low >= 0x01) {
        const { boardNumber, channel, isRaw } = decodeLow(low);
        if (channel >= 1 && channel <= 10) {
            if (!isRaw && payload.length >= RAW_SENSOR_PAYLOAD_SIZE) {
                return parseCalibratedSensorPayload(payload, channel, `ACT${boardNumber}_Cal.CH${channel}`, 'current_a');
            }
            if (isRaw && payload.length >= 10) {
                const state = payload.readUInt8(9);
                const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
                return [{ entity: `ACT${boardNumber}.CH${channel}`, component: 'actuator_state', value: state, timestamp: tsMs }];
            }
        }
    }
    // ── Actuator commanded state: [0x32, ...] ─────────────────────────────────
    // Published by sequencer_service when it commands actuators.
    // Layout: u64 timestamp_ns | u8 channel_id | u8 actuator_state (0=closed, 1=open) = 10 bytes
    // Low byte uses (board_number - 1) * 0x20 + channel
    if (high === 0x32 && low >= 0x01 && payload.length >= 10) {
        const { boardNumber, channel } = decodeLow(low);
        const state = payload.readUInt8(9);
        const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
        return [{ entity: `ACT_CMD.B${boardNumber}.CH${channel}`, component: 'actuator_state_commanded', value: state, timestamp: tsMs }];
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
        const fields = [
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
    // ── SequencerState: [0x50, 0x00] — 17 bytes (u32 @12 aligned; docs/adding-sensor-streams.md)
    if (high === 0x50 && low === 0x00 && payload.length >= 17) {
        const tsMs = Number(payload.readBigUInt64LE(0) / 1000000n);
        const stateVal = payload.readUInt8(8);
        const allowedBitmask = payload.readUInt32LE(12);
        const debugMode = payload.readUInt8(16);
        return [
            { entity: '_SEQUENCER_STATE', component: 'state', value: stateVal, timestamp: tsMs },
            { entity: '_SEQUENCER_STATE', component: 'allowedBitmask', value: allowedBitmask, timestamp: tsMs },
            { entity: '_SEQUENCER_STATE', component: 'debugMode', value: debugMode, timestamp: tsMs },
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
        console.debug(`[Elodin] Unmapped packet id=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}] ` +
            `payloadLen=${payload.length}`);
    }
    return [];
}
