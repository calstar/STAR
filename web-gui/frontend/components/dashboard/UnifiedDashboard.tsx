'use client'

import { useEffect, useState } from 'react';
import { useSensorStore, useSensorValue, useGetSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate, SystemState, ActuatorId } from '@/lib/types';
import { startDataCache } from '@/lib/data-cache';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControl from '@/components/controls/ActuatorControl';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';

// All actuators from controls page
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
];

// Pressure sensors for plotting
const PRESSURE_SENSORS = [
  { label: 'GN2 Reg', entity: 'PT_Cal.GN2_Regulated', color: '#27AE60' },
  { label: 'Fuel Up', entity: 'PT_Cal.Fuel_Upstream', color: '#3498DB' },
  { label: 'Fuel Down', entity: 'PT_Cal.Fuel_Downstream', color: '#2980B9' },
  { label: 'LOX Up', entity: 'PT_Cal.Ox_Upstream', color: '#E74C3C' },
  { label: 'LOX Down', entity: 'PT_Cal.Ox_Downstream', color: '#C0392B' },
  { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', color: '#F39C12' },
  { label: 'GSE Mid', entity: 'PT_Cal.GSE_Mid', color: '#9B59B6' },
  { label: 'GSE High', entity: 'PT_Cal.GSE_High', color: '#8E44AD' },
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', color: '#1ABC9C' },
];

// Time window options for history plotting
const TIME_WINDOWS = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5min', seconds: 300 },
];

export default function UnifiedDashboard() {
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);
  const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);
  const currentState = useSensorStore((state) => state.currentState);
  const ws = getWebSocketClient();
  const [timeWindow, setTimeWindow] = useState(60); // Default 60 seconds

  useEffect(() => {
    ws.connect();
    try {
      startDataCache(); // Start history cache
    } catch (err) {
      console.error('[UnifiedDashboard] Failed to start data cache:', err);
    }
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    const u3 = ws.onConnectionStatus((s) => updateConnectionStatus(s));
    return () => { u1(); u2(); u3(); };
  }, [ws, updateSensor, updateState, updateConnectionStatus]);

  const isFireState = currentState === SystemState.FIRE;

  return (
    <main className="h-screen w-screen bg-background text-text flex flex-col overflow-hidden">
      {/* ── Main content: 3-section split view ─────────────────────────────── */}
      <div className="flex-1 flex gap-3 p-3 min-h-0 overflow-hidden">
        
        {/* ── Left column: Pressure graphs ─────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="bg-card rounded-xl border border-gray-800 p-4 h-full flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <h2 className="text-base font-bold tracking-widest text-text-muted uppercase">Pressure History</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted font-medium">Window:</span>
                {TIME_WINDOWS.map((w) => (
                  <button
                    key={w.label}
                    onClick={() => {
                      const newWindow = w.seconds;
                      setTimeWindow(newWindow);
                      console.log(`[UnifiedDashboard] Time window changed to ${newWindow}s`);
                    }}
                    className={`px-4 py-2 text-sm font-semibold rounded-md transition-all ${
                      timeWindow === w.seconds
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <TimeSeriesPlot
                title="All Pressure Sensors (PSI)"
                entities={PRESSURE_SENSORS.map(s => s.entity)}
                labels={PRESSURE_SENSORS.map(s => s.label)}
                component="pressure_psi"
                colors={PRESSURE_SENSORS.map(s => s.color)}
                yLabel="Pressure (PSI)"
                windowSeconds={timeWindow}
              />
            </div>
          </div>
        </div>

        {/* ── Right column: Actuators grid (top) + State machine (bottom) ───── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">
          
          {/* Actuators in 4x4 grid */}
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex-shrink-0 overflow-auto">
            <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase mb-4">
              Actuator Controls
            </h2>
            <div className="grid grid-cols-4 gap-3 auto-rows-fr">
              {ALL_ACTUATORS.map((a) => (
                <ActuatorControl key={a.name} actuatorId={a.id} />
              ))}
            </div>
          </div>

          {/* State machine diagram */}
          <div className="flex-1 min-h-0 overflow-auto bg-card rounded-xl border border-gray-800 p-4">
            <StateMachineDiagram />
          </div>
        </div>
      </div>

      {/* ── Bottom Section: Controller Status (when in FIRE state) ─────── */}
      {isFireState && (
        <div className="flex-shrink-0 border-t border-gray-800 p-3 bg-card">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-bold tracking-wider text-text-muted uppercase">Controller Active (FIRE)</span>
            </div>
            <ControllerStatusDisplay />
          </div>
        </div>
      )}
    </main>
  );
}

// Controller status display component
function ControllerStatusDisplay() {
  const fuelDuty = useSensorValue('CONTROLLER.Fuel', 'duty_cycle') ?? 0;
  const oxDuty = useSensorValue('CONTROLLER.Ox', 'duty_cycle') ?? 0;
  const fuelOn = useSensorValue('CONTROLLER.Fuel', 'onoff') ?? 0;
  const oxOn = useSensorValue('CONTROLLER.Ox', 'onoff') ?? 0;

  return (
    <div className="flex items-center gap-6">
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-muted">Fuel:</span>
        <span className="text-sm font-mono font-bold text-blue-400">{fuelDuty.toFixed(1)}%</span>
        <span className={`text-xs px-2 py-0.5 rounded ${
          fuelOn ? 'bg-green-900/50 text-green-400 border border-green-800' :
                   'bg-gray-900/50 text-gray-500 border border-gray-800'
        }`}>
          {fuelOn ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-muted">Ox:</span>
        <span className="text-sm font-mono font-bold text-red-400">{oxDuty.toFixed(1)}%</span>
        <span className={`text-xs px-2 py-0.5 rounded ${
          oxOn ? 'bg-green-900/50 text-green-400 border border-green-800' :
                 'bg-gray-900/50 text-gray-500 border border-gray-800'
        }`}>
          {oxOn ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}

