/**
 * server/engine-state.ts — the sequencer's state as the backend reports it.
 *
 * Owns `currentState`, `debugMode`, the advertised-allowed bitmask and the per-state refusal
 * reasons, and the CSV-derived commanded positions (`STATE_ACTUATOR_MAP`, rebuilt by
 * reloadStateActuatorMap() at startup — a throw there kills the process before the crash guards
 * exist, as today — and at the two deploy callbacks, which keep their own try/catch and warning
 * text). applySequencerState() is the only path that moves the state (the `_SEQUENCER_STATE`
 * row from ingest); setDebugMode() is the command path's single writer (DESIGN-WP6 §6.2).
 * The backend never sends FIRE_* — the sequencer owns the burn gate (see applySequencerState's
 * caller in ingest).
 *
 * Every binding here is an `export let` assigned only in this module (STYLE-S32); readers use
 * the live binding. No effect at import (M1): initEngineState() is the startup config read
 * (§1.2 row 15) and server.ts registers the 15 s SCRIPTS poll. Never imports api-server.ts or api/*.
 *
 * Contract: both state_update shapes (connect: no allowedBitmask/stateRefusalReasons; broadcast:
 * with them), the double state_update on debug_mode (C5-3) and the commanded snapshot's
 * actuator_state_commanded frames are frozen in pipeline/golden/ws_events.txt and
 * ws_handshake.txt; `SCRIPTS\n` is one of the five :9998 lines.
 */

import { readConfig, readDeployedConfig } from '../routes/config.js';
import { getStateActuatorMap, CSV_ACTUATOR_TO_ENTITY, resolveActuatorCmdEntity, resolveActuatorTelemetryEntity } from '../state-csv/state-actuators.js';
import type { StateActuatorMap } from '../state-csv/state-actuators.js';
import type { ParsedSensorData } from '../elodin-protocol.js';
import { parseScriptStatus } from '../script-status.js';
import { sessionManager } from '../session-manager.js';
import { sendToSequencer } from '../sequencer-client.js';
import { MessageType, SystemState } from '../../../shared/types.js';
import { THIN_VERBOSE_CONNECTION_LOG } from './env.js';
import { stats } from './stats.js';
import { broadcast } from './ws-clients.js';
import { history } from './history.js';

/**
 * Name of a state id as the ACTIVE config declares it, or null if the config declares no [[states]]
 * (or not this id).
 *
 * Served from the deployed-config cache. A profile CAN be redeployed under a running backend —
 * the backend is always-on, not one of the session-gated pipeline units — which is why this is a
 * cache with invalidation rather than a boot-time read. deployActiveProfile() drops it, so the
 * next command after a deploy resolves against the new rig's names.
 */
export function configStateName(id: number): string | null {
  try {
    const raw = (readDeployedConfig() as any)?.states;
    if (!Array.isArray(raw)) return null;
    const hit = raw.find((e: any) => e?.id === id && typeof e?.name === 'string');
    return hit ? (hit.name as string) : null;
  } catch {
    return null;
  }
}

// ── State actuator map (expected positions per state from CSV) ────────────────

// `let`, not `const`: this is parsed from state_machine_actuators.csv at import time, and the
// State Management tab can now change that file at runtime. It used to be a const that nothing
// ever rebuilt, so expected-position / mismatch detection kept using the CSV as it was when the
// backend booted.
export let STATE_ACTUATOR_MAP: StateActuatorMap;

/** The CSV read: at startup (uncaught, as today) and from the two deploy callbacks (each with its own try/catch). */
export function reloadStateActuatorMap(): void {
  STATE_ACTUATOR_MAP = getStateActuatorMap();
}

/**
 * Build entity→expected map for a given state.
 * Keys must match Elodin [0x31] actuator_state entities (ACT{n}.CH{m}), not ACT.Role_Name,
 * or mismatch detection never lines up with sensed state.
 */
export function getExpectedPositions(state: SystemState): Record<string, number> {
  const expected = STATE_ACTUATOR_MAP[state];
  if (!expected) return {};
  const result: Record<string, number> = {};
  for (const [name, value] of Object.entries(expected)) {
    const tel = resolveActuatorTelemetryEntity(name);
    if (tel) {
      result[tel] = value;
      continue;
    }
    const entity = CSV_ACTUATOR_TO_ENTITY[name] || `ACT.${name.replace(/\s+/g, '_')}`;
    result[entity] = value;
  }
  return result;
}

/** Push CSV-derived commanded actuator states using ACT_CMD.B*.CH* keys (matches Elodin [0x32] + GUI). */
export function broadcastCommandedActuatorsForState(state: SystemState): void {
  const raw = STATE_ACTUATOR_MAP[state];
  if (!raw) return;
  const epochNow = Date.now();
  for (const [actuatorName, value] of Object.entries(raw)) {
    const cmdEntity = resolveActuatorCmdEntity(actuatorName);
    if (!cmdEntity) continue;
    const key = `${cmdEntity}.actuator_state_commanded`;
    history.record(key, epochNow, value);
    stats.sensorUpdatesBroadcast++;
    broadcast({
      type: MessageType.SENSOR_UPDATE,
      timestamp: epochNow,
      payload: { entity: cmdEntity, component: 'actuator_state_commanded', value, timestamp: epochNow },
    });
  }
}

// ── Local state (sequencer / actuator_service authoritative) ────────────────
/** Boot state id from the config's [[states]] (is_boot), or IDLE if none is flagged. This was a
 *  bare SystemState.IDLE — a literal 1 — which names a different state on a rig that renumbered,
 *  so the backend reported and mismatch-checked against the wrong state until the first
 *  _SEQUENCER_STATE packet arrived. */
function configBootStateId(): SystemState {
  try {
    const raw = (readConfig() as any)?.states;
    if (Array.isArray(raw)) {
      const boot = raw.find((e: any) => e?.is_boot === true && typeof e?.id === 'number');
      if (boot) return boot.id as SystemState;
    }
  } catch {
    /* fall through */
  }
  return SystemState.IDLE;
}

export let currentState: SystemState;
export let debugMode = false;

/** The startup config read for the boot state (DESIGN-WP6 §1.2 row 15). */
export function initEngineState(): void {
  currentState = configBootStateId();
}

/** The command path's writer: debug_mode's OK reply (commands.ts). */
export function setDebugMode(v: boolean): void {
  debugMode = v;
}

/** Latest advertised-allowed set from the sequencer; undefined until it first publishes. */
let allowedBitmask: number | undefined;
/** State id -> why it cannot be entered, from the sequencer's SCRIPTS report. */
let stateRefusalReasons: Record<number, string> = {};

/**
 * Refresh the per-state refusal reasons.
 *
 * Load refusals are fixed for the run, but the sensor gate is live — a state blocks and unblocks
 * as a feed comes and goes — so this is polled rather than read once. Slow on purpose: the reasons
 * only decorate a button that is already greyed by the bitmask, and nothing here may ever raise a
 * notification, or a poll would spam the panel once a second.
 */
export function refreshScriptStatus(): void {
  // Between runs the sequencer is stopped on purpose; asking it anyway logged a connect error
  // every 15 s. Nothing is enterable then, and the bitmask already says so.
  if (!sessionManager.pipelineExpected()) return;
  sendToSequencer('SCRIPTS\n')
    .then(({ reply }) => {
      stateRefusalReasons = parseScriptStatus(reply).reasons;
    })
    .catch(() => { /* sequencer down — the bitmask already says nothing is enterable */ });
}

export function broadcastStateUpdate(): void {
  broadcast({
    type: MessageType.STATE_UPDATE, timestamp: Date.now(),
    payload: { currentState, stateName: configStateName(currentState) ?? SystemState[currentState] ?? 'UNKNOWN', timestamp: Date.now(), debugMode, allowedBitmask, stateRefusalReasons },
  });
}

/** The `_SEQUENCER_STATE` row: the body of ingest's branch (DESIGN-WP6 row 1.11), without its
 *  last two statements — the caller schedules the mismatch check and returns. */
export function applySequencerState(parsedList: ParsedSensorData[]): void {
  const prevState = currentState;
  const stateVal = parsedList.find(p => p.component === 'state')?.value ?? 0;
  const bitmask = parsedList.find(p => p.component === 'allowedBitmask')?.value ?? 0;
  // Kept, not discarded. This is the sequencer's own statement of what it will accept, and
  // the publish happens on every refusal too, so a greyed button corrects itself.
  allowedBitmask = bitmask;
  const debugModeVal = parsedList.find(p => p.component === 'debugMode')?.value ?? 0;
  if (THIN_VERBOSE_CONNECTION_LOG) {
    console.log(`[ThinServer] SequencerState from Elodin: state=${stateVal} bitmask=0x${bitmask.toString(16)} debug=${debugModeVal}`);
  }
  stats.sequencerStatesReceived++;
  // Sync local state from Elodin (backup path — primary is TCP reply)
  currentState = stateVal as SystemState;
  debugMode = debugModeVal === 1;
  broadcastStateUpdate();
  broadcastCommandedActuatorsForState(currentState);
}
