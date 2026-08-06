#!/usr/bin/env tsx
/**
 * WS Rate Probe — quick eyeball check of the GUI stream downsampler.
 *
 * Connects to the backend WebSocket, collects SENSOR_UPDATE messages for a
 * fixed duration, and prints per-key stats: msgs/sec, value min/max, and the
 * span/ordering of payload timestamps. Use it to verify:
 *   - envelope mode: per-stream rate ≈ [gui] points_per_second, min AND max of
 *     spiky sim streams present, timestamps ascending epoch-ms
 *   - throttle mode: legacy ~20 msgs/sec per stream
 *
 * Usage: tsx test/ws_rate_probe.ts [ws_url] [seconds]
 *   defaults: ws://localhost:8081, 10 s
 * Example (from daq-server/, stack running):
 *   cd diablo_server/backend && npx tsx ../../test/ws_rate_probe.ts ws://localhost:8081 10
 */

import WebSocket from 'ws';

const WS_URL = process.argv[2] ?? 'ws://localhost:8081';
const SECONDS = Number(process.argv[3] ?? 10);

interface KeyStats {
  count: number;
  min: number;
  max: number;
  firstTs: number;
  lastTs: number;
  outOfOrder: number; // payload timestamps that went backwards
  prevTs: number;
}

const stats = new Map<string, KeyStats>();
let total = 0;
let nonEpochTs = 0; // payload timestamps implausibly far from Date.now()

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log(`Connected to ${WS_URL}; collecting SENSOR_UPDATE for ${SECONDS}s...`);
  setTimeout(() => { ws.close(); report(); }, SECONDS * 1000);
});

ws.on('message', (data: Buffer) => {
  let msg: any;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type !== 'sensor_update' || !msg.payload) return;
  const { entity, component, value, timestamp } = msg.payload;
  if (typeof value !== 'number' || typeof timestamp !== 'number') return;
  total++;
  if (Math.abs(timestamp - Date.now()) > 120_000) nonEpochTs++;

  const key = `${entity}.${component}`;
  let s = stats.get(key);
  if (!s) {
    s = { count: 0, min: Infinity, max: -Infinity, firstTs: timestamp, lastTs: timestamp, outOfOrder: 0, prevTs: timestamp };
    stats.set(key, s);
  }
  s.count++;
  if (value < s.min) s.min = value;
  if (value > s.max) s.max = value;
  if (timestamp < s.prevTs) s.outOfOrder++;
  s.prevTs = timestamp;
  s.lastTs = Math.max(s.lastTs, timestamp);
});

ws.on('error', (err) => {
  console.error(`WS error: ${err.message}`);
  process.exit(1);
});

function report(): void {
  const rows = Array.from(stats.entries()).sort((a, b) => b[1].count - a[1].count);
  console.log(`\nTotal SENSOR_UPDATE: ${total} (${(total / SECONDS).toFixed(1)}/s across ${rows.length} keys)`);
  if (nonEpochTs > 0) {
    console.log(`⚠️  ${nonEpochTs} payload timestamps were >120s from local clock (not epoch-ms?)`);
  }
  console.log('\nkey'.padEnd(45) + 'msg/s'.padStart(8) + 'min'.padStart(14) + 'max'.padStart(14) + 'ts span s'.padStart(10) + 'ooo'.padStart(5));
  for (const [key, s] of rows.slice(0, 40)) {
    console.log(
      key.padEnd(44)
      + (s.count / SECONDS).toFixed(1).padStart(8)
      + fmt(s.min).padStart(14)
      + fmt(s.max).padStart(14)
      + ((s.lastTs - s.firstTs) / 1000).toFixed(1).padStart(10)
      + String(s.outOfOrder).padStart(5),
    );
  }
  if (rows.length > 40) console.log(`... and ${rows.length - 40} more keys`);
  process.exit(0);
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '-';
  return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(3);
}
