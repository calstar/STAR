'use client'

import { useState } from 'react';
import { useSensorStore, useSensorValue, usePressureHistoryPlotSeries } from '@/lib/store';
import { SystemState } from '@/lib/types';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useActuatorsFromConfig, usePressureSensors } from '@/lib/dashboard-hooks';
import { isFireState } from '@/lib/states';
import WindowPicker from '@/components/ui/WindowPicker';

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

  const isFire = isFireState(currentState);
  const pressurePlotForChart = usePressureHistoryPlotSeries(pressureSensorsPlot);
  return (
    <main className="flex h-full w-full flex-col overflow-hidden bg-background px-8 text-text">
      {/* ── The console's lower half, as feed-twin lays it: the plot gets the room on the
          left; the valves and the state machine share the right, between hairlines. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">

        <section className="flex min-h-0 min-w-0 flex-col py-5 pr-8">
          <div className="mb-3 flex flex-shrink-0 items-baseline justify-between gap-4">
            <h2 className="caps">Pressure History</h2>
            <WindowPicker windows={TIME_WINDOWS} value={timeWindow} onChange={setTimeWindow} />
          </div>
          <div className="min-h-0 flex-1">
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
        </section>

        <div className="flex min-h-0 min-w-0 flex-col border-l border-line pl-8">
          {/* Actuators: 4x4 grid, dynamically sized to fit allotment */}
          <section className="flex max-h-[42%] min-h-0 flex-1 flex-col border-b border-line py-5">
            <h2 className="caps mb-3 flex-shrink-0">Actuators</h2>
            <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-4 gap-2 overflow-hidden">
              {Array.from({ length: 16 }, (_, i) => {
                const a = actuatorsFromConfig[i];
                if (!a) return <div key={`empty-${i}`} className="min-h-0 border border-line/60" />;
                return <ActuatorControlByName key={a.name} name={a.name} channel={a.channel} entity={a.entity} boardId={a.boardId} ballValve={a.ballValve} />;
              })}
            </div>
          </section>

          <section className="min-h-0 flex-1 overflow-auto py-5">
            <StateMachineDiagram />
          </section>
        </div>
      </div>

      {/* ── Bottom Section: Controller Status (when in FIRE state) ─────── */}
      {isFire && (
        <div className="flex-shrink-0 border-t border-line py-3">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
              <span className="caps text-[11px] text-red-400">Controller active · Fire</span>
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
  // Stale reads as "no data", never as 0.0% / OFF.
  //
  // These used to be `?? 0`, so a stream that had simply stopped arriving rendered a
  // confident "0.0%" and an OFF pill — the same picture as a gate that is genuinely
  // closed. On the ignition path those are not interchangeable. null now carries through
  // to a dash and a neutral pill.
  const fuelDuty = useSensorValue('CONTROLLER.Fuel', 'duty_cycle');
  const oxDuty = useSensorValue('CONTROLLER.Ox', 'duty_cycle');
  const fuelOn = useSensorValue('CONTROLLER.Fuel', 'onoff');
  const oxOn = useSensorValue('CONTROLLER.Ox', 'onoff');

  return (
    <div className="flex items-center gap-6">
      <div className="flex items-center gap-3">
        <span className="caps text-[11px]">Fuel</span>
        <span className="font-mono text-sm font-bold text-fuel">{fuelDuty !== null ? `${fuelDuty.toFixed(1)}%` : '--'}</span>
        <span className={`border px-2 py-0.5 font-mono text-[11px] tracking-[0.12em] ${fuelOn === null ? 'border-line text-ink-4' : fuelOn ? 'border-green-500 text-green-400' :
            'border-line-strong text-ink-3'
          }`}>
          {fuelOn === null ? '--' : fuelOn ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="caps text-[11px]">Ox</span>
        <span className="text-sm font-mono font-bold text-red-400">{oxDuty !== null ? `${oxDuty.toFixed(1)}%` : '--'}</span>
        <span className={`border px-2 py-0.5 font-mono text-[11px] tracking-[0.12em] ${oxOn === null ? 'border-line text-ink-4' : oxOn ? 'border-green-500 text-green-400' :
            'border-line-strong text-ink-3'
          }`}>
          {oxOn === null ? '--' : oxOn ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}
