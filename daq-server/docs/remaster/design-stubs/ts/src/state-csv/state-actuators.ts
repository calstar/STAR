/**
 * state-csv/state-actuators — expected actuator positions per state, from the state CSV, and the
 * actuator name → Elodin entity resolution.  [WP5: renamed from `legacy/`; surviving surface]
 *
 * Owns: the CSV parse and the three config-derived maps built **at import** (abbreviations,
 * channel by name, `CSV_ACTUATOR_TO_ENTITY`). That import-time config read and its warnings are
 * frozen existing behaviour (STYLE-S19 "Frozen"), which is why DESIGN-WP6 needs WP6-R1a's bare
 * import to keep its evaluation point; making the maps lazy is Parked (DESIGN-WP5 §7).
 *
 * Must not know about: WebSocket, the sequencer, sessions, the HTTP routes (`/api/state-csv`
 * reads the CSV through `routes/config-profiles.ts`, a separate reader).
 *
 * Paths: CSVs are found with `join(__dirname, '..', '..', '..', '..', rel)`; the rename keeps the
 * nesting depth, and `join` normalises the directory name away, so the `Trying: <path>` log lines
 * are byte-identical (STYLE-S15). Absolute `[state_machine]` paths are never found (C5-4, kept).
 *
 * Deleted by WP5 5.4 (no caller): `getActuatorChannel`, `getNumActuatorsFromCSV`.
 * Users: `server/engine-state`, `server/ws-connection` (step 1) / `engine-state` (step 2.8),
 * `__tests__/ball-valve.test.ts` (import path edited in 5.3 under D18's conditions).
 */

/** SystemState id → { actuator name → 0 (CLOSED) | 1 (OPEN) }. Keyed by name, not channel. */
export interface StateActuatorMap {
  [state: number]: { [actuatorName: string]: number };
}

/** Actuator name → `ACT.<Name_With_Underscores>`, built once at import; never rebuilt by a
 *  deploy (observation, kept — DESIGN-WP6 R4(c)). */
export declare const CSV_ACTUATOR_TO_ENTITY: Record<string, string>;

/**
 * Role / CSV / GUI actuator name → its board slot (`boardSlot` of the role's board id, default
 * board 12), local channel, and whether that board is a ball valve. Reads `readConfig()` per call;
 * `null` on a missing role or any config error (caught: the catch is a decision, STYLE-S9).
 */
export function resolveActuatorBoardSlotAndChannel(
  actuatorName: string,
): { bn: number; localCh: number; ballValve: boolean } | null {
  throw new Error('stub');
}

/** Commanded entity: `ACT_CMD.B<bn>.CH<ch>` ([0x32]) or `BV_CMD.…` ([0x35]); `null` if unresolved. */
export function resolveActuatorCmdEntity(actuatorName: string): string | null {
  throw new Error('stub');
}

/** Sensed entity: `ACT<bn>.CH<ch>` ([0x31]) or `BV<bn>.CH<ch>`; `null` if unresolved. */
export function resolveActuatorTelemetryEntity(actuatorName: string): string | null {
  throw new Error('stub');
}

/** Parse one CSV file. Logs its progress lines; returns `{}` on a parse error (logged). */
export function parseStateActuatorsCSV(csvPath: string): StateActuatorMap {
  throw new Error('stub');
}

/**
 * Find and parse the state-actuators CSV (config path first, then fixed fallbacks), logging each
 * `Trying:` line. Returns an empty map, with an error log, when none is found. A throw escapes to
 * the caller: at startup (WP6 §1.3 row 11) it is deliberately uncaught.
 */
export function getStateActuatorMap(): StateActuatorMap {
  throw new Error('stub');
}
