'use client'

import React, { useState } from 'react';
import { useSensorStore, useActuatorCommandedState, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorState, CommandPayload } from '@/lib/types';
import { useControlMode } from '@/lib/control-mode';

/** Config-driven actuator control: sends command by role name (config.toml actuator_roles). */
export interface ActuatorControlByNameProps {
  name: string;
  channel: number;
  entity: string;
  boardId?: number;
}

export default function ActuatorControlByName({ name, channel, entity, boardId }: ActuatorControlByNameProps) {
  const ws = getWebSocketClient();
  const debugMode = useSensorStore((s) => s.debugMode);
  const boardNumber = boardId != null ? ((boardId % 10) || 10) : null;
  // Subscribe to canonical commanded-state stream emitted by backend parser:
  // ACT_CMD.B<board>.CH<channel>.actuator_state_commanded
  const commandedEntity = boardNumber != null ? `ACT_CMD.B${boardNumber}.CH${channel}` : entity;
  const commanded = useActuatorCommandedState(commandedEntity);
  const calEntity = entity.replace('ACT.', 'ACT_Cal.');
  const currentA = useSensorValue(calEntity, 'current_a');
  const [pending, setPending] = useState(false);
  const { controlEnabled } = useControlMode();

  const canControl = debugMode && controlEnabled;

  const sendCommand = (state: ActuatorState) => {
    if (!canControl) return;
    const command: CommandPayload = {
      commandType: 'actuator',
      data: { actuatorName: name, actuatorState: state },
    };
    const val = state === ActuatorState.OPEN ? 1 : 0;
    if (boardNumber != null) {
      useSensorStore.getState().updateSensor({
        entity: commandedEntity,
        component: 'actuator_state_commanded',
        value: val,
        timestamp: Date.now(),
      });
    }
    ws.sendCommand(command);
    setPending(true);
    window.setTimeout(() => setPending(false), 450);
  };

  const commandedOpen = commanded === ActuatorState.OPEN;
  const commandedClosed = commanded === ActuatorState.CLOSED;

  return (
    <div className="rounded border border-gray-700 hover:border-gray-600 transition-colors h-full min-h-0 flex flex-col relative p-0.5 bg-background">
      <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5">
        {pending && <span className="text-yellow-400 text-[8px] leading-none">⟳</span>}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
      </div>
      <div className="flex-1 flex items-center min-h-0 overflow-hidden pr-4 flex-shrink-0">
        <h3 className="font-bold tracking-wider text-text uppercase leading-tight truncate text-[9px] xl:text-[10px]">{name}</h3>
      </div>
      <div className="flex-shrink-0 flex items-center min-h-0 overflow-hidden px-0.5">
        <span className="text-[9px] tabular-nums text-yellow-400 font-mono">
          {currentA != null && isFinite(currentA) ? `${currentA.toFixed(2)} A` : '--- A'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-0.5 flex-shrink-0 min-h-0">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          disabled={!canControl}
          className={`h-full min-h-0 rounded text-[8px] xl:text-[9px] font-bold uppercase tracking-wider leading-none transition-all py-0.5
            ${commandedOpen ? (canControl ? 'bg-green-700 text-white ring-1 ring-green-400' : 'bg-green-700/50 text-green-300 ring-1 ring-green-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          disabled={!canControl}
          className={`h-full min-h-0 rounded text-[8px] xl:text-[9px] font-bold uppercase tracking-wider leading-none transition-all py-0.5
            ${commandedClosed ? (canControl ? 'bg-red-700 text-white ring-1 ring-red-400' : 'bg-red-700/50 text-red-300 ring-1 ring-red-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
