'use client'

import React, { useState } from 'react';
import { useGetSensorValue, useSensorStore } from '@/lib/store';
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
  const currentState = useSensorStore((s) => s.currentState);
  const actuatorExpectedPositions = useSensorStore((s) => s.actuatorExpectedPositions);

  const [manualCommanded, setManualCommanded] = useState<ActuatorState | null>(null);
  const [pending, setPending] = useState(false);

  const stateExpected = currentState != null ? (actuatorExpectedPositions[currentState] ?? {}) : {};
  const expected = stateExpected[entity] ?? null;

  // Determine if NO (Normally Open) based on name
  const isNO = name === 'LOX Main' || name === 'LOX Press' || name === 'Fuel Main';
  const type = isNO ? 'NO' : 'NC';

  React.useEffect(() => {
    if (!debugMode) setManualCommanded(null);
  }, [debugMode]);

  React.useEffect(() => {
    if (debugMode && currentState !== null) setManualCommanded(null);
  }, [debugMode, currentState]);

  const commandedState = React.useMemo(() => {
    if (expected === 'open') return ActuatorState.OPEN;
    if (expected === 'closed') return ActuatorState.CLOSED;
    return null;
  }, [expected]);

  const commanded = React.useMemo(() => {
    if (debugMode) return manualCommanded ?? commandedState;
    return commandedState;
  }, [debugMode, manualCommanded, commandedState]);

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
    if (debugMode) setManualCommanded(state);
    setPending(true);
    setTimeout(() => setPending(false), 1000);
  };

  const commandedOpen = commanded === ActuatorState.OPEN;
  const commandedClosed = commanded === ActuatorState.CLOSED;
  const mismatch = commanded !== null && !pending &&
    ((commandedOpen && !feedbackOpen) || (commandedClosed && feedbackOpen));
  const showMismatch = false;

  return (
    <div className={`rounded-md p-1 border transition-colors
      ${showMismatch && mismatch ? 'bg-yellow-950/40 border-yellow-600' : 'bg-background border-gray-700 hover:border-gray-600'}`}>
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1 min-w-0">
          <h3 className="text-[10px] font-bold tracking-wider text-text uppercase leading-tight truncate">{name}</h3>
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
          {pending && <span className="text-yellow-400 text-[9px] leading-none">⟳</span>}
        </div>
        {showMismatch && mismatch && <span className="text-[10px] font-bold text-yellow-400 uppercase tracking-wider">MM</span>}
      </div>
      <div className="text-[10px] text-text-muted font-mono mb-0.5 truncate leading-none">ADC: {rawAdc.toLocaleString()}</div>
      <div className="grid grid-cols-2 gap-0.5 mt-0.5">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          disabled={!canControl}
          className={`py-1 rounded text-[10px] font-bold uppercase tracking-wider leading-none transition-all
            ${commandedOpen ? (canControl ? 'bg-green-700 text-white ring-1 ring-green-400' : 'bg-green-700/50 text-green-300 ring-1 ring-green-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          disabled={!canControl}
          className={`py-1 rounded text-[10px] font-bold uppercase tracking-wider leading-none transition-all
            ${commandedClosed ? (canControl ? 'bg-red-700 text-white ring-1 ring-red-400' : 'bg-red-700/50 text-red-300 ring-1 ring-red-700 cursor-not-allowed')
              : canControl ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
