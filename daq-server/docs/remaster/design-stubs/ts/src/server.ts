/**
 * server — the backend process's entry point and composition root.  [WP6, layer 7]
 *
 * Path frozen: `src/server.ts` is launched by systemd (`npm run dev`), `pipeline/run.sh:200`,
 * `test_integration.sh:834`, `test/environmental-recovery.integration.ts:97`.
 *
 * Owns: the startup sequence — every timer, listener and startup read as a top-level statement in
 * today's order (WP6 §1.3 rows 1-31, WP6-R2; checked by `startup-order.expected`), the HTTP
 * server (`/stats`, then the API handler, else a bare 404; one try → 500 `Internal server error`
 * if headers are unsent), the `createAPIHandler` options (the one seam between the WS side and
 * the HTTP side, STYLE-S31), `applyDeployedConfigChange`, the `sessionManager.init` callbacks,
 * the crash guards, the EADDRINUSE retry, `listen`. No SIGTERM/SIGINT handler (C6-5, frozen in
 * `lifecycle/golden/shutdown.txt`).
 *
 * Imports: **all of today's imports in today's positions** (WP6-R1), an import a move leaves
 * without a value use rewritten as a bare `import './x.js';` at the same position (WP6-R1a,
 * [A2]) — the likely ones are `./state-csv/state-actuators.js` and `./countdown-state.js`, the
 * module-order diff decides — then the `./server/*.js` imports after them. Never
 * `verbatimModuleSyntax` (WP6-R1c).
 *
 * The three 1 s timers stay three `setInterval` calls in the order stale sweep → board status
 * → connection status [A5].
 */

/**
 * Everything the always-on backend redoes when new config reaches disk, then `config_updated`
 * to every browser. Called by the HTTP side (`onConfigUpdated`, deferred with `setImmediate` by
 * `api/config` and `api/profiles`) and by `sessionManager.start` (passed to `init`).
 * Order (verbatim): `reloadGuiStreamConfig()`, `reloadCalibrationEntityMap()`,
 * `resetConfigCaches()`, `reloadStateActuatorMap()` in its own try/catch (warn
 * `Failed to rebuild STATE_ACTUATOR_MAP:`), `loadBoardsFromConfig()`, `broadcastBoardStatus()`,
 * `broadcast(CONFIG_UPDATED)`. G7/G8 freeze the frames and their order before step 1.
 */
export function applyDeployedConfigChange(): void {
  throw new Error('stub');
}
