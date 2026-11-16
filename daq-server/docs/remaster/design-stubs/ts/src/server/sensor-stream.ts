/**
 * server/sensor-stream — GUI downsampling and the two sample exits (immediate / windowed).
 * [WP6 1.7, layer 3]
 *
 * Owns: the `[gui]` stream config, the two envelope accumulators (GUI and encoder), the legacy
 * throttle gate. `gui-stream.ts` stays the pure envelope library; this module is its wiring.
 * Order inside an exit is behaviour: history first, then the clients (so live data and a
 * reconnect backfill agree — the LC tare is applied before both, at the parse site).
 * Must not know about: what a sample means (state, actuator, calibration), Elodin connection
 * state, HTTP. Imports `ws-clients`, `history`, `stats`, `gui-stream`.
 * Contract: SENSOR_UPDATE frames, the 50 ms throttle and envelope flush, the encoder budget
 * (`pipeline/golden/ws_streams.txt` T1, P2, P7, P8; `ws_data_flow_test` sample conservation).
 * Step 2.1's per-row call must not move `/stats` `sensorUpdatesBroadcast` against the simulator
 * (WP6 risk R7); abandon 2.1 for any block where it does.
 * Import-time effects: none; `initGuiStream()` at WP6 §1.3 row 2 (reads `[gui]`, logs
 * `[ThinServer] GUI downsampling: …`); `server.ts` registers `setInterval(flushEnvelopes, 50)`.
 */

import type { EnvelopeAccumulator, EnvelopePoint, GuiStreamConfig, ParsedSensorData } from '../product-types.js';

/** Which budget a stream is downsampled against; `null` = event-like, sent immediately. */
export type StreamBudget = 'gui' | 'encoder' | null;

export declare let guiStreamConfig: GuiStreamConfig;
/** [step 1 only] Exported because `ingest` still holds the per-row downsampling; private after 2.1. */
export declare const envelope: EnvelopeAccumulator;
/** [step 1 only] As `envelope`. */
export declare const encoderEnvelope: EnvelopeAccumulator;
/** [step 1 only] The legacy throttle's per-key gate. */
export declare const broadcastLastTime: Map<string, number>;

/** `[0x20..0x23]`, `[0x26]`, `[0x30,0x31]`, `[0x33,0x34]` → `'gui'`; `[0x24]` → `'encoder'`; else null. */
export function streamBudgetFor(high: number, low: number): StreamBudget {
  throw new Error('stub');
}

/** A sample timestamp more than 60 s from `fallbackMs` (or non-finite) falls back to it. */
export function saneSampleTimeMs(tsMs: number, fallbackMs: number): number {
  throw new Error('stub');
}

/** Row 2: parse `[gui]` (null config on a read error), build both accumulators, log the mode. */
export function initGuiStream(): void {
  throw new Error('stub');
}

/** After a deploy: re-parse `[gui]`, log only if it changed, re-window both accumulators. */
export function reloadGuiStreamConfig(): void {
  throw new Error('stub');
}

/** Event-like exit: record to history, count, broadcast one SENSOR_UPDATE now (frame timestamp
 *  `Date.now()`, payload timestamp `tMs`). */
export function emitSensorPoint(key: string, entity: string, component: string, value: number, tMs: number): void {
  throw new Error('stub');
}

/** Windowed exit: record every point to history, count, then stage to each client's outbox. */
export function emitSensorWindow(key: string, entity: string, component: string, points: EnvelopePoint[]): void {
  throw new Error('stub');
}

/** The 50 ms flush of windows older than their width, both accumulators, regardless of mode. */
export function flushEnvelopes(): void {
  throw new Error('stub');
}

/**
 * [step 2.1] One finite row's way out, today's last block of the per-row loop verbatim: key,
 * sane timestamp, budget; `null` → `emitSensorPoint`; `'gui'` + throttle mode → 50 ms gate →
 * `emitSensorWindow`; else envelope `add` → `emitSensorWindow` on a closed window.
 * Takes values, not sockets (research §5 "functional core" — the decision stays testable).
 */
export function publishSample(high: number, low: number, parsed: ParsedSensorData, epochNow: number): void {
  throw new Error('stub');
}
