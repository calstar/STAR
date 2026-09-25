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
const subscribedVTableStreamPairs = new Set<string>();

/** requestId → pair key, for subscriptions whose reply has not come back yet.
 *
 *  Holds exactly one pass's ids, and a pass never sends more than the id space. The wire
 *  request id is a single byte
 *  (elodin-client.ts writes `requestId & 0xff` at offset 7 and reads it back with readUInt8),
 *  so 1..255 is the entire space — it cannot be widened without changing the DB protocol.
 *  This used to be a counter rotating over that space while the pass sent 4485 subscriptions,
 *  so the map was overwritten ~17x and, once a pass finished, described only the LAST 255
 *  pairs sent. Every rejection was therefore attributed to the wrong pair: the genuinely
 *  refused table stayed marked as subscribed and was never retried (silent for the whole
 *  session — this is the "started a session, no data" bug), while an innocent table was
 *  un-marked and re-subscribed. registerVTables now caps a pass at SUBSCRIPTION_REQ_ID_SPACE
 *  and queues the remainder, so an id in flight names exactly one pair. */
const pendingSubscriptionReqIds = new Map<number, string>();

/** One wire byte, so this is the whole id space — see pendingSubscriptionReqIds. */
export const SUBSCRIPTION_REQ_ID_SPACE = 255;
/** Attempts before a pair is parked as "no publisher is ever going to register this". */
export const MAX_PAIR_ATTEMPTS = 12;

/** Pairs the DB has actually delivered a packet for. A table cannot be streaming and
 *  refusing its own subscription at the same time, so a rejection naming one of these is
 *  provably a misattribution — and re-sending it would spawn a SECOND stream task for a live
 *  table, doubling its rate (the hazard documented above). Guarding on delivery makes that
 *  structurally impossible rather than merely unlikely. */
const deliveredPairs = new Set<string>();
/** Rejected pairs awaiting a retry, with their backoff. */
const rejectedPairs = new Map<string, { attempts: number; nextAttemptMs: number }>();
/** Pairs that exhausted MAX_PAIR_ATTEMPTS — stop asking, and stop logging about it. */
const parkedPairs = new Set<string>();
/** Rejections seen since the last pass logged a summary, so one line replaces thousands. */
let refusalsSinceLastPass = 0;
const refusedPairsSinceLastPass = new Set<string>();

/** Injectable clock, so backoff is testable without fake timers fighting the await. */
let nowFn: () => number = () => Date.now();
export function setClockForTests(fn: () => number): void {
    nowFn = fn;
}

/** Backoff for attempt n: 5s, 10s, 20s, 40s, then 60s. */
function backoffMs(attempts: number): number {
    return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

/** Record that the DB delivered a packet for this pair. */
export function notePairDelivered(high: number, low: number): void {
    deliveredPairs.add(`${high},${low}`);
}

/** Call on Elodin disconnect so the next connect re-sends all streams cleanly. */
export function clearSubscriptionState(): void {
    subscribedVTableStreamPairs.clear();
    pendingSubscriptionReqIds.clear();
    deliveredPairs.clear();
    rejectedPairs.clear();
    parkedPairs.clear();
    refusalsSinceLastPass = 0;
    refusedPairsSinceLastPass.clear();
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
    const key = pendingSubscriptionReqIds.get(requestId);
    if (key === undefined) return;
    pendingSubscriptionReqIds.delete(requestId);

    // A pair the DB is actively streaming cannot also be refusing its subscription, so this
    // reply belongs to some other pair whose id we no longer hold. Dropping it costs nothing;
    // acting on it would un-mark a live table and re-subscribe it, doubling its delivery rate.
    if (deliveredPairs.has(key)) return;

    if (!subscribedVTableStreamPairs.delete(key)) return;

    const state = rejectedPairs.get(key) ?? { attempts: 0, nextAttemptMs: 0 };
    state.attempts += 1;
    state.nextAttemptMs = nowFn() + backoffMs(state.attempts);
    rejectedPairs.set(key, state);

    refusalsSinceLastPass += 1;
    refusedPairsSinceLastPass.add(key);

    if (state.attempts >= MAX_PAIR_ATTEMPTS) {
        parkedPairs.add(key);
        rejectedPairs.delete(key);
        const [high, low] = key.split(',').map(Number);
        console.warn(
            `[Elodin] giving up on [0x${high.toString(16).padStart(2, '0')}, ` +
            `0x${low.toString(16).padStart(2, '0')}] after ${state.attempts} attempts: ` +
            `${description} — no publisher registers this table`,
        );
    }
}

/** Drain the per-pass refusal tally, so registerVTables can log one line instead of thousands. */
function takeRefusalSummary(): { count: number; pairs: string[] } {
    const out = { count: refusalsSinceLastPass, pairs: [...refusedPairsSinceLastPass] };
    refusalsSinceLastPass = 0;
    refusedPairsSinceLastPass.clear();
    return out;
}

/**
 * Build packet IDs to subscribe: config.toml boards (32-slot low-byte scheme) + dev fallbacks +
 * controller / sequencer / heartbeat / self-test / calibration command.
 */
export function buildVTableStreamSubscriptionList(cfgIn?: unknown): Array<[number, number]> {
    const subscriptions: Array<[number, number]> = [];
    const seen = new Set<string>();
    /** Raw config board_id values — the low byte of heartbeat and self-test tables. NOT the
     *  `% 10` slot used by sensor tables: daq_bridge registers those two per config board id. */
    const configBoardIds: number[] = [];
    /** Config actuator boards, for the commanded-state tables below. */
    const actuatorBoards: Array<{ boardNumber: number; channels: number[] }> = [];
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
        const cfg = (cfgIn ?? readDeployedConfig()) as { boards?: unknown };
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
            // Heartbeat/self-test are registered per CONFIG board id, whatever the type.
            configBoardIds.push(id);

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
                actuatorBoards.push({ boardNumber, channels: active });
                continue;
            }
            if (typeHi < 0) continue;
            addBoard(typeHi, boardNumber, active);
        }
    } catch (e) {
        console.warn('[VTableStream] config-driven subscriptions failed, using fallbacks only:', e);
    }

    // Dev fallbacks ONLY when the config told us nothing. They used to run unconditionally,
    // alongside a perfectly good config, which invented sensors the deployed rig does not have
    // — addBoard(0x23, 2, [1, 2, 6]) subscribes LC2 CH2 and CH6 where the config declares
    // active_connectors = [1]. Every such pair is refused forever and, before the windowing
    // below, each refusal corrupted the attribution of a real one.
    if (configBoardIds.length === 0) {
        addBoard(0x20, 1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        addBoard(0x20, 2, [1, 2, 3, 4]);
        addActuatorBoard(2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        addActuatorBoard(4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        addBoard(0x21, 1, [2, 3, 4, 5]);
        addBoard(0x22, 1, [1, 2, 3, 4]);
        addBoard(0x23, 2, [1, 2, 6]);
        addBoard(0x24, 1, [1, 2]);
    }

    // Actuator commanded state [0x32, …], same low-byte scheme as the raw table.
    if (actuatorBoards.length > 0) {
        for (const { boardNumber, channels } of actuatorBoards) {
            for (const ch of channels) addUnique(0x32, (boardNumber - 1) * 0x20 + ch);
        }
    } else {
        for (let bn = 1; bn <= 4; bn++) {
            for (let ch = 1; ch <= 10; ch++) addUnique(0x32, (bn - 1) * 0x20 + ch);
        }
    }

    [
        [0x40, 0x00], [0x41, 0x00], [0x42, 0x00], [0x43, 0x00], [0x44, 0x00],
        [0x50, 0x00],
        [0x50, 0x60], [0x50, 0x61], [0x50, 0x62], [0x50, 0x63], [0x50, 0x64], [0x50, 0x65], [0x50, 0x66],
    ].forEach(([h, l]) => addUnique(h, l));

    // Heartbeats [0x10, board_id] use the low byte as config board_id.
    // Self-test uses [0x60+sensor_id, board_id] — one VTable per sensor per board.
    //
    // Over the CONFIGURED board ids only. This used to sweep 1..255 x 17 high bytes = 4335
    // pairs, but daq_bridge registers these two families only for boards that are in the
    // config, so with 13 boards exactly 221 of those 4335 can ever exist and the other 4114
    // are refused on every single pass, forever. That bulk is what overflowed the one-byte
    // request id space and broke rejection attribution for the real tables.
    const heartbeatBoardIds = configBoardIds.length > 0
        ? configBoardIds
        : Array.from({ length: 255 }, (_, i) => i + 1);
    for (const id of heartbeatBoardIds) {
        addUnique(0x10, id);
        for (let s = 0x60; s <= 0x6F; s++) addUnique(s, id);
    }

    addUnique(0x46, 0x00);

    return subscriptions;
}

/**
 * Register VTableStream interest with Elodin (MSG to VTableStream). DAQ/calibration
 * services own VTableMsg schema registration; we only subscribe to packet IDs.
 */
export interface SubscriptionPassResult {
    sent: number;
    skipped: number;
    parked: number;
    /** Pairs due this pass that did not fit in the request-id space; send them next pass. */
    remaining: number;
    /** Earliest backoff deadline still outstanding, or null when nothing is waiting. */
    nextAttemptMs: number | null;
}

export async function registerVTables(client: ElodinClient): Promise<SubscriptionPassResult> {
    const empty: SubscriptionPassResult = { sent: 0, skipped: 0, parked: parkedPairs.size, remaining: 0, nextAttemptMs: null };
    if (!client.isConnected()) {
        console.warn('⚠️ Cannot subscribe VTableStreams — Elodin client not connected');
        return empty;
    }

    try {
        const subscriptions = buildVTableStreamSubscriptionList();
        const vtableStreamMsgId = computeMsgId('VTableStream');

        // Do NOT clear subscribedVTableStreamPairs here — this runs every few seconds, and
        // re-sending a live subscription spawns a SECOND DB stream task for that table.
        // Pairs are cleared only on disconnect (clearSubscriptionState).
        const now = nowFn();
        const due: Array<[number, number]> = [];
        let skippedCount = 0;
        for (const [high, low] of subscriptions) {
            const key = `${high},${low}`;
            if (subscribedVTableStreamPairs.has(key) || parkedPairs.has(key)) {
                skippedCount++;
                continue;
            }
            const backoff = rejectedPairs.get(key);
            if (backoff && backoff.nextAttemptMs > now) {
                skippedCount++;
                continue;
            }
            due.push([high, low]);
        }

        // At most one id-space worth of subscriptions per pass, and the ids stay pinned to
        // their pairs for the WHOLE pass. An id in flight therefore names exactly one pair,
        // which is the property that makes a rejection attributable at all.
        //
        // Anything over the limit waits for the next pass rather than reusing a live id. That
        // is the whole fix: the old code sent all 4485 in one go, rotating ids over 255, so
        // 4230 of them were unattributable by construction. A remainder costs one extra pass;
        // reusing an id costs a table that is never retried.
        const batch = due.slice(0, SUBSCRIPTION_REQ_ID_SPACE);
        const remaining = due.length - batch.length;
        pendingSubscriptionReqIds.clear();
        let successCount = 0;
        let reqId = 1;
        for (const [high, low] of batch) {
            const key = `${high},${low}`;
            const payload = Buffer.alloc(2);
            payload.writeUInt8(high, 0);
            payload.writeUInt8(low, 1);
            const thisId = reqId++;
            pendingSubscriptionReqIds.set(thisId, key);
            const ok = client.sendRawMessage(vtableStreamMsgId, ElodinPacketType.MSG, payload, thisId);
            if (ok) {
                subscribedVTableStreamPairs.add(key);
                successCount++;
            } else {
                pendingSubscriptionReqIds.delete(thisId);
                console.error(`   ❌ VTableStream send failed: [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
            }
        }

        // One aggregated line. Per-rejection warns produced 1.1M journal lines in four hours.
        const refused = takeRefusalSummary();
        if (refused.count > 0) {
            const sample = refused.pairs.slice(0, 5)
                .map((k) => { const [h, l] = k.split(',').map(Number); return `[0x${h.toString(16).padStart(2, '0')}, 0x${l.toString(16).padStart(2, '0')}]`; })
                .join(' ');
            console.warn(
                `[Elodin] ${refused.count} subscription refusal(s) over ${refused.pairs.length} pair(s) ` +
                `since the last pass — will retry with backoff. First: ${sample}` +
                (parkedPairs.size > 0 ? ` (${parkedPairs.size} parked)` : ''),
            );
        }

        let nextAttemptMs: number | null = null;
        for (const s of rejectedPairs.values()) {
            if (nextAttemptMs === null || s.nextAttemptMs < nextAttemptMs) nextAttemptMs = s.nextAttemptMs;
        }

        if (successCount > 0) {
            console.log(
                `📡 VTableStream: sent ${successCount} new, skipped ${skippedCount}` +
                (remaining > 0 ? `, ${remaining} queued for the next pass` : '') +
                ` (${subscriptions.length} total, ${parkedPairs.size} parked)`,
            );
        }
        return { sent: successCount, skipped: skippedCount, parked: parkedPairs.size, remaining, nextAttemptMs };
    } catch (error) {
        console.error('❌ VTableStream subscription error:', error);
        return empty;
    }
}
