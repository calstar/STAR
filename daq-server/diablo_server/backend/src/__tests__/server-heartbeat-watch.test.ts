/**
 * C6-3 (issue #233): the backend watches the loopback copy of SERVER_HEARTBEAT and raises the
 * keyed alert `server_heartbeat_lost` when none has arrived for SERVER_HEARTBEAT_LOST_MS, then
 * clears it when the heartbeat resumes. Before this nothing on the host noticed a dead sender.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dgram from 'dgram';

const sent: any[] = [];
vi.mock('../server/ws-clients.js', () => ({ broadcast: (m: any) => { sent.push(m); } }));
vi.mock('../routes/config.js', () => ({ readConfig: () => ({ server_heartbeat: { monitor_port: 0 } }) }));

const hb = await import('../server/server-heartbeat.js');
const { isAlertRaised } = await import('../server/notifications.js');
const { SERVER_HEARTBEAT_LOST_MS: LOST, SERVER_HEARTBEAT_ALERT_KEY: KEY } = hb;

// type 2, version 0, timestamp_ms u32 LE, engine_state: what heartbeat_service sends.
const packet = Buffer.from([0x02, 0x00, 0x78, 0x56, 0x34, 0x12, 0x00]);
const alerts = () => sent.filter((m) => m.payload?.key === KEY).map((m) => m.payload.ongoing);

beforeEach(() => {
  // A key left raised by a previous case: clear it through the watch's own path.
  if (isAlertRaised(KEY)) hb.noteServerHeartbeat(packet, 0);
  hb.resetServerHeartbeatWatch();
  sent.length = 0;
});

describe('server heartbeat watch', () => {
  it('raises nothing before the first heartbeat (the watch arms on first sight)', () => {
    hb.checkServerHeartbeat(10 * LOST);
    expect(alerts()).toEqual([]);
  });

  it('stays quiet while heartbeats arrive inside the threshold', () => {
    for (let t = 0; t <= 5 * LOST; t += 200) {
      hb.noteServerHeartbeat(packet, t);
      hb.checkServerHeartbeat(t + 100);
    }
    expect(alerts()).toEqual([]);
  });

  it('raises once when the heartbeat stops for longer than the threshold, and clears when it resumes', () => {
    hb.noteServerHeartbeat(packet, 1000);
    hb.checkServerHeartbeat(1000 + LOST);          // exactly the threshold: not yet
    expect(alerts()).toEqual([]);
    hb.checkServerHeartbeat(1000 + LOST + 1);
    hb.checkServerHeartbeat(1000 + LOST + 500);    // deduped by key
    hb.checkServerHeartbeat(1000 + 10 * LOST);
    expect(alerts()).toEqual([true]);
    expect(isAlertRaised(KEY)).toBe(true);
    const raised = sent.find((m) => m.payload?.key === KEY).payload;
    expect(raised.category).toBe('error');
    expect(raised.message).toMatch(/^Server heartbeat lost/);

    hb.noteServerHeartbeat(packet, 1000 + 11 * LOST);
    hb.noteServerHeartbeat(packet, 1000 + 11 * LOST + 200);
    expect(alerts()).toEqual([true, false]);
    expect(isAlertRaised(KEY)).toBe(false);
  });

  it('ignores datagrams that are not a SERVER_HEARTBEAT', () => {
    hb.noteServerHeartbeat(packet, 0);
    expect(hb.noteServerHeartbeat(Buffer.from([0x04, 0, 0, 0, 0, 0, 0]), LOST)).toBe(false); // ACTUATOR_COMMAND
    expect(hb.noteServerHeartbeat(Buffer.from([0x02, 0x00]), LOST)).toBe(false);              // short
    hb.checkServerHeartbeat(LOST + 1);
    expect(alerts()).toEqual([true]);
  });

  it('monitor_port 0 in config turns the watch off', () => {
    expect(hb.serverHeartbeatMonitorPort()).toBe(0);
    expect(hb.startServerHeartbeatWatch(0)).toBeNull();
  });
});

describe('the loopback socket', () => {
  let sock: dgram.Socket | null = null;
  afterEach(() => { sock?.close(); sock = null; });

  it('a heartbeat sent to the monitor port reaches the watch, and silence then raises the alert', async () => {
    // A free port: bind 0, read it, release it.
    const probe = dgram.createSocket('udp4');
    await new Promise<void>((r) => probe.bind(0, '127.0.0.1', () => r()));
    const port = probe.address().port;
    await new Promise<void>((r) => probe.close(() => r()));

    sock = hb.startServerHeartbeatWatch(port);
    await new Promise<void>((r) => sock!.once('listening', () => r()));
    const tx = dgram.createSocket('udp4');
    await new Promise<void>((r, j) => tx.send(packet, port, '127.0.0.1', (e) => (e ? j(e) : r())));
    tx.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(alerts()).toEqual([]);
    // Nothing more is sent: once the threshold and a check period pass, the alert is up.
    await new Promise((r) => setTimeout(r, LOST + hb.SERVER_HEARTBEAT_CHECK_MS + 300));
    expect(alerts()).toEqual([true]);
  }, 10_000);
});
