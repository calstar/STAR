'use client'

import React, { useMemo } from 'react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { useSensorConfig } from '@/lib/sensor-config';
import { buildPressurePlotSeriesFromSensorList } from '@/lib/pressure-bar-defs';
import { usePressureHistoryPlotSeries } from '@/lib/store';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 LOW PRESS', 6: 'GN2 LOW VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'GN2 HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ENGINE ABORT',
  18: 'GSE ABORT', 19: 'EMERGENCY ABORT', 20: 'PRESS STANDBY',
};

export default function ControlsPage() {
  const { actuators: actuatorsFromConfig, loading: actuatorsLoading } = useActuatorsFromConfig();
  const sensors = useSensorConfig();
  const pressurePlot = useMemo(() => buildPressurePlotSeriesFromSensorList(sensors), [sensors]);
  const pressurePlotForChart = usePressureHistoryPlotSeries(pressurePlot);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">
      <div className="flex-1 flex gap-3 p-3 min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="bg-card rounded-xl border border-gray-800 p-4 h-full flex flex-col min-h-0">
            <TimeSeriesPlot
              title="All Pressure Sensors (PSI)"
              entities={pressurePlotForChart.map(s => s.entity)}
              labels={pressurePlotForChart.map(s => s.label)}
              component="pressure_psi"
              colors={pressurePlotForChart.map(s => s.color)}
              yLabel="Pressure (PSI)"
              windowSeconds={30}
            />
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">
          <div className="bg-card rounded-xl border border-gray-800 p-2 flex flex-col min-h-0 flex-1 max-h-[38vh]">
            <h2 className="text-[10px] font-bold tracking-widest text-text-muted uppercase mb-1 leading-none flex-shrink-0">
              Actuator Controls
            </h2>
            <div className="flex-1 min-h-0 grid grid-cols-4 grid-rows-4 gap-1 overflow-hidden">
              {actuatorsLoading ? (
                <p className="col-span-4 row-span-4 text-text-muted flex items-center">Loading actuators from config…</p>
              ) : (
                Array.from({ length: 16 }, (_, i) => {
                  const a = actuatorsFromConfig[i];
                  if (!a) return <div key={`empty-${i}`} className="bg-gray-900/30 rounded-md border border-gray-800/50" />;
                  return <ActuatorControlByName key={a.name} name={a.name} channel={a.channel} entity={a.entity} boardId={a.boardId} />;
                })
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
