'use client'

import React, { useState } from 'react';
import { useSensorStore, useActuatorCommandedState } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorState, CommandPayload } from '@/lib/types';
import { useControlMode } from '@/lib/control-mode';

/** Config-driven actuator control: sends command by role name (config.toml actuator_roles). */
export interface ActuatorControlByNameProps {
  name: string;
  channel: number;
  entity: string;
  boardId?: number;
  /** On a BALL_VALVE board: its commanded state comes from BV_CMD.* rather than ACT_CMD.*. */
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
  // The tile is the control: its colour is the commanded state -- green open, red
  // closed, grey before the first [0x32] says either -- and a click asks for the
  // other one. With no state yet a click closes; closed is the safe guess for a valve.
  const target = commandedOpen ? ActuatorState.CLOSED : commanded === ActuatorState.CLOSED ? ActuatorState.OPEN : ActuatorState.CLOSED;
  const stateLabel = commanded === null ? 'no state' : commandedOpen ? 'open' : 'closed';
  const actionLabel = target === ActuatorState.OPEN ? 'open' : 'close';
  const tone =
    commanded === null
      ? `border-line-strong bg-[#0b0b0b]${canControl ? ' hover:border-[#5a5a5a] hover:bg-[#161616]' : ''}`
      : commandedOpen
        ? `border-green-600 bg-green-950/70${canControl ? ' hover:bg-green-900/60' : ''}`
        : `border-red-700 bg-red-950/60${canControl ? ' hover:bg-red-900/50' : ''}`;

  return (
    <button
      type="button"
      onClick={() => sendCommand(target)}
      disabled={!canControl}
      data-state={stateLabel}
      aria-pressed={commanded === null ? undefined : commandedOpen}
      aria-label={`${name}: ${stateLabel}. Click to ${actionLabel}.`}
      title={canControl ? `${name} ${stateLabel} — click to ${actionLabel}` : `${name} ${stateLabel}`}
      className={`relative flex h-full min-h-0 w-full flex-col border px-2 py-1 text-left transition-colors ${tone} ${canControl ? 'cursor-pointer' : 'cursor-not-allowed'}`}
    >
      {pending && <span className="absolute right-2 top-1.5 text-yellow-400 text-[8px] leading-none">⟳</span>}
      {/* Just the name: the colour is the state. A ball valve is open or closed like any
          other valve, so its position reading is not on the tile either. */}
      <div className="flex min-h-[1.125rem] flex-1 items-center overflow-hidden pr-3 xl:min-h-4">
        <h3 className="truncate text-[12px] font-semibold leading-tight text-ink xl:text-[13px]">{name}</h3>
      </div>
    </button>
  );
}
