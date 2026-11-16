/**
 * sensor-config — DELTA ONLY of the existing `sensor-config.ts` (sensors and boards as config
 * declares them). Lists the exports WP5 and WP7 add; everything already there stays as it is
 * (`isCurrentLoopBoard`, `hpBoardNumbers`, `t7CalFields`, `loadSensorRoleMap`, …), including its
 * by-path import by `test/characterization/config/ts_dump.ts` (adding exports does not change
 * `config/golden/ts/`).
 *
 * Must not know about: Elodin packet decoding (`elodin-protocol.ts` owns the reverse direction),
 * the registry's `% 8` fold (D-SLOT, stays in `elodin-vtable-registry.ts`), WebSocket, HTTP.
 * Import-time effects: none added (STYLE-S30).
 */

/**
 * The Elodin board slot ("board number") of a board id: `board_id % 10`, with 0 → 10.  [WP5]
 *
 * The body is fixed by DESIGN-WP5 §3 because DESIGN-WP6 step 2.3 and DESIGN-WP7 step 2.2 rely on
 * it being literally the expression every former copy used:
 * `const m = boardId % 10; return m === 0 ? 10 : m;`
 * No validation: callers keep their guards. For the record `-21 → -1`, `21.5 → 1.5`,
 * `NaN → NaN`, exactly as each copy computes today.
 *
 * Users after WP5-7: `hpBoardNumbers`, `loadSensorRoleMap` (this file), the registry's
 * subscription list, `state-csv/state-actuators`'s actuator resolution, `buildSensorConfig`
 * (WP7 2.2), `server/config-caches` (WP6 2.3). Frontend copies are out of scope.
 */
export function boardSlot(boardId: number): number {
  throw new Error('stub');
}

/** One row of `/api/sensor-config`. Moved verbatim from `api-server.ts:49-71`.  [WP7 1.2]
 *  `api-server.ts` re-exports it for `__tests__/t7.test.ts`. */
export interface SensorConfigEntry {
  type: 'PT' | 'TC' | 'RTD' | 'LC';
  id: number;
  role: string;
  boardId: number;
  boardIp: string;
  isHpPt: boolean;
  inCalibrationSequence: boolean;
  entity: string;
  calEntity: string;
  source?: 'T7';
}

/**
 * Config → the sorted sensor list served by `GET /api/sensor-config`.  [WP7 1.2]
 *
 * Moved verbatim from `api-server.ts:102-303` with its private helpers (`enabledBoardCount`,
 * `generatedRole`, `asBoardId`, `elodinSlotFromBoardId`; the last becomes `boardSlot` in WP7 2.2,
 * after gap H4). Pure when `config` is passed; with no argument it calls `readConfig()` (the
 * default parameter is evaluated per call, as today). Throws whatever `readConfig()` throws —
 * the route's caller (`api/gui-config`) lets it reach the router's catch (500), as today.
 */
export function buildSensorConfig(config?: any): SensorConfigEntry[] {
  throw new Error('stub');
}
