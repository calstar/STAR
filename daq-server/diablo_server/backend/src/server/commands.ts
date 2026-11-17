/**
 * server/commands.ts — browser → backend messages and engine commands.
 *
 * Owns no state. handleMessage is the input boundary for a parsed browser frame (the parse and
 * dispatch catch — `Bad message`, no reply — is ws-connection's, today, kept: D43(5)); handleCommand
 * stays module-private and sends four of the five :9998 lines (TRANSITION, ACTUATOR, DEBUG_MODE,
 * EXTEND_FIRE) through sequencer-client, which never rejects — each caller answers the sender with
 * `ERROR "<Action> failed: <refusalText(reply)>"`. An abort is a state_transition and passes the
 * same control gate. Cross-module writes go through the owners' setters: setDebugMode,
 * setCountdownTarget (DESIGN-WP6 §6.2, 2.2). State-id resolution is split with engine-state until
 * step 2.9 (resolveTransitionTarget).
 *
 * Event-loop only, called from ws-connection's message listener. No effect at import (M1). Never
 * imports api-server.ts or api/*; ws-connection is its only importer.
 *
 * Contract: command replies, both state_update shapes, the locked/unlocked path, the TCP-reply
 * path, countdown and session frames are frozen in pipeline/golden/ws_events.txt (P6, P11) and
 * the `holds` mode (G4, WP5); `Control locked` and the viewer's not_operator reply in
 * ws_events.txt `viewer_client` (H8). Message `type`s and payload key order never change.
 */

import WebSocket from 'ws';
import { handleCalibrationCommand } from '../calibration-handler.js';
import { getStateTransitions } from '../state-csv/state-transitions.js';
import { readConfig } from '../routes/config.js';
import { refusalText } from '../refusal-text.js';
import { sendToSequencer } from '../sequencer-client.js';
import { sessionManager } from '../session-manager.js';
import { ConfigIssuesError } from '../config-validation.js';
import { countByLevel } from '../../../shared/config-validation.js';
import { MessageType, SystemState } from '../../../shared/types.js';
import type { CommandPayload, QueryHistoricalRequest } from '../../../shared/types.js';
import { type WsWithControl, send } from './ws-clients.js';
import { configStateName, setDebugMode, broadcastStateUpdate } from './engine-state.js';
import { setCountdownTarget } from './mission-time.js';
import { sendHistoricalData } from './history.js';
import { calibrationHost } from './calibration-state.js';
import { broadcastConnectionStatus } from './elodin-link.js';

// Command types that actuate/transition the engine — gated by the operator
// unlock. Read-only queries and countdown display are not.
const CONTROL_COMMAND_TYPES = new Set(['state_transition', 'actuator', 'extend_fire', 'debug_mode', 'session_start', 'session_stop', 'session_extend']);

const STATE_TO_CSV_NAME: Record<string, string> = {
  IDLE: 'Idle', ARMED: 'Armed', FUEL_FILL: 'Fuel Fill', OX_FILL: 'Ox Fill',
  PRESS_STANDBY: 'Press Standby',
  GN2_LOW_PRESS: 'GN2 Low Press', GN2_VENT: 'GN2 Low Vent',
  FUEL_PRESS: 'Fuel Press', FUEL_VENT: 'Fuel Vent',
  OX_PRESS: 'Ox Press', OX_VENT: 'Ox Vent',
  GN2_HIGH_PRESS: 'GN2 High Press', GN2_HIGH_VENT: 'GN2 High Vent',
  CALIBRATE: 'Calibrate', READY: 'Ready', FIRE: 'Fire', VENT: 'Vent',
  ENGINE_ABORT: 'Engine Abort', GSE_ABORT: 'GSE Abort',
  EMERGENCY_ABORT: 'Emergency Abort', ABORT: 'Emergency Abort',
  DEBUG: 'Idle',
};

// ── Message handling ─────────────────────────────────────────────────────────

export function handleMessage(ws: WebSocket, message: any): void {
  switch (message.type) {
    case MessageType.SEND_COMMAND:
      handleCommand(ws, message.payload as CommandPayload);
      break;
    case MessageType.CONTROL_UNLOCK: {
      // Arming is identity-only: approved operators may toggle control on. Checked
      // server-side; the reply drives the UI's armed state, so it can never
      // disagree with what the backend will actually accept.
      const op = (ws as WsWithControl).__daqOperator === true;
      (ws as WsWithControl).__daqControlAuthorized = op;
      const reason = op ? 'ok' : 'not_operator';
      send(ws, { type: MessageType.CONTROL_UNLOCK_RESULT, timestamp: Date.now(), payload: { ok: op, reason } });
      break;
    }
    case MessageType.QUERY_HISTORICAL:
      void sendHistoricalData(ws, message.payload as QueryHistoricalRequest | undefined);
      break;
    case MessageType.CALIBRATION_COMMAND:
      handleCalibrationCommand(calibrationHost, ws, message.payload);
      break;
    case 'get_state_transitions':
      send(ws, { type: 'state_transitions', timestamp: Date.now(), payload: { transitions: getStateTransitions() } });
      break;
    default:
      console.warn('[ThinServer] Unknown message type:', message.type);
  }
}

function handleCommand(ws: WebSocket, command: CommandPayload): void {
  // The real, unbypassable gate: engine-control commands require an armed
  // (approved-operator) connection, regardless of what the UI shows.
  if (CONTROL_COMMAND_TYPES.has(command.commandType) && !(ws as WsWithControl).__daqControlAuthorized) {
    send(ws, {
      type: MessageType.ERROR, timestamp: Date.now(),
      payload: { message: 'Control locked: unlock as an approved operator first.' },
    });
    return;
  }
  switch (command.commandType) {
    case 'state_transition': {
      const targetState = command.data.state!;
      const declaredName = configStateName(targetState);
      // Resolve the id through the config the sequencer itself loaded, not the compiled enum.
      // The GUI sends a [[states]] id; SystemState is a fixed table that only agrees with it on a
      // rig that never renumbered. On one that did, every id from the first divergence up named a
      // different state: id 7 is Vent in config and FUEL_PRESS in the enum, so pressing Vent sent
      // TRANSITION:Fuel Press — and because Fuel Press is a real state here, fromName() resolved
      // it and the sequencer would have run it. A vent request executing a press is not a failure
      // mode worth keeping for the sake of a fallback.
      //
      // So once the config declares a [[states]] list it is the sole authority: an id it does not
      // declare is rejected, not rewritten through the enum. The enum fallback below stands only
      // when the config declares no states at all (legacy / unconfigured rig).
      const cfgStates = (() => {
        try {
          const r = (readConfig() as any)?.states;
          return Array.isArray(r) ? r : null;
        } catch {
          return null;
        }
      })();
      if (cfgStates && cfgStates.length > 0 && declaredName === null) {
        console.warn(`[ThinServer] state_transition rejected: id ${targetState} not in active config [[states]]`);
        send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `State transition rejected: id ${targetState} is not a state in the active config` } });
        break;
      }
      const stateName = declaredName ?? SystemState[targetState] ?? String(targetState);
      const csvName = declaredName ?? STATE_TO_CSV_NAME[stateName] ?? stateName;
      // Optional timed hold. Only appended when it is a sane integer, so a malformed value never
      // reaches the wire and every existing client stays byte-for-byte identical. This check is
      // convenience, not safety: the sequencer validates independently and is the authority on
      // which states may carry a duration at all (never the burn state).
      const holdMs = command.data.holdMs;
      let holdSuffix = '';
      if (holdMs !== undefined) {
        if (!Number.isInteger(holdMs) || holdMs <= 0 || holdMs > 3600000) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Invalid hold duration: ${holdMs}` } });
          break;
        }
        holdSuffix = `:${holdMs}`;
      }
      // No optimistic update — real state/actuator positions arrive via _SEQUENCER_STATE [0x50]
      // and [0x32] packets from Elodin. FIRE_START/FIRE_STOP are sent from the subscriber path.
      sendToSequencer(`TRANSITION:${csvName}${holdSuffix}\n`).then(({ ok, reply }) => {
        console.log(`[ThinServer] State transition ${stateName} → ${csvName}${holdSuffix}: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `State transition failed: ${refusalText(reply)}` } });
        }
      });
      break;
    }
    case 'actuator': {
      const open = command.data.actuatorState === 1 || command.data.actuatorState as unknown as string === 'open';
      const actuatorName = command.data.actuatorName!;
      // No optimistic update — real commanded state arrives via [0x32] packets from Elodin.
      sendToSequencer(`ACTUATOR:${actuatorName}:${open ? 1 : 0}\n`).then(({ ok, reply }) => {
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Actuator command failed: ${refusalText(reply)}` } });
        }
      });
      break;
    }
    case 'debug_mode': {
      const newDebug = !!command.data.debugMode;
      sendToSequencer(`DEBUG_MODE:${newDebug ? 1 : 0}\n`).then(({ ok, reply }) => {
        console.log(`[ThinServer] Debug mode ${newDebug ? 'ON' : 'OFF'}: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (ok) {
          setDebugMode(newDebug);
          broadcastStateUpdate();
        }
      }).catch(() => { });
      break;
    }
    case 'extend_fire':
      sendToSequencer('EXTEND_FIRE\n').then(({ ok, reply }) => {
        console.log(`[ThinServer] Extend fire: ${ok ? 'OK' : 'FAIL'} (${reply})`);
        if (!ok) {
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Extend fire failed: ${refusalText(reply)}` } });
        }
      });
      break;
    case 'set_countdown_target':
      setCountdownTarget(command.data.targetTimeMs ?? null);
      break;
    case 'session_start':
      sessionManager
        .start(
          !!command.data.keepData,
          command.data.durationMs ?? 0,
          !!command.data.simulated,
          !!command.data.force,
        )
        .then(() => broadcastConnectionStatus())
        .catch((err) => {
          // A config-gated refusal is not a failure to report as a one-line string: the operator
          // needs the list, grouped by the page that fixes each item, and the choice to run anyway.
          // Sent only to the client that asked — another browser did not press this button.
          if (err instanceof ConfigIssuesError) {
            const { errors, warnings } = countByLevel(err.issues);
            send(ws, {
              type: MessageType.SESSION_START_BLOCKED,
              timestamp: Date.now(),
              payload: { issues: err.issues, errors, warnings, profile: err.profile },
            });
            return;
          }
          send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Session start failed: ${err.message}` } });
        });
      break;
    case 'session_stop':
      sessionManager
        .stop(false)
        .then(() => broadcastConnectionStatus())
        .catch((err) => send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Session stop failed: ${err.message}` } }));
      break;
    case 'session_extend':
      try {
        sessionManager.extend(command.data.addMs ?? 0);
      } catch (err) {
        send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Session extend failed: ${(err as Error).message}` } });
      }
      break;
    default:
      // stub for unhandled commands (calibration, controller_frequency, etc.)
      send(ws, { type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Command not supported in thin backend: ${command.commandType}` } });
  }
}
