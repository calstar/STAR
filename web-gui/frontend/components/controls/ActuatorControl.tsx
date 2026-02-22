'use client'

import React, { useState, useEffect } from 'react';
import { useGetSensorValue, useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorId, ActuatorState, CommandPayload, SystemState } from '@/lib/types';

// Human-readable names
const ACTUATOR_NAMES: Record<ActuatorId, string> = {
  [ActuatorId.LOX_MAIN]:              'LOX Main',
  [ActuatorId.FUEL_MAIN]:             'Fuel Main',
  [ActuatorId.LOX_VENT]:              'LOX Vent',
  [ActuatorId.FUEL_VENT]:             'Fuel Vent',
  [ActuatorId.LOX_PRESS]:             'LOX Press',
  [ActuatorId.FUEL_PRESS]:            'Fuel Press',
  [ActuatorId.GSE_LOW_VENT]:          'GN2 Vent',
  [ActuatorId.FUEL_FILL_VENT]:        'Fuel Fill Vent',
  [ActuatorId.FUEL_FILL_PRESS]:       'Fuel Fill Press',
  [ActuatorId.LOX_FILL]:              'LOX Fill',
  [ActuatorId.LOX_DUMP]:              'LOX Dump',
  [ActuatorId.GSE_HIGH_PRESS_VENT]:   'GSE High Press Vent',
  [ActuatorId.GSE_LOX_FILL_VENT]:     'GSE LOX Fill Vent',
  [ActuatorId.GSE_HIGH_PRESS_CONTROL]:'GSE High Press Control',
  [ActuatorId.GSE_MED_PRESS_CONTROL]: 'GSE Med Press Control',
  [ActuatorId.TEST_ACTUATOR_2]: 'Test Actuator 2',
};

// Named entity in sensor data (works with store aliases → falls back to ACT_CHX)
const ACTUATOR_ENTITIES: Record<ActuatorId, string> = {
  [ActuatorId.LOX_MAIN]:              'ACT.LOX_Main',
  [ActuatorId.FUEL_MAIN]:             'ACT.Fuel_Main',
  [ActuatorId.LOX_VENT]:              'ACT.LOX_Vent',
  [ActuatorId.FUEL_VENT]:             'ACT.Fuel_Vent',
  [ActuatorId.LOX_PRESS]:             'ACT.LOX_Press',
  [ActuatorId.FUEL_PRESS]:            'ACT.Fuel_Press',
  [ActuatorId.GSE_LOW_VENT]:          'ACT.GSE_Low_Vent',
  [ActuatorId.FUEL_FILL_VENT]:        'ACT.Fuel_Fill_Vent',
  [ActuatorId.FUEL_FILL_PRESS]:       'ACT.Fuel_Fill_Press',
  [ActuatorId.LOX_FILL]:              'ACT.LOX_Fill',
  [ActuatorId.LOX_DUMP]:              'ACT.LOX_Dump',
  [ActuatorId.GSE_HIGH_PRESS_VENT]:   'ACT.GSE_High_Press_Vent',
  [ActuatorId.GSE_LOX_FILL_VENT]:     'ACT.GSE_LOX_Fill_Vent',
  [ActuatorId.GSE_HIGH_PRESS_CONTROL]:'ACT.GSE_High_Press_Control',
  [ActuatorId.GSE_MED_PRESS_CONTROL]: 'ACT.GSE_Med_Press_Control',
  [ActuatorId.TEST_ACTUATOR_2]: 'ACT.Test_Actuator_2',
};

// Channel-number entity (direct fallback for actuator board data)
const ACTUATOR_CHANNELS: Record<ActuatorId, number> = {
  [ActuatorId.LOX_MAIN]:              1,
  [ActuatorId.FUEL_MAIN]:             7,
  [ActuatorId.LOX_VENT]:              6,
  [ActuatorId.FUEL_VENT]:             2,
  [ActuatorId.LOX_PRESS]:             8,
  [ActuatorId.FUEL_PRESS]:            3,
  [ActuatorId.GSE_LOW_VENT]:          5,
  [ActuatorId.FUEL_FILL_VENT]:        9,
  [ActuatorId.FUEL_FILL_PRESS]:       10,
  [ActuatorId.LOX_FILL]:              4,
  [ActuatorId.LOX_DUMP]:              4,
  [ActuatorId.GSE_HIGH_PRESS_VENT]:   5,
  [ActuatorId.GSE_LOX_FILL_VENT]:     5,
  [ActuatorId.GSE_HIGH_PRESS_CONTROL]:5,
  [ActuatorId.GSE_MED_PRESS_CONTROL]: 5,
  [ActuatorId.TEST_ACTUATOR_2]: 1,
};

interface ActuatorControlProps {
  actuatorId: ActuatorId;
}

export default function ActuatorControl({ actuatorId }: ActuatorControlProps) {
  const ws = getWebSocketClient();
  const getSensorValue = useGetSensorValue();
  const debugMode = useSensorStore((s) => s.debugMode);
  const currentState = useSensorStore((s) => s.currentState);
  const actuatorExpectedPositions = useSensorStore((s) => s.actuatorExpectedPositions);

  // Manual commanded state for DEBUG mode only
  const [manualCommanded, setManualCommanded] = useState<ActuatorState | null>(null);
  const [pending, setPending] = useState(false);

  const entity = ACTUATOR_ENTITIES[actuatorId];
  const ch = ACTUATOR_CHANNELS[actuatorId];

  // Get expected position from backend (CSV-based) - computed directly from store
  const stateExpected = currentState != null ? (actuatorExpectedPositions[currentState] ?? {}) : {};
  const expected = stateExpected[entity] ?? null;

  // Clear manual commanded state when exiting debug mode
  // When state changes in debug mode, clear manual override so new state's expected position shows
  React.useEffect(() => {
    if (!debugMode) {
      setManualCommanded(null);
    }
  }, [debugMode]);

  // When state changes in debug mode, clear manual override to show new state's expected position
  React.useEffect(() => {
    if (debugMode && currentState !== null) {
      setManualCommanded(null);
    }
  }, [debugMode, currentState]);

  // Debug logging
  React.useEffect(() => {
    if (currentState !== null && !debugMode) {
      console.log(`[ActuatorControl ${ACTUATOR_NAMES[actuatorId]}] State: ${SystemState[currentState]}, Entity: ${entity}, Expected: ${expected}, StateExpected:`, stateExpected);
    }
  }, [currentState, entity, expected, stateExpected, actuatorId, debugMode]);

  // Compute commanded state directly from expected position (reactive to store changes)
  // Always compute expected position from state, even in debug mode (so user can see what state expects)
  const commandedState = React.useMemo(() => {
    if (expected === 'open') {
      return ActuatorState.OPEN;
    } else if (expected === 'closed') {
      return ActuatorState.CLOSED;
    }
    return null;
  }, [expected]);

  // In debug mode, manualCommanded overrides the expected position
  // Otherwise, use the expected position from the state
  const commanded = React.useMemo(() => {
    if (debugMode) {
      // In debug mode: show manual override if set, otherwise show expected position for current state
      return manualCommanded ?? commandedState;
    }
    // In normal mode: always use expected position
    return commandedState;
  }, [debugMode, manualCommanded, commandedState]);

  // Allow manual control when debug mode is enabled
  const canControl = debugMode;

  // Feedback: try named entity first (aliases in store.ts cover the ACT_CHX fallback)
  const rawAdc = getSensorValue(entity, 'raw_adc_counts')
    ?? getSensorValue(`ACT.ACT_CH${ch}`, 'raw_adc_counts')
    ?? 0;
  const statusRaw = getSensorValue(entity, 'status')
    ?? getSensorValue(`ACT.ACT_CH${ch}`, 'status');

  // Convert ADC to voltage (32-bit ADC, 0-3.3V range, reference voltage)
  // Combined_gui uses voltage threshold: typically > 0.1V means actuator is ON
  // For 32-bit ADC: voltage = (rawAdc / 2^32) * 3.3V
  // Threshold: > 0.1V = rawAdc > (0.1 / 3.3) * 2^32 ≈ 130,000,000
  // But we see values like 1,168,235,832 which is ~0.9V, so threshold should be lower
  // Use threshold: > 50,000,000 (about 0.04V) to detect actuator ON
  const voltageThreshold = 50000000; // ~0.04V
  const feedbackOpen = statusRaw === 1 || rawAdc > voltageThreshold;

  const sendCommand = (state: ActuatorState) => {
    if (!canControl) return;
    const command: CommandPayload = {
      commandType: 'actuator',
      data: { actuatorId, actuatorState: state },
    };
    ws.sendCommand(command);
    if (debugMode) {
      setManualCommanded(state);
    }
    setPending(true);
    // Clear pending after 1 s (feedback should have arrived by then)
    setTimeout(() => setPending(false), 1000);
  };

  const commandedOpen = commanded === ActuatorState.OPEN;
  const commandedClosed = commanded === ActuatorState.CLOSED;

  // Mismatch = commanded ≠ feedback (only show if command was actually issued)
  const mismatch = commanded !== null && pending === false &&
    ((commandedOpen && !feedbackOpen) || (commandedClosed && feedbackOpen));

  return (
    <div className={`rounded-lg p-3 border transition-colors
      ${mismatch
        ? 'bg-yellow-950/40 border-yellow-600'
        : 'bg-background border-gray-700 hover:border-gray-600'}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-bold tracking-wider text-text uppercase">
          {ACTUATOR_NAMES[actuatorId]}
        </h3>
        {mismatch && (
          <span className="text-xs font-bold text-yellow-400 uppercase tracking-wider">MISMATCH</span>
        )}
      </div>

      {/* Feedback indicator */}
      <div className="flex gap-3 mb-3 text-base">
        <div className="flex-1">
          <div className="text-text-muted mb-1">COMMANDED</div>
          <div className={`flex items-center gap-2 ${commanded === null ? 'text-gray-500' : commandedOpen ? 'text-green-400' : 'text-red-400'}`}>
            <div className={`w-2.5 h-2.5 rounded-full ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="font-mono font-bold">
              {commanded === null ? '---' : commandedOpen ? 'OPEN' : 'CLOSED'}
            </span>
            {pending && <span className="text-yellow-400 text-xs">⟳</span>}
          </div>
        </div>
      </div>

      {/* ADC readout */}
      <div className="text-sm text-text-muted font-mono mb-2.5">
        ADC: {rawAdc.toLocaleString()}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          disabled={!canControl}
          className={`py-2.5 rounded text-base font-bold uppercase tracking-wider transition-all
            ${commandedOpen
              ? canControl
                ? 'bg-green-700 text-white ring-2 ring-green-400'
                : 'bg-green-700/50 text-green-300 ring-2 ring-green-700 cursor-not-allowed'
              : canControl
                ? 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                : 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'}`}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          disabled={!canControl}
          className={`py-2.5 rounded text-base font-bold uppercase tracking-wider transition-all
            ${commandedClosed
              ? canControl
                ? 'bg-red-700 text-white ring-2 ring-red-400'
                : 'bg-red-700/50 text-red-300 ring-2 ring-red-700 cursor-not-allowed'
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
