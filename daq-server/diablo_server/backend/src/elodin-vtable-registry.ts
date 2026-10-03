/**
 * Elodin DB — VTable registration and VTableStream subscriptions
 *
 * Single source of truth for thin backend + relay: config-driven stream IDs,
 * deduplicated subscriptions, calibrated-stream retry (Elodin drops subs before
 * tables exist), and instrumentation-friendly logging.
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { readDeployedConfig } from './routes/config.js';

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

// VTable *schema* registration used to live here (encodeVTable + the controller and
// actuator-commanded tables). It was dead in both senses: nothing called it, and the
// bytes it produced were rejected by elodin-db — 5x "postcard Serde Deserialization
// Error" for the controller tables, 20x "Hit the end of buffer" for the actuator ones.
// The "✅ Registered" it logged only ever meant socket.write() returned true. The C++
// services own schema registration; this module only subscribes to packet ids.

// ── VTableStream subscriptions (board-namespaced IDs, config + fallbacks) ───

/** Subscribed [high,low] keys — avoids duplicate subs on 5s retry.
 *
 *  Duplicate delivery is a REAL hazard here and the reason this set exists: the DB spawns
 *  a fresh stream task per VTableStream message with no dedupe, so re-subscribing a live
 *  table doubles its rate. What is NOT a hazard, despite an earlier comment here, is
 *  replay — handle_vtable_stream's RealTimeStage waits on the next write and sends only
 *  latest(), so a subscribe never re-sends stored history. Verified against elodin-db.
 *
 *  That distinction is what makes retry safe: a REJECTED subscription spawned no stream,
 *  so re-sending it cannot duplicate anything. Rejected pairs are removed from this set by
 *  noteSubscriptionRejected() and re-sent by the next scheduled pass. */
function freshSubscriptionState() {
    return {
        subscribed: new Set<string>(),
        pending: new Map<number, string>(),
        running: null as Promise<boolean> | null,
    };
}
let subscriptionState = freshSubscriptionState();

/** Call on Elodin disconnect so the next connect re-sends all streams cleanly. */
export function clearSubscriptionState(): void {
    subscriptionState = freshSubscriptionState();
}

/**
 * Handle an ErrorResponse from the DB (ElodinClient 'dbError').
 *
 * The startup race this exists for: the backend subscribes to everything the moment it
 * connects, but the pipeline services register their VTables when THEY start — the
 * sequencer registered _SEQUENCER_STATE 3 s after the backend had already subscribed to
 * it. The DB answers "invalid msg id" and drops the subscription; nothing retried, so the
 * GUI froze on a stale state for the rest of the session while sensor data flowed
 * perfectly. Un-marking the pair lets the existing resubscribe pass pick it up once the
 * table exists.
 */
export function noteSubscriptionRejected(requestId: number, description: string): void {
    const key = subscriptionState.pending.get(requestId);
    if (key === undefined) return;
    subscriptionState.pending.delete(requestId);
    if (!subscriptionState.subscribed.delete(key)) return;
    const [high, low] = key.split(',').map(Number);
    console.warn(
        `[Elodin] subscription refused for [0x${high.toString(16).padStart(2, '0')}, ` +
        `0x${low.toString(16).padStart(2, '0')}]: ${description} — will retry ` +
        '(the publisher has probably not registered its VTable yet)',
    );
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
        // Cached: this runs on every Elodin connect and on up to 24 resubscribe retries per
        // connection, so a plain readConfig() here was a repeated file read + TOML parse on a
        // reconnect storm. Invalidated at deploy.
        const cfg = readDeployedConfig();
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
            // active_connectors (active_connections is the older spelling) is the only
            // statement of which channels exist. No 1..num_sensors fallback: a board with an
            // empty list samples nothing, so registering entities for it would invent sensors.
            const rawConnectors = Array.isArray(b.active_connectors) && (b.active_connectors as unknown[]).length > 0
                ? (b.active_connectors as unknown[])
                : Array.isArray(b.active_connections)
                    ? (b.active_connections as unknown[])
                    : [];
            const active = rawConnectors.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 1 && x <= 10);
            if (active.length === 0) continue;

            if (t === 'ENVIRONMENTAL') {
                if (Number.isInteger(id) && id <= 255 && active.includes(1)) addUnique(0x25, id);
                continue;
            }

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
export function registerVTables(client: ElodinClient): Promise<boolean> {
    const state = subscriptionState;
    if (state.running) return state.running;
    state.running = subscribeVTables(client, state).finally(() => { state.running = null; });
    return state.running;
}

async function subscribeVTables(client: ElodinClient, state: ReturnType<typeof freshSubscriptionState>): Promise<boolean> {
    if (!client.isConnected()) {
        console.warn('⚠️ Cannot subscribe VTableStreams — Elodin client not connected');
        return false;
    }

    console.log('📡 VTableStream subscriptions (config + fallbacks)...');

    try {
        const subscriptions = buildVTableStreamSubscriptionList();
        const vtableStreamMsgId = computeMsgId('VTableStream');
        console.log(`   VTableStream msg_id: [0x${vtableStreamMsgId[0].toString(16).padStart(2, '0')}, 0x${vtableStreamMsgId[1].toString(16).padStart(2, '0')}]`);

        // Request IDs are one byte. Use 1..254 once per batch, reserving 255 for an
        // ordered fence. Do not reuse IDs until all errors from that batch arrived.
        // Successful subscriptions stay deduplicated even if their table is quiet.

        let successCount = 0;
        let skippedCount = 0;
        let requestId = 1;
        const flush = async () => {
            await client.flushSubscriptionRequests();
            state.pending.clear();
            requestId = 1;
        };
        for (const [high, low] of subscriptions) {
            if (state !== subscriptionState || !client.isConnected()) return false;
            const key = `${high},${low}`;
            if (state.subscribed.has(key)) {
                skippedCount++;
                continue;
            }
            const payload = Buffer.alloc(2);
            payload.writeUInt8(high, 0);
            payload.writeUInt8(low, 1);
            const reqId = requestId++;
            state.pending.set(reqId, key);
            state.subscribed.add(key);
            const ok = client.sendRawMessage(vtableStreamMsgId, ElodinPacketType.MSG, payload, reqId);
            if (ok) {
                successCount++;
                if (successCount <= 5) {
                    console.log(`   ✅ VTableStream subscription sent: [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
                }
            } else {
                throw new Error(`VTableStream send failed: [${high}, ${low}]`);
            }
            if (requestId === 255) await flush();
        }
        if (requestId > 1) await flush();

        console.log(`   ✅ VTableStream: sent ${successCount} new, skipped ${skippedCount} already subscribed (${subscriptions.length} total)`);
        console.log('   (Heartbeats [0x10] and sensor rows are TABLE packets once daq_bridge / calibration_service publish.)');
        return successCount > 0;
    } catch (error) {
        console.error('❌ VTableStream subscription error:', error);
        // A missing fence leaves acceptance ambiguous. Close the connection (and
        // its stream tasks) before retrying; never guess using a timeout alone.
        if (state === subscriptionState) {
            clearSubscriptionState();
            client.disconnect();
        }
        return false;
    }
}
