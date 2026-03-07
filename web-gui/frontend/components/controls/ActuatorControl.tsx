'use client'

import React, { useState, useEffect } from 'react';
import { useSensorStore, useSensorValue, useActuatorCommandedState } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { getActuatorOpenThreshold } from '@/lib/voltageRef';
import { ActuatorId, ActuatorState, CommandPayload, SystemState } from '@/lib/types';
import { useControlMode } from '@/lib/control-mode';

// Human-readable names
const ACTUATOR_NAMES: Record<ActuatorId, string> = {
  [ActuatorId.LOX_MAIN]: 'LOX Main',
  [ActuatorId.FUEL_MAIN]: 'Fuel Main',
  [ActuatorId.LOX_VENT]: 'LOX Vent',
  [ActuatorId.FUEL_VENT]: 'Fuel Vent',
  [ActuatorId.LOX_PRESS]: 'LOX Press',
  [ActuatorId.FUEL_PRESS]: 'Fuel Press',
  [ActuatorId.GSE_LOW_VENT]: 'GN2 Vent',
  [ActuatorId.FUEL_FILL_VENT]: 'Fuel Fill Vent',
  [ActuatorId.FUEL_FILL_PRESS]: 'Fuel Fill Press',
  [ActuatorId.LOX_FILL]: 'LOX Fill',
  [ActuatorId.LOX_DUMP]: 'LOX Dump',
  [ActuatorId.GSE_HIGH_PRESS_VENT]: 'GSE High Press Vent',
  [ActuatorId.GSE_LOX_FILL_VENT]: 'GSE LOX Fill Vent',
  [ActuatorId.GSE_HIGH_PRESS_CONTROL]: 'GSE High Press Control',
  [ActuatorId.GSE_MED_PRESS_CONTROL]: 'GSE Med Press Control',
  [ActuatorId.TEST_ACTUATOR_2]: 'Test Actuator 2',
};

// Named entity in sensor data (works with store aliases → falls back to ACT_CHX)
const ACTUATOR_ENTITIES: Record<ActuatorId, string> = {
  [ActuatorId.LOX_MAIN]: 'ACT.LOX_Main',
  [ActuatorId.FUEL_MAIN]: 'ACT.Fuel_Main',
  [ActuatorId.LOX_VENT]: 'ACT.LOX_Vent',
  [ActuatorId.FUEL_VENT]: 'ACT.Fuel_Vent',
  [ActuatorId.LOX_PRESS]: 'ACT.LOX_Press',
  [ActuatorId.FUEL_PRESS]: 'ACT.Fuel_Press',
  [ActuatorId.GSE_LOW_VENT]: 'ACT.GN2_Vent',
  [ActuatorId.FUEL_FILL_VENT]: 'ACT.Fuel_Fill_Vent',
  [ActuatorId.FUEL_FILL_PRESS]: 'ACT.Fuel_Fill_Press',
  [ActuatorId.LOX_FILL]: 'ACT.LOX_Fill',
  [ActuatorId.LOX_DUMP]: 'ACT.LOX_Dump',
  [ActuatorId.GSE_HIGH_PRESS_VENT]: 'ACT.GSE_High_Press_Vent',
  [ActuatorId.GSE_LOX_FILL_VENT]: 'ACT.GSE_LOX_Fill_Vent',
  [ActuatorId.GSE_HIGH_PRESS_CONTROL]: 'ACT.GSE_High_Press_Control',
  [ActuatorId.GSE_MED_PRESS_CONTROL]: 'ACT.GSE_Med_Press_Control',
  [ActuatorId.TEST_ACTUATOR_2]: 'ACT.Test_Actuator_2',
};

// Channel-number entity (direct fallback for actuator board data)
const ACTUATOR_CHANNELS: Record<ActuatorId, number> = {
  [ActuatorId.LOX_MAIN]: 1,
  [ActuatorId.FUEL_MAIN]: 7,
  [ActuatorId.LOX_VENT]: 6,
  [ActuatorId.FUEL_VENT]: 2,
  [ActuatorId.LOX_PRESS]: 8,
  [ActuatorId.FUEL_PRESS]: 3,
  [ActuatorId.GSE_LOW_VENT]: 5,
  [ActuatorId.FUEL_FILL_VENT]: 9,
  [ActuatorId.FUEL_FILL_PRESS]: 10,
  [ActuatorId.LOX_FILL]: 4,
  [ActuatorId.LOX_DUMP]: 4,
  [ActuatorId.GSE_HIGH_PRESS_VENT]: 5,
  [ActuatorId.GSE_LOX_FILL_VENT]: 5,
  [ActuatorId.GSE_HIGH_PRESS_CONTROL]: 5,
  [ActuatorId.GSE_MED_PRESS_CONTROL]: 5,
  [ActuatorId.TEST_ACTUATOR_2]: 1,
};

const ACTUATOR_TYPES: Record<ActuatorId, 'NC' | 'NO'> = {
  [ActuatorId.LOX_MAIN]: 'NO',
  [ActuatorId.FUEL_MAIN]: 'NO',
  [ActuatorId.LOX_VENT]: 'NC',
  [ActuatorId.FUEL_VENT]: 'NO',
  [ActuatorId.LOX_PRESS]: 'NO',
  [ActuatorId.FUEL_PRESS]: 'NC',
  [ActuatorId.GSE_LOW_VENT]: 'NC',
  [ActuatorId.FUEL_FILL_VENT]: 'NC',
  [ActuatorId.FUEL_FILL_PRESS]: 'NC',
  [ActuatorId.LOX_FILL]: 'NC',
  [ActuatorId.LOX_DUMP]: 'NC',
  [ActuatorId.GSE_HIGH_PRESS_VENT]: 'NC',
  [ActuatorId.GSE_LOX_FILL_VENT]: 'NC',
  [ActuatorId.GSE_HIGH_PRESS_CONTROL]: 'NC',
  [ActuatorId.GSE_MED_PRESS_CONTROL]: 'NC',
  [ActuatorId.TEST_ACTUATOR_2]: 'NC',
};

interface ActuatorControlProps {
  actuatorId: ActuatorId;
}

export default function ActuatorControl({ actuatorId }: ActuatorControlProps) {
  const ws = getWebSocketClient();
  const debugMode = useSensorStore((s) => s.debugMode);
  const currentState = useSensorStore((s) => s.currentState);
  const actuatorExpectedPositions = useSensorStore((s) => s.actuatorExpectedPositions);
  const boards = useSensorStore((s) => s.boards as Record<number, { designatedSurvivor?: boolean; voltageReference?: number }>);
  const voltageRefNominals = useSensorStore((s) => s.voltageRefNominals);
  const setActuatorState = useSensorStore((s) => s.setActuatorState);
  const setActuatorCommandedOverride = useSensorStore((s) => s.setActuatorCommandedOverride);
  const { controlEnabled } = useControlMode();
  const [pending, setPending] = useState(false);

  const entity = ACTUATOR_ENTITIES[actuatorId];
  const ch = ACTUATOR_CHANNELS[actuatorId];
  const type = ACTUATOR_TYPES[actuatorId] || 'NC';
  const commanded = useActuatorCommandedState(entity);

  const stateExpected = currentState != null ? (actuatorExpectedPositions[currentState] ?? {}) : {};
  const expected = stateExpected[entity] ?? null;

  const canControl = debugMode && controlEnabled;

  // Subscribe only to these keys so we re-render only when this actuator's data changes
  const adcNamed = useSensorValue(entity, 'raw_adc_counts');
  const statusNamed = useSensorValue(entity, 'status');
  const adcChannel = useSensorValue(`ACT.ACT_CH${ch}`, 'raw_adc_counts');
  const statusChannel = useSensorValue(`ACT.ACT_CH${ch}`, 'status');
  const rawAdc = adcNamed ?? adcChannel ?? 0;
  const statusRaw = statusNamed ?? statusChannel;

  // Actuator open threshold from designated survivor board's voltage reference (0=internal, 1=VDD raw, 2=5V); nominals from config [adc]
  const actuatorBoard = boards ? Object.values(boards).find((b) => b.designatedSurvivor) : null;
  const voltageRef = actuatorBoard?.voltageReference ?? 0;
  const openThreshold = getActuatorOpenThreshold(voltageRef, voltageRefNominals);
  const isPowered = statusRaw === 1 || rawAdc > openThreshold;
  // feedbackOpen depends on NC/NO: NC: Powered = OPEN; NO: Powered = CLOSED
  const feedbackOpen = type === 'NO' ? !isPowered : isPowered;

  const sendCommand = (state: ActuatorState) => {
    if (!canControl) return;
    const command: CommandPayload = {
      commandType: 'actuator',
      data: { actuatorId, actuatorName: ACTUATOR_NAMES[actuatorId], actuatorState: state },
    };
    ws.sendCommand(command);
    setActuatorState(entity, state);
    if (debugMode) setActuatorCommandedOverride(entity, state);
    setPending(true);
    setTimeout(() => setPending(false), 1000);
  };

  const commandedOpen = commanded === ActuatorState.OPEN;
  const commandedClosed = commanded === ActuatorState.CLOSED;

  // Mismatch = commanded ≠ feedback (only show if command was actually issued)
  const mismatch = commanded !== null && pending === false &&
    ((commandedOpen && !feedbackOpen) || (commandedClosed && feedbackOpen));
  const showMismatch = false;

  return (
    <div className={`rounded border transition-colors h-full min-h-0 flex flex-col relative p-0.5
      ${showMismatch && mismatch
        ? 'bg-yellow-950/40 border-yellow-600'
        : 'bg-background border-gray-700 hover:border-gray-600'}`}>
      <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5">
        {pending && <span className="text-yellow-400 text-[8px] leading-none">⟳</span>}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
      </div>
      <div className="flex-1 flex items-center min-h-0 overflow-hidden pr-4 flex-shrink-0">
        <h3 className="font-bold tracking-wider text-text uppercase leading-tight truncate text-[9px] xl:text-[10px]">
          {ACTUATOR_NAMES[actuatorId]}
        </h3>
        {showMismatch && mismatch && (
          <span className="text-[8px] font-bold text-yellow-400 uppercase ml-0.5">MM</span>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center min-h-0 overflow-hidden">
        <span className="text-[8px] text-text-muted font-mono truncate leading-none">
          ADC: {rawAdc.toLocaleString()}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-0.5 flex-shrink-0 min-h-0">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          disabled={!canControl}
          className={`h-full min-h-0 rounded text-[8px] xl:text-[9px] font-bold uppercase tracking-wider leading-none transition-all py-0.5
            ${commandedOpen
              ? canControl
                ? 'bg-green-700 text-white ring-1 ring-green-400'
                : 'bg-green-700/50 text-green-300 ring-1 ring-green-700 cursor-not-allowed'
              : canControl
                ? 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          disabled={!canControl}
          className={`h-full min-h-0 rounded text-[8px] xl:text-[9px] font-bold uppercase tracking-wider leading-none transition-all py-0.5
            ${commandedClosed
              ? canControl
                ? 'bg-red-700 text-white ring-1 ring-red-400'
                : 'bg-red-700/50 text-red-300 ring-1 ring-red-700 cursor-not-allowed'
              : canControl
                ? 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
