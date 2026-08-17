/**
 * Per-board "scan rate" estimate for thin server: average update rate (Hz) of primary
 * raw channel streams as received from Elodin (relay ingest), **before** the WebSocket
 * throttle. Interpreting that average as ~samples/sec per channel when the DAQ cycles all
 * channels together (common case).
 */

import { performance } from 'node:perf_hooks';

const RATE_WINDOW_MS = 3000;
const MAX_TIMESTAMPS = 200;
const EMA_ALPHA = 0.3;
const STALE_MS = 120_000;

/** groupId -> channelEntity -> timestamps (performance.now ms) */
const groupChannelTs = new Map<string, Map<string, number[]>>();
const groupChannelEma = new Map<string, Map<string, number>>();
const groupChannelLastWall = new Map<string, Map<string, number>>();
let lastPrune = 0;

/**
 * A board-scan group key. PT boards get a per-board key `pt<n>` (n = board_number = board_id % 10),
 * so any number of PT boards is supported; other sensor types are aggregated per-type.
 */
export type BoardScanGroupId = string;

/**
 * Calibrated Elodin packets carry raw_adc_counts on *Cal entities (e.g. PT1_Cal.CH1),
 * not PT1.CH1. Raw-only packets use PT1.CH1. Both must count toward board scan rate.
 * PT boards map to a per-board group `pt<n>` (n from the entity prefix) so a 3rd/Nth PT
 * board is grouped like any other. Exported for the integration test's per-group breakdown.
 */
export function mapEntityToGroup(entity: string): BoardScanGroupId | null {
  const pt = entity.match(/^PT(\d+)(?:_Cal)?\.CH/);
  if (pt) return `pt${pt[1]}`;
  if (/^TC\d+(_Cal)?\.CH/.test(entity)) return 'tc';
  if (/^RTD\d+(_Cal)?\.CH/.test(entity)) return 'rtd';
  if (/^LC\d+(_Cal)?\.CH/.test(entity)) return 'lc';
  if (/^ACT\d+(_Cal)?\.CH/.test(entity)) return 'act';
  if (/^ENC\d+(_Cal)?\.CH/.test(entity)) return 'enc';
  return null;
}

/**
 * True for the single canonical component of a physical channel sample (one match
 * per sample row). Exported so server stats can count ingested samples 1:1 against
 * the simulator's sent-sample ground truth in the integration test.
 */
export function isPrimaryPhysicalStream(entity: string, component: string): boolean {
  if (component === 'raw_adc_counts') {
    return /^PT\d+(_Cal)?\.CH|^TC\d+(_Cal)?\.CH|^LC\d+(_Cal)?\.CH|^ACT\d+(_Cal)?\.CH/.test(entity);
  }
  if (component === 'raw_resistance_counts') {
    return /^RTD\d+(_Cal)?\.CH/.test(entity);
  }
  if (component === 'raw_angle') {
    return /^ENC\d+(_Cal)?\.CH/.test(entity);
  }
  return false;
}

function hzForTimestamps(ts: number[]): number {
  if (ts.length < 2) return 0;
  const now = performance.now();
  const cutoff = now - RATE_WINDOW_MS;
  let start = 0;
  while (start < ts.length && ts[start] < cutoff) start++;
  const recent = ts.length - start;
  if (recent < 2) return 0;
  const span = ts[ts.length - 1] - ts[start];
  if (span <= 0) return 0;
  return ((recent - 1) / span) * 1000;
}

function emaForKey(group: string, channel: string, rawHz: number): number {
  let m = groupChannelEma.get(group);
  if (!m) {
    m = new Map();
    groupChannelEma.set(group, m);
  }
  const prev = m.get(channel) ?? rawHz;
  const smoothed = EMA_ALPHA * rawHz + (1 - EMA_ALPHA) * prev;
  m.set(channel, smoothed);
  return smoothed;
}

/**
 * Call once per parsed physical sensor update from the relay, **before** WS throttle drops
 * or defers broadcasts.
 */
export function recordBoardScanIngest(entity: string, component: string): void {
  if (!isPrimaryPhysicalStream(entity, component)) return;
  const group = mapEntityToGroup(entity);
  if (!group) return;

  const now = performance.now();
  let channels = groupChannelTs.get(group);
  if (!channels) {
    channels = new Map();
    groupChannelTs.set(group, channels);
  }
  let arr = channels.get(entity);
  if (!arr) {
    arr = [];
    channels.set(entity, arr);
  }
  arr.push(now);
  const cutoff = now - RATE_WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  while (arr.length > MAX_TIMESTAMPS) arr.shift();
  let wall = groupChannelLastWall.get(group);
  if (!wall) {
    wall = new Map();
    groupChannelLastWall.set(group, wall);
  }
  wall.set(entity, Date.now());

  const hz = hzForTimestamps(arr);
  emaForKey(group, entity, hz);

  if (Date.now() - lastPrune > 60_000) {
    lastPrune = Date.now();
    const cutoffWall = Date.now() - STALE_MS;
    for (const [g, chMap] of groupChannelTs) {
      const lw = groupChannelLastWall.get(g);
      for (const ch of [...chMap.keys()]) {
        const t = lw?.get(ch) ?? 0;
        if (t < cutoffWall) {
          chMap.delete(ch);
          lw?.delete(ch);
          groupChannelEma.get(g)?.delete(ch);
        }
      }
    }
  }
}

function averageGroupHz(group: BoardScanGroupId): number {
  const ema = groupChannelEma.get(group);
  if (!ema || ema.size === 0) return 0;
  let sum = 0;
  for (const v of ema.values()) sum += v;
  return sum / ema.size;
}

/**
 * Snapshot for GET /api/debug — Hz per board group from relay ingest (pre-throttle).
 * Dynamic: one entry per group that has seen data — `pt<n>` per PT board plus the
 * aggregated `tc`/`rtd`/`lc`/`act`/`enc`. Consumers should default a missing group to 0.
 */
export function getBoardScanRateHz(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const group of groupChannelEma.keys()) {
    out[group] = averageGroupHz(group);
  }
  return out;
}
