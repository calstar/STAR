'use client'

import React, { useState } from 'react';
import { useGetSensorValue, useSensorStore, useActuatorCommandedState } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorState, CommandPayload } from '@/lib/types';
import { useControlMode } from '@/lib/control-mode';

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
  const { controlEnabled } = useControlMode();

  const isNO = name === 'LOX Main' || name === 'LOX Press' || name === 'Fuel Main' || name === 'Fuel Vent';
  const type = isNO ? 'NO' : 'NC';

  const canControl = debugMode && controlEnabled;

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
  const showMismatch = false;

  return (
    <div className={`rounded-md p-1 border transition-colors h-full flex flex-col relative
      ${showMismatch && mismatch ? 'bg-yellow-950/40 border-yellow-600' : 'bg-background border-gray-700 hover:border-gray-600'}`}>
      <div className="absolute top-1 right-1 flex items-center gap-1">
        {pending && <span className="text-yellow-400 text-[9px] leading-none">⟳</span>}
        <div className={`w-2.5 h-2.5 rounded-full ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
      </div>
      <div className="flex-[5] flex items-center min-h-0 overflow-hidden pr-5">
        <h3 className="font-bold tracking-wider text-text uppercase leading-tight truncate" style={{ fontSize: 'clamp(8px, 2vh, 22px)' }}>{name}</h3>
        {showMismatch && mismatch && <span className="text-[10px] font-bold text-yellow-400 uppercase tracking-wider ml-1">MM</span>}
      </div>
      <div className="flex-[2] flex items-center min-h-0 overflow-hidden">
        <span className="text-[10px] text-text-muted font-mono truncate leading-none">ADC: {rawAdc.toLocaleString()}</span>
      </div>
      <div className="grid grid-cols-2 gap-0.5 flex-[3] min-h-0">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          disabled={!canControl}
          className={`h-full rounded text-[10px] font-bold uppercase tracking-wider leading-none transition-all
            ${commandedOpen ? (canControl ? 'bg-green-700 text-white ring-1 ring-green-400' : 'bg-green-700/50 text-green-300 ring-1 ring-green-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          disabled={!canControl}
          className={`h-full rounded text-[10px] font-bold uppercase tracking-wider leading-none transition-all
            ${commandedClosed ? (canControl ? 'bg-red-700 text-white ring-1 ring-red-400' : 'bg-red-700/50 text-red-300 ring-1 ring-red-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
