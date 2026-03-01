'use client'

import React, { useState } from 'react';
import { useGetSensorValue, useSensorStore, useActuatorCommandedState } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorState, CommandPayload } from '@/lib/types';

/** Config-driven actuator control: sends command by role name (config.toml actuator_roles). */
export interface ActuatorControlByNameProps {
  name: string;
  channel: number;
  entity: string;
}

export default function ActuatorControlByName({ name, channel, entity }: ActuatorControlByNameProps) {
  const ws = getWebSocketClient();
  const getSensorValue = useGetSensorValue();
  const debugMode = useSensorStore((s) => s.debugMode);
  const setActuatorState = useSensorStore((s) => s.setActuatorState);
  const setActuatorCommandedOverride = useSensorStore((s) => s.setActuatorCommandedOverride);
  const commanded = useActuatorCommandedState(entity);
  const [pending, setPending] = useState(false);

  // Determine if NO (Normally Open) based on name
  const isNO = name === 'LOX Main' || name === 'LOX Press' || name === 'Fuel Main';
  const type = isNO ? 'NO' : 'NC';

  const canControl = debugMode;

  const rawAdc = getSensorValue(entity, 'raw_adc_counts')
    ?? getSensorValue(`ACT.ACT_CH${channel}`, 'raw_adc_counts')
    ?? 0;
  const statusRaw = getSensorValue(entity, 'status')
    ?? getSensorValue(`ACT.ACT_CH${channel}`, 'status');
  const voltageThreshold = 50000000;
  const isPowered = statusRaw === 1 || rawAdc > voltageThreshold;

  // feedbackOpen depends on NC/NO
  const feedbackOpen = type === 'NO' ? !isPowered : isPowered;

  const sendCommand = (state: ActuatorState) => {
    if (!canControl) return;
    const command: CommandPayload = {
      commandType: 'actuator',
      data: { actuatorName: name, actuatorState: state },
    };
    ws.sendCommand(command);
    setActuatorState(entity, state);
    if (debugMode) setActuatorCommandedOverride(entity, state);
    setPending(true);
    setTimeout(() => setPending(false), 1000);
  };

  const commandedOpen = commanded === ActuatorState.OPEN;
  const commandedClosed = commanded === ActuatorState.CLOSED;
  const mismatch = commanded !== null && !pending &&
    ((commandedOpen && !feedbackOpen) || (commandedClosed && feedbackOpen));

  return (
    <div className={`rounded-lg p-3 border transition-colors
      ${mismatch ? 'bg-yellow-950/40 border-yellow-600' : 'bg-background border-gray-700 hover:border-gray-600'}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-bold tracking-wider text-text uppercase">{name}</h3>
        {mismatch && <span className="text-xs font-bold text-yellow-400 uppercase tracking-wider">MISMATCH</span>}
      </div>
      <div className="flex gap-3 mb-3 text-base">
        <div className="flex-1">
          <div className="text-text-muted mb-1">COMMANDED</div>
          <div className={`flex items-center gap-2 ${commanded === null ? 'text-gray-500' : commandedOpen ? 'text-green-400' : 'text-red-400'}`}>
            <div className={`w-2.5 h-2.5 rounded-full ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="font-mono font-bold">{commanded === null ? '---' : commandedOpen ? 'OPEN' : 'CLOSED'}</span>
            {pending && <span className="text-yellow-400 text-xs">⟳</span>}
          </div>
        </div>
      </div>
      <div className="text-sm text-text-muted font-mono mb-2.5">ADC: {rawAdc.toLocaleString()}</div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          disabled={!canControl}
          className={`py-2.5 rounded text-base font-bold uppercase tracking-wider transition-all
            ${commandedOpen ? (canControl ? 'bg-green-700 text-white ring-2 ring-green-400' : 'bg-green-700/50 text-green-300 ring-2 ring-green-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          disabled={!canControl}
          className={`py-2.5 rounded text-base font-bold uppercase tracking-wider transition-all
            ${commandedClosed ? (canControl ? 'bg-red-700 text-white ring-2 ring-red-400' : 'bg-red-700/50 text-red-300 ring-2 ring-red-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
