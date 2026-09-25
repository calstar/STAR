/**
 * Elodin VTableStream subscriptions: attribution, convergence, and list sanity.
 *
 * The bug these exist for, seen live on 2026-09-16: a session started and the GUI showed no
 * data. Boards → DB was healthy and the calibration service had registered and was publishing;
 * raw entities reached the browser while EVERY calibrated entity (PT*_Cal, LC*_Cal) was absent
 * for the whole session.
 *
 * Cause: the wire request id is one byte (elodin-client writes `requestId & 0xff` at offset 7),
 * so 1..255 is the entire space. registerVTables sent 4485 subscriptions per pass while rotating
 * ids over that space, so `pendingSubscriptionReqIds` was overwritten ~17x and, after a pass,
 * described only the last 255 pairs sent. Every rejection was attributed to the wrong pair:
 *
 *   - the genuinely refused table stayed marked subscribed and was NEVER retried, and
 *   - an innocent, already-delivering table was un-marked and re-subscribed, which spawns a
 *     second DB stream task and doubles its rate ([0x46,0x00] was re-sent 849 times in 4 hours).
 *
 * The list was also ~20x too big: a blanket 1..255 x 17 sweep for heartbeat/self-test tables
 * that daq_bridge only ever registers for boards present in the config.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    buildVTableStreamSubscriptionList,
    registerVTables,
    noteSubscriptionRejected,
    notePairDelivered,
    clearSubscriptionState,
    setClockForTests,
    SUBSCRIPTION_REQ_ID_SPACE,
    MAX_PAIR_ATTEMPTS,
} from '../elodin-vtable-registry.js';

// ── A fake DB client: isConnected + sendRawMessage is the whole surface used ──
interface Sent { high: number; low: number; reqId: number }

function fakeClient(sent: Sent[], failPairs: Set<string> = new Set()) {
    return {
        isConnected: () => true,
        sendRawMessage: (_msgId: [number, number], _ty: number, payload: Buffer, reqId: number) => {
            const high = payload.readUInt8(0);
            const low = payload.readUInt8(1);
            if (failPairs.has(`${high},${low}`)) return false;
            sent.push({ high, low, reqId });
            return true;
        },
    } as never;
}

/** The deployed shape in miniature: two PT boards, an actuator board, an LC board. */
const CONFIG = {
    boards: {
        pt_board: { type: 'PT', board_id: 21, enabled: true, active_connectors: [1, 2] },
        pt_board_2: { type: 'PT', board_id: 22, enabled: true, active_connectors: [1, 4] },
        act_board: { type: 'ACTUATOR', board_id: 12, enabled: true, active_connectors: [1, 2] },
        lc_board: { type: 'LC', board_id: 41, enabled: true, active_connectors: [1] },
    },
};

let clock = 1_000_000;
beforeEach(() => {
    clearSubscriptionState();
    clock = 1_000_000;
    setClockForTests(() => clock);
});

const keyOf = (s: Sent) => `${s.high},${s.low}`;

/** Run passes until nothing is queued. A pass is capped at the id space by design, so the
 *  full list takes a couple of passes — that is the cap working, not a failure. */
async function drain(sent: Sent[], failPairs?: Set<string>): Promise<void> {
    for (let i = 0; i < 20; i++) {
        const res = await registerVTables(fakeClient(sent, failPairs));
        if (res.remaining === 0) return;
    }
    throw new Error('subscriptions never drained');
}
const reqIdFor = (sent: Sent[], high: number, low: number) =>
    sent.find((s) => s.high === high && s.low === low)?.reqId;

describe('request id attribution', () => {
    it('never gives one in-flight id to two different pairs', async () => {
        const sent: Sent[] = [];
        await registerVTables(fakeClient(sent));

        // Ids restart per window; within any window an id must name exactly one pair.
        for (let i = 0; i < sent.length; i += SUBSCRIPTION_REQ_ID_SPACE) {
            const window = sent.slice(i, i + SUBSCRIPTION_REQ_ID_SPACE);
            const ids = window.map((s) => s.reqId);
            expect(new Set(ids).size).toBe(window.length);
        }
    });

    it('never issues an id outside the one-byte wire space', async () => {
        const sent: Sent[] = [];
        await registerVTables(fakeClient(sent));
        for (const s of sent) {
            expect(s.reqId).toBeGreaterThanOrEqual(1);
            expect(s.reqId).toBeLessThanOrEqual(SUBSCRIPTION_REQ_ID_SPACE);
        }
    });
});

describe('a refused subscription is actually retried', () => {
    it('re-sends the calibrated PT pair that was rejected (the no-data bug)', async () => {
        const first: Sent[] = [];
        await registerVTables(fakeClient(first));

        // PT1 CH1 calibrated — one of the first pairs sent, and exactly the family that went
        // missing on the stand. Under the old rotation its id resolved to a tail self-test
        // pair, so this pair was never re-sent for the life of the connection.
        const id = reqIdFor(first, 0x20, 0x11);
        expect(id, 'PT1_Cal.CH1 must be in the subscription list').toBeDefined();

        noteSubscriptionRejected(id!, 'invalid msg id');
        clock += 10_000; // past the first backoff

        const second: Sent[] = [];
        await registerVTables(fakeClient(second));
        expect(second.map(keyOf)).toContain('32,17'); // [0x20, 0x11]
    });

    it('holds a rejected pair until its backoff expires, then retries it', async () => {
        const first: Sent[] = [];
        await registerVTables(fakeClient(first));
        const id = reqIdFor(first, 0x20, 0x11)!;
        noteSubscriptionRejected(id, 'invalid msg id');

        const tooSoon: Sent[] = [];
        await registerVTables(fakeClient(tooSoon));
        expect(tooSoon.map(keyOf)).not.toContain('32,17');

        clock += 10_000;
        const later: Sent[] = [];
        await registerVTables(fakeClient(later));
        expect(later.map(keyOf)).toContain('32,17');
    });
});

describe('a live table is never re-subscribed', () => {
    it('ignores a rejection naming a pair the DB is delivering', async () => {
        const first: Sent[] = [];
        await drain(first);

        const id = reqIdFor(first, 0x46, 0x00);
        expect(id, 'the calibration command table must be subscribed').toBeDefined();

        // The DB is streaming this table — so this rejection cannot belong to it.
        notePairDelivered(0x46, 0x00);
        noteSubscriptionRejected(id!, 'invalid msg id');
        clock += 120_000;

        const second: Sent[] = [];
        await registerVTables(fakeClient(second));
        expect(second.map(keyOf)).not.toContain('70,0'); // [0x46, 0x00]
    });
});

describe('retries converge', () => {
    it('parks a pair nothing publishes instead of resending it forever', async () => {
        const sent: Sent[] = [];
        await registerVTables(fakeClient(sent));
        const target: [number, number] = [0x20, 0x11];

        let resends = 0;
        for (let pass = 0; pass < 40; pass++) {
            const passSent: Sent[] = [];
            await registerVTables(fakeClient(passSent));
            const id = reqIdFor(passSent, target[0], target[1]);
            if (id !== undefined) {
                resends++;
                noteSubscriptionRejected(id, 'invalid msg id');
            }
            clock += 120_000; // always past backoff, so only parking can stop it
        }

        expect(resends).toBeLessThan(MAX_PAIR_ATTEMPTS + 2);

        // And once parked it stays parked.
        const after: Sent[] = [];
        await registerVTables(fakeClient(after));
        expect(after.map(keyOf)).not.toContain('32,17');
    });

    it('sends nothing once everything is subscribed', async () => {
        await drain([]);
        const second: Sent[] = [];
        const res = await registerVTables(fakeClient(second));
        expect(second).toHaveLength(0);
        expect(res.sent).toBe(0);
        expect(res.remaining).toBe(0);
    });

    it('caps a pass at the request-id space and queues the rest', async () => {
        const sent: Sent[] = [];
        const res = await registerVTables(fakeClient(sent));
        expect(sent.length).toBeLessThanOrEqual(SUBSCRIPTION_REQ_ID_SPACE);
        if (res.remaining > 0) expect(sent.length).toBe(SUBSCRIPTION_REQ_ID_SPACE);
    });
});

describe('the subscription list only holds tables a publisher registers', () => {
    it('covers heartbeat and self-test for configured board ids only', () => {
        const pairs = buildVTableStreamSubscriptionList(CONFIG);
        const has = (h: number, l: number) => pairs.some(([a, b]) => a === h && b === l);

        // Heartbeat [0x10, board_id] uses the RAW config id, not the %10 slot.
        expect(has(0x10, 21)).toBe(true);
        expect(has(0x10, 12)).toBe(true);
        expect(has(0x10, 41)).toBe(true);
        // Self-test [0x60+sensor, board_id].
        expect(has(0x60, 21)).toBe(true);
        expect(has(0x6f, 41)).toBe(true);

        // Boards that are not in the config must not be swept in. These are the 4114 pairs
        // that were refused on every pass forever and overflowed the request-id space.
        expect(has(0x10, 0xff)).toBe(false);
        expect(has(0x6f, 0xfd)).toBe(false);
        expect(has(0x10, 99)).toBe(false);
    });

    it('is small enough that the whole list is attributable', () => {
        const pairs = buildVTableStreamSubscriptionList(CONFIG);
        // The old list was 4485. Anything near that cannot be correlated with one-byte ids.
        expect(pairs.length).toBeLessThan(600);
    });

    it('does not invent sensors the config never declared', () => {
        const pairs = buildVTableStreamSubscriptionList(CONFIG);
        const has = (h: number, l: number) => pairs.some(([a, b]) => a === h && b === l);
        // The dev fallback used to add LC board 2 channels 2 and 6 unconditionally, while the
        // config here declares active_connectors = [1].
        expect(has(0x23, 0x22)).toBe(false); // LC2 CH2 calibrated
        expect(has(0x23, 0x26)).toBe(false); // LC2 CH6 calibrated
    });

    it('still falls back to the dev list when the config yields no boards', () => {
        const pairs = buildVTableStreamSubscriptionList({ boards: {} });
        const has = (h: number, l: number) => pairs.some(([a, b]) => a === h && b === l);
        expect(has(0x20, 0x11)).toBe(true);
        expect(pairs.length).toBeGreaterThan(100);
    });

    it('has no duplicate pairs', () => {
        const pairs = buildVTableStreamSubscriptionList(CONFIG);
        expect(new Set(pairs.map(([h, l]) => `${h},${l}`)).size).toBe(pairs.length);
    });
});

describe('reconnect starts from a clean slate', () => {
    it('clearSubscriptionState forgets backoff, parking and delivery', async () => {
        const first: Sent[] = [];
        await drain(first);
        const id = reqIdFor(first, 0x20, 0x11)!;
        noteSubscriptionRejected(id, 'invalid msg id');
        notePairDelivered(0x46, 0x00);

        clearSubscriptionState();

        // Everything is due again after a reconnect — the DB process is new.
        const second: Sent[] = [];
        await drain(second);
        expect(second.map(keyOf)).toContain('32,17');
        expect(second.map(keyOf)).toContain('70,0');
    });
});
