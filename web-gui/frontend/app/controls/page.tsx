'use client'

import React, { useEffect, useMemo } from 'react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControl from '@/components/controls/ActuatorControl';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { getWebSocketClient } from '@/lib/websocket';
import { useSensorStore } from '@/lib/store';
import { MessageType, SensorUpdate, StateUpdate, ActuatorId, SystemState, CommandPayload } from '@/lib/types';
import { useSensorValue } from '@/lib/store';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 LOW PRESS', 6: 'GN2 LOW VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'GN2 HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ENGINE ABORT',
  18: 'GSE ABORT', 19: 'EMERGENCY ABORT', 20: 'PRESS STANDBY',
};

// Pressure sensors for plotting
const PRESSURE_SENSORS = [
  { label: 'GN2 Reg', entity: 'PT_Cal.GN2_Regulated', color: '#27AE60' },
  { label: 'Fuel Up', entity: 'PT_Cal.Fuel_Upstream', color: '#3498DB' },
  { label: 'Fuel Down', entity: 'PT_Cal.Fuel_Downstream', color: '#2980B9' },
  { label: 'LOX Up', entity: 'PT_Cal.Ox_Upstream', color: '#E74C3C' },
  { label: 'LOX Down', entity: 'PT_Cal.Ox_Downstream', color: '#C0392B' },
  { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', color: '#F39C12' },
  { label: 'GSE MID', entity: 'PT_Cal.GSE_Mid', color: '#9B59B6' },
  { label: 'GSE High', entity: 'PT_Cal.GSE_High', color: '#8E44AD' },
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', color: '#1ABC9C' },
];

// All actuators from the CSV - organized by category, no duplicates
const ALL_ACTUATORS = [
  // Main Valves
  { id: ActuatorId.LOX_MAIN, name: 'LOX Main', channel: 1, entity: 'ACT.LOX_Main', category: 'main' },
  { id: ActuatorId.FUEL_MAIN, name: 'Fuel Main', channel: 7, entity: 'ACT.Fuel_Main', category: 'main' },

  // Vent Valves
  { id: ActuatorId.LOX_VENT, name: 'LOX Vent', channel: 6, entity: 'ACT.LOX_Vent', category: 'vent' },
  { id: ActuatorId.FUEL_VENT, name: 'Fuel Vent', channel: 2, entity: 'ACT.Fuel_Vent', category: 'vent' },
  { id: ActuatorId.GSE_LOW_VENT, name: 'GN2 Vent', channel: 5, entity: 'ACT.GSE_Low_Vent', category: 'vent' },
  { id: ActuatorId.GSE_HIGH_PRESS_VENT, name: 'GSE High Press Vent', channel: 5, entity: 'ACT.GSE_High_Press_Vent', category: 'vent' },
  { id: ActuatorId.GSE_LOX_FILL_VENT, name: 'GSE LOX Fill Vent', channel: 5, entity: 'ACT.GSE_LOX_Fill_Vent', category: 'vent' },

  // Press Valves
  { id: ActuatorId.LOX_PRESS, name: 'LOX Press', channel: 8, entity: 'ACT.LOX_Press', category: 'press' },
  { id: ActuatorId.FUEL_PRESS, name: 'Fuel Press', channel: 3, entity: 'ACT.Fuel_Press', category: 'press' },
  { id: ActuatorId.FUEL_FILL_PRESS, name: 'Fuel Fill Press', channel: 10, entity: 'ACT.Fuel_Fill_Press', category: 'press' },
  { id: ActuatorId.GSE_HIGH_PRESS_CONTROL, name: 'GSE High Press Control', channel: 5, entity: 'ACT.GSE_High_Press_Control', category: 'press' },
  { id: ActuatorId.GSE_MED_PRESS_CONTROL, name: 'GSE Med Press Control', channel: 5, entity: 'ACT.GSE_Med_Press_Control', category: 'press' },

  // Fill Valves
  { id: ActuatorId.FUEL_FILL_VENT, name: 'Fuel Fill Vent', channel: 9, entity: 'ACT.Fuel_Fill_Vent', category: 'fill' },
  { id: ActuatorId.LOX_FILL, name: 'LOX Fill', channel: 4, entity: 'ACT.LOX_Fill', category: 'fill' },

  // Other
  { id: ActuatorId.LOX_DUMP, name: 'LOX Dump', channel: 4, entity: 'ACT.LOX_Dump', category: 'other' },

  // Test Actuators
  { id: ActuatorId.TEST_ACTUATOR_2, name: 'Test Actuator 2', channel: 1, entity: 'ACT.Test_Actuator_2', category: 'other' },
];

// Simple actuator display - matches ActuatorControl layout exactly
function SimpleActuatorDisplay({ name, channel, entity }: { name: string; channel: number; entity: string }) {
  const status = useSensorValue(entity, 'status');
  const adcEntity = useSensorValue(entity, 'raw_adc_counts');
  const adcChannel = useSensorValue(`ACT.ACT_CH${channel}`, 'raw_adc_counts');
  const adc = adcEntity ?? adcChannel ?? 0;
  const hasData = status !== null || adc !== null;
  const isOpen = status === 1 || (adc !== null && adc > 1000);
  const currentState = useSensorStore((s) => s.currentState);
  const actuatorExpectedPositions = useSensorStore((s) => s.actuatorExpectedPositions);

  // Get expected position from backend (CSV-based) - computed directly from store
  const stateExpected = currentState != null ? (actuatorExpectedPositions[currentState] ?? {}) : {};
  const expected = stateExpected[entity] ?? null;

  // Commanded state should always show what the system state requires
  // Use useMemo to ensure reactivity to store changes
  const commandedState = useMemo(() => {
    if (currentState === null) {
      return null;
    }
    if (expected === 'open') {
      return 'OPEN';
    } else if (expected === 'closed') {
      return 'CLOSED';
    }
    return null;
  }, [currentState, expected]);
  const mismatch = expected !== null && hasData && ((expected === 'open' && !isOpen) || (expected === 'closed' && isOpen));

  return (
    <div className={`rounded-lg p-3 border transition-colors
      ${mismatch
        ? 'bg-yellow-950/40 border-yellow-600'
        : 'bg-background border-gray-700 hover:border-gray-600'}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold tracking-wider text-text uppercase">
          {name}
        </h3>
        {mismatch && (
          <span className="text-xs font-bold text-yellow-400 uppercase tracking-wider">MISMATCH</span>
        )}
      </div>

      {/* Two-row indicator: Commanded vs Feedback - EXACTLY like ActuatorControl */}
      <div className="flex gap-3 mb-3 text-xs">
        <div className="flex-1">
          <div className="text-text-muted mb-1">COMMANDED</div>
          <div className={`flex items-center gap-1.5 ${commandedState === null ? 'text-gray-500' : commandedState === 'OPEN' ? 'text-green-400' : 'text-red-400'}`}>
            <div className={`w-2 h-2 rounded-full ${commandedState === null ? 'bg-gray-600' : commandedState === 'OPEN' ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="font-mono font-bold">
              {commandedState === null ? '---' : commandedState}
            </span>
          </div>
        </div>
        <div className="w-px bg-gray-700" />
        <div className="flex-1">
          <div className="text-text-muted mb-1">FEEDBACK</div>
          <div className={`flex items-center gap-1.5 ${!hasData ? 'text-gray-500' : isOpen ? 'text-green-400' : 'text-red-400'}`}>
            <div className={`w-2 h-2 rounded-full ${!hasData ? 'bg-gray-600' : isOpen ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="font-mono font-bold">{!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}</span>
          </div>
        </div>
      </div>

      {/* ADC readout */}
      <div className="text-[10px] text-text-muted font-mono mb-2.5">
        ADC: {adc.toLocaleString()}
      </div>

      {/* Placeholder for buttons area to maintain spacing */}
      <div className="h-[34px]" />
    </div>
  );
}

export default function ControlsPage() {
  const ws = getWebSocketClient();
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState  = useSensorStore((state) => state.updateState);

  const updateActuatorExpectedPositions = useSensorStore((s) => s.updateActuatorExpectedPositions);

  useEffect(() => {
    ws.connect();

    // Subscribe to sensor updates immediately - WebSocket client handles queuing
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => {
      const update = p as SensorUpdate;
      updateSensor(update);
    });
    const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    const u3 = ws.on(MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE, (p: unknown) => {
      const payload = p as Record<number, Record<string, 'open' | 'closed' | null>>;
      updateActuatorExpectedPositions(payload);
    });

    return () => { u1(); u2(); u3(); };
  }, [ws, updateSensor, updateState, updateActuatorExpectedPositions]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">
      {/* ── Main content: 3-section split view ─────────────────────────────── */}
      <div className="flex-1 flex gap-3 p-3 min-h-0 overflow-hidden">

        {/* ── Left column: Pressure graphs ─────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="bg-card rounded-xl border border-gray-800 p-4 h-full flex flex-col min-h-0">
            <TimeSeriesPlot
              title="All Pressure Sensors (PSI)"
              entities={PRESSURE_SENSORS.map(s => s.entity)}
              labels={PRESSURE_SENSORS.map(s => s.label)}
              component="pressure_psi"
              colors={PRESSURE_SENSORS.map(s => s.color)}
              yLabel="Pressure (PSI)"
              windowSeconds={30}
            />
          </div>
        </div>

        {/* ── Right column: Actuators grid (top) + Camera (middle) + State machine (bottom) ───── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">

          {/* Actuators in 4x4 grid */}
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex-shrink-0 overflow-auto">
            <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase mb-4">
              Actuator Controls
            </h2>
            <div className="grid grid-cols-4 gap-3 auto-rows-fr">
              {ALL_ACTUATORS.map((a) =>
                a.id !== undefined ? (
                  <ActuatorControl key={a.name} actuatorId={a.id} />
                ) : (
                  <SimpleActuatorDisplay key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                )
              )}
            </div>
          </div>

          {/* State machine diagram */}
          <div className="flex-1 min-h-0 overflow-auto bg-card rounded-xl border border-gray-800 p-4">
            <StateMachineDiagram />
          </div>
        </div>
      </div>
    </main>
  );
}
