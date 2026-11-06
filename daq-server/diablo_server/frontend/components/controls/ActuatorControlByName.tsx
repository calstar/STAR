'use client'

import React, { useState } from 'react';
import { useSensorStore, useActuatorCommandedState, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorState, CommandPayload } from '@/lib/types';
import { useControlMode } from '@/lib/control-mode';
import { formatBallValvePosition } from '@/lib/ball-valve';

/** Config-driven actuator control: sends command by role name (config.toml actuator_roles). */
export interface ActuatorControlByNameProps {
  name: string;
  channel: number;
  entity: string;
  boardId?: number;
  /** On a BALL_VALVE board: shows % open / % closed (its position) in place of the current. */
  ballValve?: boolean;
}

export default function ActuatorControlByName({ name, channel, entity, boardId, ballValve = false }: ActuatorControlByNameProps) {
  const ws = getWebSocketClient();
  const debugMode = useSensorStore((s) => s.debugMode);
  const boardNumber = boardId != null ? ((boardId % 10) || 10) : null;
  // Subscribe to canonical commanded-state stream emitted by backend parser:
  // ACT_CMD.B<board>.CH<channel>.actuator_state_commanded, or BV_CMD.* for a ball valve
  const cmdPrefix = ballValve ? 'BV_CMD' : 'ACT_CMD';
  const commandedEntity = boardNumber != null ? `${cmdPrefix}.B${boardNumber}.CH${channel}` : entity;
  const commanded = useActuatorCommandedState(commandedEntity);
  const calEntity = entity.replace('ACT.', 'ACT_Cal.');
  const currentA = useSensorValue(calEntity, 'current_a');
  // A ball valve's ACT_Cal.{Role} aliases resolve to BV<n>_Cal.CH<m> (store.buildAliasesFromConfig).
  const positionPct = useSensorValue(calEntity, 'position_pct');
  const positionStatus = useSensorValue(calEntity, 'cal_status');
  const [pending, setPending] = useState(false);
  const { controlEnabled } = useControlMode();

  const canControl = debugMode && controlEnabled;

  const sendCommand = (state: ActuatorState) => {
    if (!canControl) return;
    const command: CommandPayload = {
      commandType: 'actuator',
      data: { actuatorName: name, actuatorState: state },
    };
    // No optimistic update — button state reflects [0x32] packets from Elodin via WebSocket.
    ws.sendCommand(command);
    setPending(true);
    window.setTimeout(() => setPending(false), 450);
  };

  const commandedOpen = commanded === ActuatorState.OPEN;
  const commandedClosed = commanded === ActuatorState.CLOSED;

  return (
    <div className="relative flex h-full min-h-0 flex-col border border-line-strong bg-[#0b0b0b] px-2 py-1 transition-colors hover:border-[#5a5a5a]">
      <div className="absolute right-2 top-1.5 flex items-center gap-1">
        {pending && <span className="text-yellow-400 text-[8px] leading-none">⟳</span>}
        <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
      </div>
      {/* min-h, not min-h-0: this is the only shrinkable row, so a short tile used to
          take all of its squeeze out of the name and draw an unlabeled valve. */}
      <div className="flex min-h-[1.25rem] flex-1 items-center overflow-hidden pr-4">
        <h3 className="truncate text-[12px] font-semibold leading-tight text-ink xl:text-[13px]">{name}</h3>
      </div>
      <div className="flex-shrink-0 flex items-center min-h-0 overflow-hidden">
        <span
          data-testid={`actuator-reading:${name}`}
          className="font-mono text-[10px] tabular-nums text-ink-3"
        >
          {ballValve
            ? formatBallValvePosition(positionPct, positionStatus, commanded)
            : currentA != null && isFinite(currentA) ? `${currentA.toFixed(2)} A` : '--- A'}
        </span>
      </div>
      <div className="mt-1 grid min-h-0 flex-shrink-0 grid-cols-2 gap-1">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          disabled={!canControl}
          className={`h-full min-h-0 border py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-[0.14em] transition-colors xl:text-[10px]
            ${commandedOpen ? (canControl ? 'border-green-500 bg-green-900/40 text-green-300' : 'border-green-800 text-green-500/70 cursor-not-allowed')
              : canControl ? 'border-line-strong text-ink-2 hover:border-[#5a5a5a] hover:bg-[#161616]' : 'border-line text-ink-4 cursor-not-allowed'}`}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          disabled={!canControl}
          className={`h-full min-h-0 border py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-[0.14em] transition-colors xl:text-[10px]
            ${commandedClosed ? (canControl ? 'border-red-500 bg-red-900/40 text-red-300' : 'border-red-800 text-red-500/70 cursor-not-allowed')
              : canControl ? 'border-line-strong text-ink-2 hover:border-[#5a5a5a] hover:bg-[#161616]' : 'border-line text-ink-4 cursor-not-allowed'}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
