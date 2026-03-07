'use client'

import React, { useState } from 'react';
import { useSensorStore, useSensorValue, useActuatorCommandedState } from '@/lib/store';
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
  const debugMode = useSensorStore((s) => s.debugMode);
  const setActuatorState = useSensorStore((s) => s.setActuatorState);
  const setActuatorCommandedOverride = useSensorStore((s) => s.setActuatorCommandedOverride);
  const commanded = useActuatorCommandedState(entity);
  const [pending, setPending] = useState(false);
  const { controlEnabled } = useControlMode();

  const adcNamed = useSensorValue(entity, 'raw_adc_counts');
  const statusNamed = useSensorValue(entity, 'status');
  const adcChannel = useSensorValue(`ACT.ACT_CH${channel}`, 'raw_adc_counts');
  const statusChannel = useSensorValue(`ACT.ACT_CH${channel}`, 'status');
  const rawAdc = adcNamed ?? adcChannel ?? 0;
  const statusRaw = statusNamed ?? statusChannel;

  const isNO = name === 'LOX Main' || name === 'LOX Press' || name === 'Fuel Main' || name === 'Fuel Vent';
  const type = isNO ? 'NO' : 'NC';

  const canControl = debugMode && controlEnabled;
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
    <div className={`rounded border transition-colors h-full min-h-0 flex flex-col relative p-0.5
      ${showMismatch && mismatch ? 'bg-yellow-950/40 border-yellow-600' : 'bg-background border-gray-700 hover:border-gray-600'}`}>
      <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5">
        {pending && <span className="text-yellow-400 text-[8px] leading-none">⟳</span>}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
      </div>
      <div className="flex-1 flex items-center min-h-0 overflow-hidden pr-4 flex-shrink-0">
        <h3 className="font-bold tracking-wider text-text uppercase leading-tight truncate text-[9px] xl:text-[10px]">{name}</h3>
        {showMismatch && mismatch && <span className="text-[8px] font-bold text-yellow-400 uppercase ml-0.5">MM</span>}
      </div>
      <div className="flex-shrink-0 flex items-center min-h-0 overflow-hidden">
        <span className="text-[8px] text-text-muted font-mono truncate leading-none">ADC: {rawAdc.toLocaleString()}</span>
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
