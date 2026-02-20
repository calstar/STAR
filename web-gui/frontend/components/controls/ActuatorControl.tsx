'use client'

import { useState, useEffect } from 'react';
import { useGetSensorValue, useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorId, ActuatorState, CommandPayload, SystemState } from '@/lib/types';

// Human-readable names
const ACTUATOR_NAMES: Record<ActuatorId, string> = {
  [ActuatorId.LOX_MAIN]:    'LOX Main',
  [ActuatorId.FUEL_MAIN]:   'Fuel Main',
  [ActuatorId.LOX_VENT]:    'LOX Vent',
  [ActuatorId.FUEL_VENT]:   'Fuel Vent',
  [ActuatorId.LOX_PRESS]:   'LOX Press',
  [ActuatorId.FUEL_PRESS]:  'Fuel Press',
  [ActuatorId.GSE_LOW_VENT]:'GN2 Vent',
};

// Named entity in sensor data (works with store aliases → falls back to ACT_CHX)
const ACTUATOR_ENTITIES: Record<ActuatorId, string> = {
  [ActuatorId.LOX_MAIN]:    'ACT.LOX_Main',
  [ActuatorId.FUEL_MAIN]:   'ACT.Fuel_Main',
  [ActuatorId.LOX_VENT]:    'ACT.LOX_Vent',
  [ActuatorId.FUEL_VENT]:   'ACT.Fuel_Vent',
  [ActuatorId.LOX_PRESS]:   'ACT.LOX_Press',
  [ActuatorId.FUEL_PRESS]:  'ACT.Fuel_Press',
  [ActuatorId.GSE_LOW_VENT]:'ACT.GSE_Low_Vent',
};

// Channel-number entity (direct fallback for actuator board data)
const ACTUATOR_CHANNELS: Record<ActuatorId, number> = {
  [ActuatorId.LOX_MAIN]:    1,
  [ActuatorId.FUEL_MAIN]:   7,
  [ActuatorId.LOX_VENT]:    6,
  [ActuatorId.FUEL_VENT]:   2,
  [ActuatorId.LOX_PRESS]:   8,
  [ActuatorId.FUEL_PRESS]:  3,
  [ActuatorId.GSE_LOW_VENT]:5,
};

interface ActuatorControlProps {
  actuatorId: ActuatorId;
}

export default function ActuatorControl({ actuatorId }: ActuatorControlProps) {
  const ws = getWebSocketClient();
  const getSensorValue = useGetSensorValue();
  const debugMode = useSensorStore((s) => s.debugMode);

  // Commanded state tracks what we last told the actuator to do OR what system state requires
  const [commanded, setCommanded] = useState<ActuatorState | null>(null);
  const [pending, setPending] = useState(false);
  const currentState = useSensorStore((s) => s.currentState);

  const entity = ACTUATOR_ENTITIES[actuatorId];
  const ch = ACTUATOR_CHANNELS[actuatorId];

  // Expected position based on system state (from ActuatorStatePanel logic)
  const EXPECTED_POSITIONS: Record<number, Record<string, 'open' | 'closed' | null>> = {
    [SystemState.IDLE]:    { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed', 'ACT.GSE_Low_Vent': 'closed' },
    [SystemState.ARMED]:   { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed', 'ACT.GSE_Low_Vent': 'closed' },
    [SystemState.FUEL_FILL]:     { 'ACT.Fuel_Main': 'open', 'ACT.LOX_Main': 'closed' },
    [SystemState.OX_FILL]:       { 'ACT.LOX_Main': 'open', 'ACT.Fuel_Main': 'closed' },
    [SystemState.GN2_LOW_PRESS]: { 'ACT.Fuel_Press': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed' },
    [SystemState.GN2_VENT]:      { 'ACT.GSE_Low_Vent': 'open', 'ACT.Fuel_Press': 'closed', 'ACT.LOX_Press': 'closed' },
    [SystemState.FUEL_PRESS]:    { 'ACT.Fuel_Press': 'open', 'ACT.Fuel_Vent': 'closed' },
    [SystemState.FUEL_VENT]:     { 'ACT.Fuel_Vent': 'open', 'ACT.Fuel_Press': 'closed' },
    [SystemState.OX_PRESS]:      { 'ACT.LOX_Press': 'open', 'ACT.LOX_Vent': 'closed' },
    [SystemState.OX_VENT]:       { 'ACT.LOX_Vent': 'open', 'ACT.LOX_Press': 'closed' },
    [SystemState.READY]:   { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed' },
    [SystemState.FIRE]:    { 'ACT.LOX_Main': 'open', 'ACT.Fuel_Main': 'open', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed' },
    [SystemState.VENT]:    { 'ACT.LOX_Vent': 'open', 'ACT.Fuel_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed' },
    [SystemState.ABORT]:   { 'ACT.LOX_Vent': 'open', 'ACT.Fuel_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed' },
  };

  // Update commanded state based on system state
  useEffect(() => {
    if (currentState != null) {
      const stateExpected = EXPECTED_POSITIONS[currentState] ?? {};
      const expected = stateExpected[entity];
      if (expected !== null && expected !== undefined) {
        setCommanded(expected === 'open' ? ActuatorState.OPEN : ActuatorState.CLOSED);
      }
    }
  }, [currentState, entity]);

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
    const command: CommandPayload = {
      commandType: 'actuator',
      data: { actuatorId, actuatorState: state },
    };
    ws.sendCommand(command);
    setCommanded(state);
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
        <h3 className="text-xs font-semibold tracking-wider text-text uppercase">
          {ACTUATOR_NAMES[actuatorId]}
        </h3>
        {mismatch && (
          <span className="text-xs font-bold text-yellow-400 uppercase tracking-wider">MISMATCH</span>
        )}
      </div>

      {/* Two-row indicator: Commanded vs Feedback */}
      <div className="flex gap-3 mb-3 text-xs">
        <div className="flex-1">
          <div className="text-text-muted mb-1">COMMANDED</div>
          <div className={`flex items-center gap-1.5 ${commanded === null ? 'text-gray-500' : commandedOpen ? 'text-green-400' : 'text-red-400'}`}>
            <div className={`w-2 h-2 rounded-full ${commanded === null ? 'bg-gray-600' : commandedOpen ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="font-mono font-bold">
              {commanded === null ? '---' : commandedOpen ? 'OPEN' : 'CLOSED'}
            </span>
            {pending && <span className="text-yellow-400 text-[10px]">⟳</span>}
          </div>
        </div>
        <div className="w-px bg-gray-700" />
        <div className="flex-1">
          <div className="text-text-muted mb-1">FEEDBACK</div>
          <div className={`flex items-center gap-1.5 ${feedbackOpen ? 'text-green-400' : 'text-red-400'}`}>
            <div className={`w-2 h-2 rounded-full ${feedbackOpen ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="font-mono font-bold">{feedbackOpen ? 'OPEN' : 'CLOSED'}</span>
          </div>
        </div>
      </div>

      {/* ADC readout */}
      <div className="text-[10px] text-text-muted font-mono mb-2.5">
        ADC: {rawAdc.toLocaleString()}
      </div>

      {/* OPEN / CLOSE buttons — locked unless debug mode */}
      {!debugMode && (
        <div className="text-[10px] text-yellow-600 font-mono text-center mb-1">
          🔒 Enable DEBUG mode to control
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => debugMode && sendCommand(ActuatorState.OPEN)}
          disabled={!debugMode}
          className={`py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all
            ${!debugMode
              ? 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'
              : commandedOpen
                ? 'bg-green-700 text-white ring-1 ring-green-400'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
        >
          Open
        </button>
        <button
          onClick={() => debugMode && sendCommand(ActuatorState.CLOSED)}
          disabled={!debugMode}
          className={`py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all
            ${!debugMode
              ? 'bg-gray-900 text-gray-600 cursor-not-allowed opacity-50'
              : commandedClosed
                ? 'bg-red-700 text-white ring-1 ring-red-400'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}

