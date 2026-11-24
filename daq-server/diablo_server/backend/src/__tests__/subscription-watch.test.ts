/**
 * D-SUB detection (#23, issue #227): table-id collisions in config, and an accepted subscription
 * that never delivers being flagged, shown stale, recovered by a reconnect, and cleared.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: any[] = [];
vi.mock('../server/ws-clients.js', () => ({ broadcast: (m: any) => { sent.push(m); } }));
vi.mock('../routes/config.js', () => ({ readConfig: () => ({}), readDeployedConfig: () => ({}) }));

const watch = await import('../server/subscription-watch.js');
const registry = await import('../elodin-vtable-registry.js');
const { isAlertRaised, clearAlert } = await import('../server/notifications.js');
const { STALE_MS, TABLE_ID_COLLISION_ALERT_KEY: COLLISION, STALE_SUBSCRIPTION_ALERT_KEY: STALE } = watch;

const pt = (board_id: number, active_connectors: number[]) =>
  ({ type: 'PT', board_id, ip: `127.0.0.${board_id}`, active_connectors, enabled: true });

const alerts = (key: string) => sent.filter((m) => m.payload?.key === key).map((m) => m.payload.ongoing);

/** Enough of ElodinClient for the registry and the watch: every subscription is accepted. */
function fakeClient() {
  const c = new EventEmitter() as any;
  c.connected = true;
  c.isConnected = () => c.connected;
  c.sendRawMessage = vi.fn(() => true);
  c.flushSubscriptionRequests = vi.fn(async () => {});
  c.disconnect = vi.fn(() => { c.connected = false; });
  c.connect = vi.fn(async () => { c.connected = true; return true; });
  return c;
}

let now = 1_000_000;
beforeEach(() => {
  registry.setClockForTests(() => now);
  registry.clearSubscriptionState();
  watch.resetSubscriptionWatch();
  for (const k of [COLLISION, STALE]) clearAlert(k);
  sent.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('table-id collision check', () => {
  it('finds the slot-10 wrap onto PT2 (board 60 vs board 22), raw and calibrated', () => {
    const cfg = { boards: { pt_board_2: pt(22, [1, 2]), integration_startup: pt(60, [1]) } };
    const c = watch.tableIdCollisions(watch.tableEntries(cfg));
    expect(c.map((x) => watch.pairLabel(x.key)).sort()).toEqual(['[0x20,0x21]', '[0x20,0x31]']);
    const cal = c.find((x) => x.key === `${0x20},${0x31}`)!;
    expect(cal.entities.map((e) => e.entity).sort()).toEqual(['PT10_Cal.CH1', 'PT2_Cal.CH1']);
  });

  it('finds two boards on one slot, and a duplicated board_id', () => {
    // 12 and 22 are both slot 2: PT2.CH1 claimed by two boards.
    const slot = watch.tableIdCollisions(watch.tableEntries({ boards: { a: pt(12, [1]), b: pt(22, [1]) } }));
    expect(slot.map((x) => watch.pairLabel(x.key)).sort()).toEqual(['[0x20,0x21]', '[0x20,0x31]']);
    const dup = watch.tableIdCollisions(watch.tableEntries({ boards: { a: pt(22, [1]), b: { ...pt(22, [3]), type: 'TC' } } }));
    expect(dup.map((x) => watch.pairLabel(x.key))).toEqual(['[0x10,0x16]']); // the heartbeat
    // PT and TC tables on one slot have different high bytes: no collision.
    expect(watch.tableIdCollisions(watch.tableEntries({ boards: { a: pt(11, [1]), b: { ...pt(21, [1]), type: 'TC' } } }))).toEqual([]);
  });

  it('a clean config has none, and the check raises then clears the alert', () => {
    expect(watch.checkTableIdCollisions({ boards: { a: pt(21, [1, 2]), b: pt(22, [1, 2]) } }, 1)).toEqual([]);
    expect(isAlertRaised(COLLISION)).toBe(false);
    const bad = { boards: { pt_board_2: pt(22, [1]), integration_startup: pt(60, [1]) } };
    expect(watch.checkTableIdCollisions(bad, 2)).toHaveLength(2);
    expect(watch.checkTableIdCollisions(bad, 3)).toHaveLength(2); // deduped: one raise
    expect(isAlertRaised(COLLISION)).toBe(true);
    watch.checkTableIdCollisions({ boards: { a: pt(21, [1]) } }, 4);
    expect(alerts(COLLISION)).toEqual([true, false]);
  });
});

describe('per-channel liveness (D-SUB)', () => {
  const cfg = { boards: { pt_board_2: pt(22, [1, 2]) } };
  const RAW1 = [0x20, 0x21], RAW2 = [0x20, 0x22], CAL1 = [0x20, 0x31], CAL2 = [0x20, 0x32];
  const deliver = (...pairs: number[][]) => { for (const [h, l] of pairs) registry.notePairDelivered(h, l); };

  /** Run the stand for `ms`, delivering `pairs` and checking once a second. */
  function run(client: any, ms: number, pairs: number[][]) {
    for (const end = now + ms; now < end;) {
      now += 1000;
      deliver(...pairs);
      watch.checkSubscriptionLiveness(client, now, cfg);
    }
  }

  it('flags a calibrated channel silent while its raw sibling delivers, reconnects, then clears', async () => {
    const client = fakeClient();
    await registry.registerVTables(client, cfg); // every pair accepted: CAL1's binding is dead

    run(client, STALE_MS - 1000, [RAW1, RAW2, CAL2]);
    expect(watch.staleChannels()).toEqual([]); // inside the grace period
    run(client, 2000, [RAW1, RAW2, CAL2]);
    expect(watch.staleChannels()).toEqual(['PT2_Cal.CH1']);
    expect(alerts(STALE)).toEqual([true]);
    expect(client.disconnect).toHaveBeenCalledTimes(1); // the existing whole-connection remedy
    expect(client.connect).toHaveBeenCalledTimes(1);

    // The reconnect's fresh pass binds CAL1 to the live registration, and it delivers.
    await registry.registerVTables(client, cfg);
    run(client, 1000, [RAW1, RAW2, CAL2]);
    expect(watch.staleChannels()).toEqual(['PT2_Cal.CH1']); // still shown stale until it delivers
    run(client, 1000, [RAW1, RAW2, CAL1, CAL2]);
    expect(watch.staleChannels()).toEqual([]);
    expect(alerts(STALE)).toEqual([true, false]);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rate-limits the reconnect and gives up after MAX_RECOVERIES', async () => {
    const client = fakeClient();
    await registry.registerVTables(client, cfg);
    for (let i = 0; i < 6; i++) {
      run(client, 15_000, [RAW1, RAW2, CAL2]);
      if (!client.isConnected()) { await client.connect(); }
      if (registry.pairSubscribedAtMs(`${0x20},${0x31}`) === undefined) await registry.registerVTables(client, cfg);
    }
    expect(client.disconnect).toHaveBeenCalledTimes(watch.MAX_RECOVERIES);
    expect(watch.staleChannels()).toEqual(['PT2_Cal.CH1']);
    expect(isAlertRaised(STALE)).toBe(true);
  });

  it('does not flag anything while calibration_service is down (no calibrated table delivers)', async () => {
    const client = fakeClient();
    await registry.registerVTables(client, cfg);
    run(client, 30_000, [RAW1, RAW2]);
    expect(watch.staleChannels()).toEqual([]);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('does not flag a channel whose raw sibling is silent too (its board is off)', async () => {
    const client = fakeClient();
    await registry.registerVTables(client, cfg);
    run(client, 30_000, [RAW2, CAL2]);
    expect(watch.staleChannels()).toEqual([]);
  });

  it('flags a channel that delivered and then stopped while its raw goes on', async () => {
    const client = fakeClient();
    await registry.registerVTables(client, cfg);
    run(client, 3000, [RAW1, RAW2, CAL1, CAL2]);
    run(client, STALE_MS + 2000, [RAW1, RAW2, CAL2]);
    expect(watch.staleChannels()).toEqual(['PT2_Cal.CH1']);
  });
});
