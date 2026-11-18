/**
 * server/stats.ts — the ingest/broadcast counters served by GET /stats and /api/debug.
 *
 * Owns `stats` and alone resets its origin: initStats() sets startTimeMs where server.ts's
 * startup sequence used to read Date.now() (DESIGN-WP6 §1.2 row 14), so uptimeMs keeps its
 * origin. Other modules increment the counters through this object (ingest, sensor-stream,
 * engine-state); nothing here reads a clock, disk or socket at import (M1).
 *
 * Contract: the key set and order of `stats` are frozen in pipeline/golden/http.txt (/stats,
 * /api/debug, P9); test_integration.sh reads rawPrimarySamplesIngested for sample conservation.
 */

// ── Packet stats ─────────────────────────────────────────────────────────────
// Counts raw entity updates received from Elodin DB vs broadcasts sent to WS clients.
// GET /stats returns these so the integration test can verify no drops occur before
// the throttle (backend→WS is intentionally throttled). NOTE: Elodin→backend is NOT
// strictly lossless — the DB's live stream coalesces same-channel rows written in one
// burst (multi-chunk board packets), forwarding at least one row per channel per
// packet; DB *storage* keeps every row. See integration Test 15 for the invariant.

export const stats = {
  ingestEntityUpdatesReceived: 0,  // every finite-value entity parsed from Elodin DB
  // Raw physical channel samples (non-_Cal, canonical component only): exactly one
  // increment per per-channel per-chunk sample a board sent, so the integration test
  // can compare this against the simulator's sent-sample ground truth for absolute
  // end-to-end loss detection (UDP → bridge → Elodin DB → backend), independent of
  // the GUI downsampler.
  rawPrimarySamplesIngested: 0,
  // Same counter split by board group (pt1/pt2/tc/rtd/lc/enc/act) so a
  // conservation failure names the lossy stream instead of just the total.
  rawPrimarySamplesByGroup: {} as Record<string, number>,
  sensorUpdatesBroadcast: 0,  // SENSOR_UPDATE messages actually sent (post-throttle)
  sequencerStatesReceived: 0,  // packets successfully streamed through Elodin DB verifying storage
  startTimeMs: 0,
};

/** The uptimeMs origin: called by server.ts at the point its top level used to read Date.now(). */
export function initStats(): void {
  stats.startTimeMs = Date.now();
}
