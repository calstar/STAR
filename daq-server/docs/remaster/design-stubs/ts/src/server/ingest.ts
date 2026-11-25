/**
 * server/ingest — route each Elodin row to the module that owns what it says.
 * [WP6 1.14, layer 5; an input boundary, STYLE-S9]
 *
 * Owns: nothing but the routing and the one try/catch around it (a throw anywhere → log
 * `[ThinServer] Packet error:` and drop the packet — WP6 §4.1, verbatim). After step 2.1 it is a
 * router; in step 1 it still holds the per-row blocks (moved verbatim from `server.ts:1637-1816`).
 * Must not know about: sockets, HTTP, commands. Imports `elodin-link`, `board-status`,
 * `engine-state`, `actuator-mismatch`, `sensor-stream`, `mission-time`, `calibration-state`,
 * `config-caches`, `notifications`, `stats`, `env`, and the decoders.
 *
 * Fixed order (behaviour; WP6 §3.3):
 * 1. `notePairDelivered(high, low)` is the **first statement**, before any family dispatch, in
 *    step 1 and step 2 (LEDGER D42(d); a later per-pair `lastDeliveredMs` is then a one-file
 *    change in the registry). No other module records delivery.
 * 2. `[0x10]` heartbeat → `board-status.countHeartbeat` + `updateBoard`; return.
 * 3. Parse at this site, this exact expression (guarded by `__tests__/lc-tare.test.ts`'s
 *    re-pointed anchor): `applyValveCalibration(expandWithTare(parseElodinPacket(id, payload,
 *    hpBoardNumbersCache, t7CalFieldsCache)))`. Empty → log unmapped `[0x40+]`; return.
 * 4. Self-test `[0x60..0x6F]` → `board-status.noteSelfTestResults` (2.1).
 * 5. `_SEQUENCER_STATE` → `engine-state.applySequencerState(rows)`, then
 *    `actuator-mismatch.scheduleActuatorMismatchCheck(currentState)`; return.
 * 6. Per finite row: `actuator-mismatch.noteSensedRow`; T7 raw → `board-status.noteT7Alive`;
 *    raw ADC → `calibration-state.noteRawAdc`; `mission-time.noteFirstSample(epochNow)`; stats +
 *    `elodin-link.noteIngest()` + `recordBoardScanIngest`; `sensor-stream.publishSample`.
 *
 * Contract: everything downstream; `ws_data_flow_test` sample conservation and the pipeline T1
 * bound guard the per-row cost (WP6 risk R7).
 * Import-time effects: none; `server.ts` registers `elodin.on('packet', handleElodinPacket)`.
 */

import type { ElodinPacketHeader } from '../product-types.js';

/** The `packet` listener. Never throws (one catch around the whole body). */
export function handleElodinPacket(header: ElodinPacketHeader, payload: Buffer): void {
  throw new Error('stub');
}
