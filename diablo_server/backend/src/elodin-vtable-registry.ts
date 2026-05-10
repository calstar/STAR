/**
 * Elodin DB — VTable registration and VTableStream subscriptions
 *
 * Single source of truth for thin backend + relay: config-driven stream IDs,
 * deduplicated subscriptions, calibrated-stream retry (Elodin drops subs before
 * tables exist), and instrumentation-friendly logging.
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { readConfig } from './routes/config.js';

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

// ── VTableStream subscriptions (board-namespaced IDs, config + fallbacks) ───

/** Subscribed [high,low] keys — avoids duplicate subs on 5s retry (duplicate delivery / inflated rates). */
const subscribedVTableStreamPairs = new Set<string>();

/** Call on Elodin disconnect so the next connect re-sends all streams cleanly. */
export function clearSubscriptionState(): void {
    subscribedVTableStreamPairs.clear();
}

/**
 * Build packet IDs to subscribe: config.toml boards (32-slot low-byte scheme) + dev fallbacks +
 * controller / sequencer / heartbeat / self-test / calibration command.
 */
function buildVTableStreamSubscriptionList(): Array<[number, number]> {
    const subscriptions: Array<[number, number]> = [];
    const seen = new Set<string>();
    const addUnique = (high: number, low: number): void => {
        const key = `${high},${low}`;
        if (!seen.has(key)) {
            seen.add(key);
            subscriptions.push([high, low]);
        }
    };

    const addBoard = (typeHi: number, boardNumber: number, channels: number[]): void => {
        for (const ch of channels) {
            addUnique(typeHi, (boardNumber - 1) * 0x20 + ch);
            addUnique(typeHi, (boardNumber - 1) * 0x20 + 0x10 + ch);
        }
    };

    /** ACT raw [0x30, …] vs calibrated current [0x31, raw_lo+0x10] — same low-byte scheme as PT but separate high byte (calibration_main.cpp). */
    const addActuatorBoard = (boardNumber: number, channels: number[]): void => {
        for (const ch of channels) {
            const rawLo = (boardNumber - 1) * 0x20 + ch;
            const calLo = (boardNumber - 1) * 0x20 + 0x10 + ch;
            addUnique(0x30, rawLo);
            addUnique(0x31, calLo);
        }
    };

    try {
        const cfg = readConfig();
        const boards = (cfg.boards || {}) as Record<string, unknown>;
        for (const [, raw] of Object.entries(boards)) {
            const b = raw as Record<string, unknown>;
            if (b.enabled === false) continue;
            const t = String(b.type ?? '').toUpperCase();
            const id = Number(b.board_id ?? b.id ?? 0);
            if (!Number.isFinite(id) || id <= 0) continue;
            const mod = id % 10;
            const boardNumberRaw = mod === 0 ? 10 : mod;
            const boardNumber = ((boardNumberRaw - 1) % 8) + 1;
            const n = Number(b.num_sensors ?? 0);
            const rawConnectors = Array.isArray(b.active_connectors) && (b.active_connectors as unknown[]).length > 0
                ? (b.active_connectors as unknown[])
                : Array.isArray(b.active_connections) && (b.active_connections as unknown[]).length > 0
                    ? (b.active_connections as unknown[])
                    : [];
            const active = rawConnectors.length > 0
                ? rawConnectors.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 1 && x <= 10)
                : n > 0
                    ? Array.from({ length: Math.min(10, n) }, (_, i) => i + 1)
                    : [];
            if (active.length === 0) continue;

            const typeHi =
                t === 'PT' ? 0x20
                    : t === 'TC' ? 0x21
                        : t === 'RTD' ? 0x22
                            : t === 'LC' ? 0x23
                                : t === 'ENC' || t === 'ENCODER' ? 0x24
                                    : t === 'ACTUATOR' ? 0x30
                                        : -1;
            if (t === 'ACTUATOR') {
                addActuatorBoard(boardNumber, active);
                continue;
            }
            if (typeHi < 0) continue;
            addBoard(typeHi, boardNumber, active);
        }
    } catch (e) {
        console.warn('[VTableStream] config-driven subscriptions failed, using fallbacks only:', e);
    }

    addBoard(0x20, 1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    addBoard(0x20, 2, [1, 2, 3, 4]);
    addActuatorBoard(2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    addActuatorBoard(4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    addBoard(0x21, 1, [2, 3, 4, 5]);
    addBoard(0x22, 1, [1, 2, 3, 4]);
    addBoard(0x23, 2, [1, 2, 6]);
    addBoard(0x24, 1, [1, 2]);

    for (let bn = 1; bn <= 4; bn++) {
        for (let ch = 1; ch <= 10; ch++) {
            addUnique(0x32, (bn - 1) * 0x20 + ch);
        }
    }

    [
        [0x40, 0x00], [0x41, 0x00], [0x42, 0x00], [0x43, 0x00], [0x44, 0x00],
        [0x50, 0x00],
        [0x50, 0x60], [0x50, 0x61], [0x50, 0x62], [0x50, 0x63], [0x50, 0x64], [0x50, 0x65], [0x50, 0x66],
    ].forEach(([h, l]) => addUnique(h, l));

    // Heartbeats [0x10, board_id] use the low byte as config board_id.
    // Self-test uses [0x60+sensor_id, board_id] — one VTable per sensor per board.
    for (let i = 1; i <= 255; i++) {
        addUnique(0x10, i);
        for (let s = 0x60; s <= 0x6F; s++) addUnique(s, i);
    }

    addUnique(0x46, 0x00);

    return subscriptions;
}

/**
 * Register VTableStream interest with Elodin (MSG to VTableStream). DAQ/calibration
 * services own VTableMsg schema registration; we only subscribe to packet IDs.
 */
export async function registerVTables(client: ElodinClient): Promise<boolean> {
    if (!client.isConnected()) {
        console.warn('⚠️ Cannot subscribe VTableStreams — Elodin client not connected');
        return false;
    }

    console.log('📡 VTableStream subscriptions (config + fallbacks)...');

    try {
        const subscriptions = buildVTableStreamSubscriptionList();
        const vtableStreamMsgId = computeMsgId('VTableStream');
        console.log(`   VTableStream msg_id: [0x${vtableStreamMsgId[0].toString(16).padStart(2, '0')}, 0x${vtableStreamMsgId[1].toString(16).padStart(2, '0')}]`);

        // Do NOT clear subscribedVTableStreamPairs here — calling registerVTables every 5s
        // (via scheduleResubscribe) would otherwise re-send all 276 subscriptions, causing
        // Elodin to replay all stored data on every retry and flooding the event loop.
        // Subscriptions are only cleared on disconnect (clearSubscriptionState), so each
        // retry only sends subscriptions not yet successfully sent this connection.

        let successCount = 0;
        let skippedCount = 0;
        for (const [high, low] of subscriptions) {
            const key = `${high},${low}`;
            if (subscribedVTableStreamPairs.has(key)) {
                skippedCount++;
                continue;
            }
            const payload = Buffer.alloc(2);
            payload.writeUInt8(high, 0);
            payload.writeUInt8(low, 1);
            const ok = client.sendRawMessage(vtableStreamMsgId, ElodinPacketType.MSG, payload);
            if (ok) {
                subscribedVTableStreamPairs.add(key);
                successCount++;
                if (successCount <= 5) {
                    console.log(`   ✅ VTableStream subscription sent: [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
                }
            } else {
                console.error(`   ❌ VTableStream send failed: [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
            }
        }

        console.log(`   ✅ VTableStream: sent ${successCount} new, skipped ${skippedCount} already subscribed (${subscriptions.length} total)`);
        console.log('   (Heartbeats [0x10] and sensor rows are TABLE packets once daq_bridge / calibration_service publish.)');
        return successCount > 0;
    } catch (error) {
        console.error('❌ VTableStream subscription error:', error);
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
        { hi: 0x23, prefix: 'LC', unit: 'force_kg' }
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
