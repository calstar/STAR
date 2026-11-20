/**
 * server/commands — browser → backend messages and engine commands.
 * [WP6 1.15, layer 5; two input boundaries, STYLE-S9]
 *
 * Owns: message dispatch, the control gate (`CONTROL_COMMAND_TYPES` against the socket's
 * `__daqControlAuthorized`, set here on `CONTROL_UNLOCK` from `ws-connection`'s
 * `__daqOperator`), the command → sequencer line format, and the error replies. Owns no state.
 * In step 1 it also holds `STATE_TO_CSV_NAME` and the `[[states]]` check; step 2.9 [A3] moves
 * them to `engine-state.resolveTransitionTarget` (walkthrough (a) found two owners).
 * Must not know about: socket identity (`ws-connection`), how the sequencer is reached (WP5's
 * `sequencer-client`), Elodin, HTTP. Imports `ws-clients`, `engine-state`, `mission-time`,
 * `history`, `calibration-state`, `elodin-link`, `sequencer-client` [A1], `session-manager`,
 * `calibration-handler`, `state-csv/state-transitions`, `refusal-text`.
 *
 * Error paths (WP6 §4.1, verbatim): locked → `ERROR "Control locked: …"`; unknown `commandType`
 * → `ERROR "Command not supported in thin backend: <type>"`; :9998 not ok →
 * `ERROR "<Action> failed: <refusalText(reply)>"` (state_transition, actuator, extend_fire);
 * `debug_mode` failure → log only (today, kept); session start refused by config →
 * `SESSION_START_BLOCKED`; other session failures → `ERROR "Session <verb> failed: …"`; unknown
 * message `type` → warn, no reply. Replies go to the requesting socket only; no optimistic
 * update. The abort is a `state_transition` to an abort state and passes the same gate (frozen).
 * Contract: `pipeline/golden/ws_events.txt` (P6, P11), G4 (:9998 down/slow), G10 (a throwing
 * handler).
 * Import-time effects: none.
 */

import type { WebSocket } from '../product-types.js';

/**
 * Dispatch one parsed browser message: `send_command` → the command switch; `control_unlock` →
 * arm iff operator, reply `control_unlock_result`; `query_historical` → backfill (not awaited);
 * `calibration_command` → `handleCalibrationCommand(calibrationHost, ws, payload)`;
 * `get_state_transitions` → `state_transitions` (CSV re-read per request). A throw propagates to
 * `ws-connection`'s catch (`Bad message`, no reply — today, kept, STYLE-S10).
 */
export function handleMessage(ws: WebSocket, message: any): void {
  throw new Error('stub');
}
