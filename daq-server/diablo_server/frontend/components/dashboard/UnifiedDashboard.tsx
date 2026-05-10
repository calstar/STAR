'use client'

import { useState } from 'react';
import { useSensorStore, useSensorValue, usePressureHistoryPlotSeries } from '@/lib/store';
import { SystemState } from '@/lib/types';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useActuatorsFromConfig, usePressureSensors } from '@/lib/dashboard-hooks';

// Time window options for history plotting
const TIME_WINDOWS = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5min', seconds: 300 },
];

export default function UnifiedDashboard() {
  const currentState = useSensorStore((state) => state.currentState);
  const [timeWindow, setTimeWindow] = useState(60);
  const actuatorsFromConfig = useActuatorsFromConfig();
  const pressureSensorsPlot = usePressureSensors();

  const isFireState = currentState === SystemState.FIRE;
  const pressurePlotForChart = usePressureHistoryPlotSeries(pressureSensorsPlot);
  return (
    <main className="h-full w-full bg-background text-text flex flex-col overflow-hidden">
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
                    className={`px-2 py-0.5 text-xs font-semibold rounded transition-all ${timeWindow === w.seconds
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
                entities={pressurePlotForChart.map(s => s.entity)}
                labels={pressurePlotForChart.map(s => s.label)}
                component="pressure_psi"
                colors={pressurePlotForChart.map(s => s.color)}
                yLabel="Pressure (PSI)"
                windowSeconds={timeWindow}
              />
            </div>
          </div>
        </div>

        {/* ── Right column: Actuators grid (top) + State machine (bottom) ───── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">

          {/* Actuators: 4x4 grid, dynamically sized to fit allotment */}
          <div className="bg-card rounded-xl border border-gray-800 p-2 flex flex-col min-h-0 flex-1 max-h-[38vh]">
            <h2 className="text-[10px] font-bold tracking-widest text-text-muted uppercase mb-1 leading-none flex-shrink-0">
              Actuator Controls
            </h2>
            <div className="flex-1 min-h-0 grid grid-cols-4 grid-rows-4 gap-1 overflow-hidden">
              {Array.from({ length: 16 }, (_, i) => {
                const a = actuatorsFromConfig[i];
                if (!a) return <div key={`empty-${i}`} className="bg-gray-900/30 rounded border border-gray-800/50 min-h-0" />;
                return <ActuatorControlByName key={a.name} name={a.name} channel={a.channel} entity={a.entity} boardId={a.boardId} />;
              })}
            </div>
          </div>

          {/* State machine diagram */}
          <div className="mt-auto min-h-0 overflow-auto bg-card rounded-xl border border-gray-800 p-4 max-h-[50vh]">
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
        <span className={`text-xs px-2 py-0.5 rounded ${fuelOn ? 'bg-green-900/50 text-green-400 border border-green-800' :
            'bg-gray-900/50 text-gray-500 border border-gray-800'
          }`}>
          {fuelOn ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-muted">Ox:</span>
        <span className="text-sm font-mono font-bold text-red-400">{oxDuty.toFixed(1)}%</span>
        <span className={`text-xs px-2 py-0.5 rounded ${oxOn ? 'bg-green-900/50 text-green-400 border border-green-800' :
            'bg-gray-900/50 text-gray-500 border border-gray-800'
          }`}>
          {oxOn ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}
