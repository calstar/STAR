/**
 * VTable Registration for Elodin DB
 *
 * Consolidated from legacy/elodin-vtable.ts and legacy/elodin-vtable-controller.ts.
 * Registers VTables and VTableStream subscriptions so Elodin DB streams
 * TABLE packets to connected clients.
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';

// ── FNV-1a hash (matching db.hpp msg_id) ────────────────────────────────────

/**
 * Compute FNV-1a hash for message type name (matching db.hpp fnv1a_hash_32).
 * Returns [low_byte, high_byte] of the 16-bit XOR-folded hash.
 */
export function computeMsgId(typeName: string): [number, number] {
    const FNV_OFFSET_BASIS = 0x811c9dc5;
    const FNV_PRIME = 0x01000193;

    let hash = FNV_OFFSET_BASIS;
    const maxLen = Math.min(typeName.length, 31);

    for (let i = 0; i < maxLen; i++) {
        hash ^= typeName.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }

    const upper = (hash >>> 16) & 0xFFFF;
    const lower = hash & 0xFFFF;
    const xorHash = upper ^ lower;

    return [xorHash & 0xFF, (xorHash >>> 8) & 0xFF];
}

// ── VTable binary encoding ──────────────────────────────────────────────────

interface VTableFieldDef {
    offset: number;
    size: number;
    type: string;
    component: string;
}

function encodeVTable(config: {
    packetId: [number, number];
    fields: VTableFieldDef[];
}): Buffer {
    const buffer = Buffer.alloc(1024);
    let off = 0;

    buffer.writeUInt8(config.packetId[0], off++);
    buffer.writeUInt8(config.packetId[1], off++);
    buffer.writeUInt8(config.fields.length, off++);

    const typeMap: Record<string, number> = {
        u64: 0, f64: 1, f32: 2, u32: 3, i32: 4, u8: 5,
    };

    for (const field of config.fields) {
        buffer.writeUInt32LE(field.offset, off); off += 4;
        buffer.writeUInt32LE(field.size, off); off += 4;
        buffer.writeUInt8(typeMap[field.type] ?? 0, off++);
        const componentBytes = Buffer.from(field.component, 'utf-8');
        buffer.writeUInt8(componentBytes.length, off++);
        componentBytes.copy(buffer, off);
        off += componentBytes.length;
    }

    return buffer.subarray(0, off);
}

// ── VTableStream subscriptions ──────────────────────────────────────────────

/**
 * Subscribe to all known VTableStream packet IDs.
 * Elodin DB will begin streaming TABLE packets for each subscription.
 */
export async function subscribeToVTables(client: ElodinClient): Promise<boolean> {
    if (!client.isConnected()) {
        console.warn('⚠️ Cannot subscribe - Elodin client not connected');
        return false;
    }

    console.log('📡 Sending VTableStream subscriptions...');

    try {
        const subscriptions: Array<[number, number]> = [
            // PT Raw 1–14 + Cal 0x11–0x1E
            ...range(0x20, 0x01, 0x0E), ...range(0x20, 0x11, 0x1E),
            // TC Raw/Cal 1–20 + 0x11–0x24
            ...range(0x21, 0x01, 0x14), ...range(0x21, 0x11, 0x24),
            // RTD Raw/Cal 1–20 + 0x11–0x24
            ...range(0x22, 0x01, 0x14), ...range(0x22, 0x11, 0x24),
            // LC Raw/Cal 1–20 + 0x11–0x24
            ...range(0x23, 0x01, 0x14), ...range(0x23, 0x11, 0x24),
            // Encoder Raw/Cal 1–14
            ...range(0x24, 0x01, 0x0E), ...range(0x24, 0x11, 0x1E),
            // Actuator feedback (Raw) + state (Cal) 1–20
            ...range(0x30, 0x01, 0x14), ...range(0x31, 0x01, 0x14),
            // Actuator Commanded (0x32)
            ...range(0x32, 0x01, 0x14),
            // Controller: actuation, diagnostics, measurement, state, fire
            [0x40, 0x00], [0x41, 0x00], [0x42, 0x00], [0x43, 0x00], [0x44, 0x00],
            // Sequencer state
            [0x50, 0x00],
            // Heartbeats 1–64
            ...range(0x10, 0x01, 0x40),
            // Self-test results 1–64
            ...range(0x60, 0x01, 0x40),
        ];

        const vtableStreamMsgId = computeMsgId('VTableStream');
        let count = 0;
        for (const [high, low] of subscriptions) {
            const payload = Buffer.alloc(2);
            payload.writeUInt8(high, 0);
            payload.writeUInt8(low, 1);
            if (client.sendRawMessage(vtableStreamMsgId, ElodinPacketType.MSG, payload)) count++;
        }
        console.log(`   ✅ VTableStream: ${count}/${subscriptions.length} subscriptions sent`);
        return count > 0;
    } catch (e) {
        console.error('❌ VTableStream error:', e);
        return false;
    }
}

/**
 * Register RAW and CALIBRATED sensor VTables with Elodin DB.
 * Matches FSW/src/elodin/DatabaseConfig.cpp schemas exactly.
 */
export async function registerSensorVTables(
    client: ElodinClient,
    ptMap: Record<number, string>,
    actMap: Record<number, string>
): Promise<boolean> {
    if (!client.isConnected()) return false;
    console.log('📡 Registering Sensor VTables (Raw + Cal)...');
    const vtableMsgId = computeMsgId('VTableMsg');
    let count = 0;

    const strip = (s: string) => s.includes('.') ? s.split('.').slice(1).join('.') : s;

    // PT Raw (0x20, 1-14) + Cal (0x20, 0x11-0x1E)
    for (let ch = 1; ch <= 14; ch++) {
        const name = strip(ptMap[ch] || `CH${ch}`);
        // Raw: 21 bytes
        const vtRaw = encodeVTable({
            packetId: [0x20, ch],
            fields: [
                { offset: 0, size: 8, type: 'u64', component: `PT.${name}.timestamp_ns` },
                { offset: 8, size: 1, type: 'u8', component: `PT.${name}.channel_id` },
                { offset: 12, size: 4, type: 'u32', component: `PT.${name}.raw_adc_counts` },
                { offset: 16, size: 4, type: 'u32', component: `PT.${name}.sample_ts_ms` },
                { offset: 20, size: 1, type: 'u8', component: `PT.${name}.status` },
            ]
        });
        if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtRaw)) count++;

        // Cal: 21 bytes
        const vtCal = encodeVTable({
            packetId: [0x20, 0x10 + ch],
            fields: [
                { offset: 0, size: 8, type: 'u64', component: `PT_Cal.${name}.timestamp_ns` },
                { offset: 8, size: 1, type: 'u8', component: `PT_Cal.${name}.channel_id` },
                { offset: 12, size: 4, type: 'f32', component: `PT_Cal.${name}.pressure_psi` },
                { offset: 16, size: 4, type: 'u32', component: `PT_Cal.${name}.raw_adc` },
                { offset: 20, size: 1, type: 'u8', component: `PT_Cal.${name}.cal_status` },
            ]
        });
        if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtCal)) count++;
    }

    // Generic TC, RTD, LC (1-20)
    const types = [
        { hi: 0x21, prefix: 'TC', unit: 'temperature_c' },
        { hi: 0x22, prefix: 'RTD', unit: 'temperature_c' },
        { hi: 0x23, prefix: 'LC', unit: 'force_n' }
    ];
    for (const t of types) {
        for (let ch = 1; ch <= 20; ch++) {
            // Raw
            const vtRaw = encodeVTable({
                packetId: [t.hi, ch],
                fields: [
                    { offset: 0, size: 8, type: 'u64', component: `${t.prefix}.CH${ch}.timestamp_ns` },
                    { offset: 8, size: 1, type: 'u8', component: `${t.prefix}.CH${ch}.channel_id` },
                    { offset: 12, size: 4, type: 'u32', component: `${t.prefix}.CH${ch}.raw_adc_counts` },
                    { offset: 16, size: 4, type: 'u32', component: `${t.prefix}.CH${ch}.sample_ts_ms` },
                    { offset: 20, size: 1, type: 'u8', component: `${t.prefix}.CH${ch}.status` },
                ]
            });
            if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtRaw)) count++;

            // Cal
            const vtCal = encodeVTable({
                packetId: [t.hi, 0x10 + ch],
                fields: [
                    { offset: 0, size: 8, type: 'u64', component: `${t.prefix}_Cal.CH${ch}.timestamp_ns` },
                    { offset: 8, size: 1, type: 'u8', component: `${t.prefix}_Cal.CH${ch}.channel_id` },
                    { offset: 12, size: 4, type: 'f32', component: `${t.prefix}_Cal.CH${ch}.${t.unit}` },
                    { offset: 16, size: 4, type: 'u32', component: `${t.prefix}_Cal.CH${ch}.raw_adc` },
                    { offset: 20, size: 1, type: 'u8', component: `${t.prefix}_Cal.CH${ch}.cal_status` },
                ]
            });
            if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtCal)) count++;
        }
    }

    // Actuators (1-20)
    for (let ch = 1; ch <= 20; ch++) {
        const name = strip(actMap[ch] || `CH${ch}`);
        // Raw feedback (0x30): 21 bytes
        const vtRaw = encodeVTable({
            packetId: [0x30, ch],
            fields: [
                { offset: 0, size: 8, type: 'u64', component: `ACT.${name}.timestamp_ns` },
                { offset: 8, size: 1, type: 'u8', component: `ACT.${name}.channel_id` },
                { offset: 12, size: 4, type: 'u32', component: `ACT.${name}.raw_adc_counts` },
                { offset: 16, size: 4, type: 'u32', component: `ACT.${name}.sample_ts_ms` },
                { offset: 20, size: 1, type: 'u8', component: `ACT.${name}.status` },
            ]
        });
        if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtRaw)) count++;

        // State (0x31): 10 bytes
        const vtState = encodeVTable({
            packetId: [0x31, ch],
            fields: [
                { offset: 0, size: 8, type: 'u64', component: `ACT.${name}.timestamp_ns` },
                { offset: 8, size: 1, type: 'u8', component: `ACT.${name}.channel_id` },
                { offset: 9, size: 1, type: 'u8', component: `ACT.${name}.actuator_state` },
            ]
        });
        if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtState)) count++;
    }

    console.log(`   Registered ${count} sensor VTables`);
    return count > 0;
}

// ── Controller VTable registration ──────────────────────────────────────────

export async function registerControllerVTables(client: ElodinClient): Promise<boolean> {
    if (!client.isConnected()) return false;
    console.log('📡 Registering controller VTables...');

    try {
        const vtableMsgId = computeMsgId('VTableMsg');

        const vtables = [
            {
                name: 'Actuation', vtable: encodeVTable({
                    packetId: [0x40, 0x00],
                    fields: [
                        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.actuation.timestamp_ns' },
                        { offset: 8, size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_F' },
                        { offset: 12, size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_O' },
                        { offset: 16, size: 1, type: 'u8', component: 'CONTROLLER.actuation.u_F_on' },
                        { offset: 17, size: 1, type: 'u8', component: 'CONTROLLER.actuation.u_O_on' },
                        { offset: 18, size: 1, type: 'u8', component: 'CONTROLLER.actuation.valid' },
                    ],
                })
            },
            {
                name: 'Diagnostics', vtable: encodeVTable({
                    packetId: [0x41, 0x00],
                    fields: [
                        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.diagnostics.timestamp_ns' },
                        { offset: 8, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.F_ref' },
                        { offset: 16, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.MR_ref' },
                        { offset: 24, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.F_estimated' },
                        { offset: 32, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.MR_estimated' },
                        { offset: 40, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.P_ch' },
                        { offset: 48, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.cost' },
                        { offset: 56, size: 4, type: 'i32', component: 'CONTROLLER.diagnostics.solver_iters' },
                        { offset: 60, size: 1, type: 'u8', component: 'CONTROLLER.diagnostics.safety_filtered' },
                        { offset: 61, size: 1, type: 'u8', component: 'CONTROLLER.diagnostics.cutoff_active' },
                    ],
                })
            },
            {
                name: 'Measurement', vtable: encodeVTable({
                    packetId: [0x42, 0x00],
                    fields: [
                        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.measurement.timestamp_ns' },
                        { offset: 8, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_copv' },
                        { offset: 16, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_reg' },
                        { offset: 24, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_fuel' },
                        { offset: 32, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_ox' },
                        { offset: 40, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_fuel' },
                        { offset: 48, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_ox' },
                        { offset: 56, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_ch_mp1' },
                        { offset: 64, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_ch_mp2' },
                    ],
                })
            },
            {
                name: 'StateTransition', vtable: encodeVTable({
                    packetId: [0x43, 0x00],
                    fields: [
                        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.state.timestamp_ns' },
                        { offset: 8, size: 1, type: 'u8', component: 'CONTROLLER.state.from_state' },
                        { offset: 9, size: 1, type: 'u8', component: 'CONTROLLER.state.to_state' },
                        { offset: 10, size: 1, type: 'u8', component: 'CONTROLLER.state.reason' },
                    ],
                })
            },
            {
                name: 'FireState', vtable: encodeVTable({
                    packetId: [0x44, 0x00],
                    fields: [
                        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.fire.timestamp_ns' },
                        { offset: 8, size: 1, type: 'u8', component: 'CONTROLLER.fire.fire_active' },
                        { offset: 9, size: 4, type: 'f32', component: 'CONTROLLER.fire.duty_F' },
                        { offset: 13, size: 4, type: 'f32', component: 'CONTROLLER.fire.duty_O' },
                    ],
                })
            },
            {
                name: 'SequencerState', vtable: encodeVTable({
                    packetId: [0x50, 0x00],
                    fields: [
                        { offset: 0, size: 8, type: 'u64', component: 'SEQUENCER.state.timestamp_ns' },
                        { offset: 8, size: 1, type: 'u8', component: 'SEQUENCER.state.current_state' },
                        { offset: 12, size: 4, type: 'u32', component: 'SEQUENCER.state.allowed_bitmask' },
                        { offset: 16, size: 1, type: 'u8', component: 'SEQUENCER.state.debug_mode' },
                    ],
                })
            },
        ];

        let count = 0;
        for (const { name, vtable } of vtables) {
            if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtable)) {
                count++;
                console.log(`   ✅ ${name}`);
            }
        }
        console.log(`   Registered ${count}/${vtables.length} controller VTables`);
        return count > 0;
    } catch (error) {
        console.error('❌ Controller VTable registration error:', error);
        return false;
    }
}

// ── Actuator Commanded VTables ──────────────────────────────────────────────

export async function registerActuatorCommandedVTables(
    client: ElodinClient,
    actuatorChannelToEntityMap: Record<number, string>,
): Promise<boolean> {
    if (!client.isConnected()) return false;
    const vtableMsgId = computeMsgId('VTableMsg');
    let count = 0;
    for (let ch = 1; ch <= 20; ch++) {
        const entity = actuatorChannelToEntityMap[ch] || `ACT.CH${ch}`;
        const vt = encodeVTable({
            packetId: [0x32, ch],
            fields: [
                { offset: 0, size: 8, type: 'u64', component: `${entity}.timestamp_ns` },
                { offset: 8, size: 1, type: 'u8', component: `${entity}.channel_id` },
                { offset: 9, size: 1, type: 'u8', component: `${entity}.actuator_state_commanded` },
            ],
        });
        if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vt)) {
            count++;
        }
    }
    if (count > 0) {
        console.log(`   ✅ Registered ${count} actuator commanded VTables [0x32]`);
    }
    return count > 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function range(high: number, lowStart: number, lowEnd: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let lo = lowStart; lo <= lowEnd; lo++) {
        out.push([high, lo]);
    }
    return out;
}
