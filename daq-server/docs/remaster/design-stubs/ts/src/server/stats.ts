/**
 * server/stats — ingest and broadcast counters served by `GET /stats` and `/api/debug`.
 * [WP6 1.2, layer 0]
 *
 * Owns: the `stats` object. Its fields are counters incremented in place by the modules that
 * observe each event (`ingest`/`sensor-stream`, `engine-state`, `board-status`'s diagnostics
 * read); the object identity never changes, so this is an owned container, not a cross-module
 * assignment (WP6 §6.2 lists none for it).
 *
 * Must not know about: who reads it. Imports nothing.
 * Contract: the `/stats` keys (`pipeline/golden/http.txt`, P9 schema) and `ws_data_flow_test`'s
 * sample-conservation reading of `rawPrimarySamplesIngested` / `rawPrimarySamplesByGroup`.
 * Import-time effect: `startTimeMs = Date.now()` (WP6 §1.3 row 14, a pure clock read; allowed).
 */

export interface IngestStats {
  /** Every finite-value entity parsed from Elodin. */
  ingestEntityUpdatesReceived: number;
  /** Raw physical channel samples (non-`_Cal`, canonical component only). */
  rawPrimarySamplesIngested: number;
  /** The same, by board group (`pt1`, `tc`, `act`, …, `other`). */
  rawPrimarySamplesByGroup: Record<string, number>;
  /** SENSOR_UPDATE samples handed to clients (post-downsampling). */
  sensorUpdatesBroadcast: number;
  /** `_SEQUENCER_STATE` packets applied. */
  sequencerStatesReceived: number;
  /** Process start, epoch ms; `/stats` adds `uptimeMs` from it. */
  startTimeMs: number;
}

export declare const stats: IngestStats;
