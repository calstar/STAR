/**
 * server/config-caches — config-derived lookups on the Elodin hot path, rebuilt after a deploy.
 * [WP6 1.8, layer 2]
 *
 * Owns: the HP PT board-number set and the T7 calibrated-field map (passed to the decoder), and
 * the slot → board-id maps behind `uniqueIdFromPtEntity` and `t7BoardIdForSlot` (lazily filled,
 * cleared by `resetConfigCaches`). One owner per derived cache, reset at the named reload point
 * `applyDeployedConfigChange` (STYLE-S20).
 * Must not know about: WebSocket, notifications, the meaning of a raw ADC value. Imports
 * `routes/config`, `sensor-config` (`hpBoardNumbers`, `t7CalFields`, and `boardSlot` from step
 * 2.3), `shared/config-validation`.
 * Contract: `uniqueId = board_id*100 + channel` (matches calibration_service; reached through
 * calibration capture in `ws_data_flow_test`); G6 freezes the slot-0 → 10 cases before step 2.3.
 * Import-time effects: none; `initConfigCaches()` at WP6 §1.3 row 8 (after
 * `initCalibrationState()`, see WP6 §6.1 "Call order for rows 7-9").
 */

/** HP (4-20 mA) PT board numbers for the decoder. Step 1 name `_hpBoardNumbers` (STYLE-S6 rename in 2.5). */
export declare let hpBoardNumbersCache: Set<number>;
/** T7 calibrated table → field name (psi / °C / kg). Step 1 name `_t7CalFields`. */
export declare let t7CalFieldsCache: Map<number, string>;

/** Row 8: build both caches from config (no log). */
export function initConfigCaches(): void {
  throw new Error('stub');
}

/** After a deploy: clear the two slot maps, rebuild both caches — today's four statements in
 *  today's order (`server.ts:854-857`). */
export function resetConfigCaches(): void {
  throw new Error('stub');
}

/**
 * `PT<n>[_Cal].CH<m>` → `board_id*100 + m` via the PT slot map (fallback `n*100 + m` when no
 * config board has slot n); `T7<n>_Cal.AIN<m>` → `board_id*100 + m` via the T7 map; else null.
 * Config errors are caught (a decision: fall back), as today.
 */
export function uniqueIdFromPtEntity(entity: string): number | null {
  throw new Error('stub');
}

/** [step 2.4] The one T7 slot → board id lookup, replacing the two lazy fillers (today
 *  `server.ts:360` and `:577`); `undefined` when unknown or on a config error. Step 1 exports
 *  the map itself as `_t7SlotToBoardId` for `board-status.noteT7Alive`'s own filler. */
export function t7BoardIdForSlot(slot: number): number | undefined {
  throw new Error('stub');
}
