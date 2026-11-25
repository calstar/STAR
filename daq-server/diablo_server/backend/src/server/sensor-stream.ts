/**
 * server/sensor-stream.ts — GUI downsampling and the two sample exits.
 *
 * Owns the `[gui]` stream config and the two envelope accumulators (assigned by initGuiStream(),
 * rebuilt by reloadGuiStreamConfig() at the deploy point), the per-key throttle gate of the
 * legacy "throttle" mode, and the two exits every sample leaves through: emitSensorPoint (event-
 * like streams, broadcast at once) and emitSensorWindow (downsampled streams: history first, then
 * each client's outbox). The pure envelope library stays in gui-stream.ts; this is the wiring.
 * publishSample() is the one entry for a finite row (step 2.1); the envelopes and the throttle
 * gate are private.
 *
 * Event-loop only. No effect at import (M1): the config read and its log line happen in
 * initGuiStream(), which server.ts calls at today's position (§1.2 row 2); the 50 ms flush timer
 * is registered by server.ts. Never imports api-server.ts or api/*.
 *
 * Contract: the 50 ms throttle and envelope flush, the window closing rules and the recording
 * of history before staging (so live data and backfill agree) are frozen in
 * pipeline/golden/ws_streams.txt (P2, P7, P8, T1) and __tests__/lc-tare.test.ts; the
 * "GUI downsampling" lines are startup-log order (G12).
 */

import {
  EnvelopeAccumulator, parseGuiStreamConfig, envelopeWindowMs, encoderWindowMs,
  type GuiStreamConfig, type EnvelopePoint,
} from '../gui-stream.js';
import { readConfig } from '../routes/config.js';
import { MessageType } from '../../../shared/types.js';
import type { SensorUpdate } from '../../../shared/types.js';
import type { ParsedSensorData } from '../elodin-protocol.js';
import { broadcast, clientStreams } from './ws-clients.js';
import { history } from './history.js';
import { stats } from './stats.js';

/** Min interval between WS SENSOR_UPDATE broadcasts for high-rate DAQ streams only.
 *  50 ms caps at ~20 Hz per key — comfortably passes 10 Hz sources even with
 *  network jitter and Date.now() quantization. */
export const BROADCAST_MIN_MS = 50;

/** Which rate budget a stream is downsampled against, or null to pass through.
 *
 *  'gui'     — PT/TC/RTD/LC raw+cal and actuator raw+state ([0x20]–[0x23],
 *              [0x30]–[0x31]), the bulk of the traffic.
 *  'encoder' — encoder ([0x24]). Given its OWN, much higher budget rather than
 *              the GUI one: OscopeTriggerPlot measures valve actuation timing
 *              from these (inter-encoder skew, plateau detection), and a 100 ms
 *              GUI window would quantize that measurement away. At the boards'
 *              ~48 Hz the encoder window holds ~1 sample, so min == max and
 *              points pass through untouched — this is a ceiling against a
 *              faster board being fitted later, not a downsample of today.
 *  null      — heartbeats ([0x10]), self-test ([0x60]), controller
 *              ([0x40]–[0x44]), sequencer/PSM ([0x50]): event-like, low-rate,
 *              every update goes out immediately.
 */
type StreamBudget = 'gui' | 'encoder' | null;
export function streamBudgetFor(high: number, _low: number): StreamBudget {
  if (high === 0x20 || high === 0x21 || high === 0x22 || high === 0x23) return 'gui';
  if (high === 0x26) return 'gui';  // LabJack T7 (t7_bridge), raw and calibrated
  if (high === 0x30 || high === 0x31) return 'gui';
  if (high === 0x33 || high === 0x34) return 'gui';  // ball valve position
  if (high === 0x24) return 'encoder';
  return null;
}

const broadcastLastTime = new Map<string, number>();  // per-key throttle gate (legacy mode)

// ── GUI stream downsampling (config.toml [gui]; see gui-stream.ts) ───────────

export let guiStreamConfig: GuiStreamConfig;
let envelope: EnvelopeAccumulator;
let encoderEnvelope: EnvelopeAccumulator;

/** The startup read of [gui]: builds both envelopes and logs the mode (DESIGN-WP6 §1.2 row 2). */
export function initGuiStream(): void {
  guiStreamConfig = parseGuiStreamConfig(safeReadConfigForGui());
  envelope = new EnvelopeAccumulator(envelopeWindowMs(guiStreamConfig));
  encoderEnvelope = new EnvelopeAccumulator(encoderWindowMs(guiStreamConfig));
  console.log(`[ThinServer] GUI downsampling: ${guiStreamConfig.mode} @ ${guiStreamConfig.pointsPerSecond} pts/s per stream`
    + ` (encoders @ ${guiStreamConfig.encoderPointsPerSecond} pts/s)`);
}

function safeReadConfigForGui(): unknown {
  try { return readConfig(); } catch { return null; }
}

/** Re-read [gui] settings after a config save (wired via onConfigUpdated). */
export function reloadGuiStreamConfig(): void {
  const next = parseGuiStreamConfig(safeReadConfigForGui());
  if (next.mode !== guiStreamConfig.mode
      || next.pointsPerSecond !== guiStreamConfig.pointsPerSecond
      || next.encoderPointsPerSecond !== guiStreamConfig.encoderPointsPerSecond) {
    console.log(`[ThinServer] GUI downsampling changed: ${next.mode} @ ${next.pointsPerSecond} pts/s per stream`
      + ` (encoders @ ${next.encoderPointsPerSecond} pts/s)`);
  }
  guiStreamConfig = next;
  envelope.setWindowMs(envelopeWindowMs(next));
  encoderEnvelope.setWindowMs(encoderWindowMs(next));
}

/** Sample timestamps are forwarded from Elodin (bridge receipt, epoch ms). A
 *  publisher on the wrong clock (e.g. steady_clock) would poison plots, so
 *  anything implausibly far from the backend's clock falls back to receipt
 *  time — worst case is exactly the pre-refactor behavior. */
const MAX_SAMPLE_TS_SKEW_MS = 60_000;
export function saneSampleTimeMs(tsMs: number, fallbackMs: number): number {
  return Number.isFinite(tsMs) && Math.abs(tsMs - fallbackMs) <= MAX_SAMPLE_TS_SKEW_MS
    ? tsMs : fallbackMs;
}

/** Single exit point for streams that bypass downsampling (event-like: state,
 *  self-test, controller, sequencer). Broadcast immediately, never staged. */
export function emitSensorPoint(key: string, entity: string, component: string, value: number, tMs: number): void {
  history.record(key, tMs, value);
  stats.sensorUpdatesBroadcast++;
  const update: SensorUpdate = { entity, component, value, timestamp: tMs };
  broadcast({ type: MessageType.SENSOR_UPDATE, timestamp: Date.now(), payload: update });
}

/** Single exit point for downsampled sensor streams: history, then per-client
 *  staging. One call per closed envelope window (1–2 points, chronological). */
export function emitSensorWindow(key: string, entity: string, component: string, points: EnvelopePoint[]): void {
  if (points.length === 0) return;
  for (const p of points) history.record(key, p.tMs, p.value);
  stats.sensorUpdatesBroadcast += points.length;
  for (const cs of clientStreams.values()) cs.outbox.push(key, entity, component, points);
}

// Timer flush so trickling/stopped streams don't hold their last window open.
// Runs regardless of mode so a runtime envelope→throttle switch drains any
// still-open windows instead of dropping them (map is empty in throttle mode).
export function flushEnvelopes(): void {
  const nowMs = Date.now();
  for (const closed of envelope.flushOlderThan(nowMs)) {
    emitSensorWindow(closed.key, closed.entity, closed.component, closed.points);
  }
  for (const closed of encoderEnvelope.flushOlderThan(nowMs)) {
    emitSensorWindow(closed.key, closed.entity, closed.component, closed.points);
  }
}

/** One finite row's way out (ingest, step 2.1): today's last block of the per-row loop — key, sane
 *  timestamp, budget; null → emitSensorPoint; 'gui' + throttle mode → 50 ms gate → emitSensorWindow;
 *  else envelope add → emitSensorWindow on a closed window. Takes values, not sockets. */
export function publishSample(high: number, low: number, parsed: ParsedSensorData, epochNow: number): void {
  const key = `${parsed.entity}.${parsed.component}`;
  // Sample time = Elodin field-0 timestamp (bridge receipt, epoch ms),
  // guarded against off-clock publishers.
  const tsMs = saneSampleTimeMs(parsed.timestamp, epochNow);

  const budget = streamBudgetFor(high, low);
  if (budget === null) {
    // Event-like streams (state, self-test, controller, sequencer): every
    // update goes out immediately, no downsampling and no staging.
    emitSensorPoint(key, parsed.entity, parsed.component, parsed.value, tsMs);
    return;
  }

  if (budget === 'gui' && guiStreamConfig.mode === 'throttle') {
    // Legacy drop-throttle (config.toml [gui] downsample_mode = "throttle").
    const lastBcast = broadcastLastTime.get(key) ?? 0;
    if (epochNow - lastBcast < BROADCAST_MIN_MS) return;
    broadcastLastTime.set(key, epochNow);
    emitSensorWindow(key, parsed.entity, parsed.component, [{ tMs: tsMs, value: parsed.value }]);
  } else {
    // Min/max envelope: extremes of each window survive with their real
    // timestamps, so transients can't hide between broadcast slots.
    // Encoders run on their own, much shorter window (see streamBudgetFor).
    const acc = budget === 'encoder' ? encoderEnvelope : envelope;
    const closed = acc.add(key, parsed.entity, parsed.component, tsMs, parsed.value);
    if (closed.length > 0) emitSensorWindow(key, parsed.entity, parsed.component, closed);
  }
}
