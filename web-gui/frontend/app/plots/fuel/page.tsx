'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';

const NOP  = 450;
const MEOP = 600;

export default function FuelGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();
  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  // Call all hooks unconditionally (React Rules of Hooks)
  const upNamed = useSensorValue('PT_Cal.Fuel_Upstream', 'pressure_psi');
  const upCh = useSensorValue('PT_Cal.PT_CH1', 'pressure_psi');
  const downNamed = useSensorValue('PT_Cal.Fuel_Downstream', 'pressure_psi');
  const downCh = useSensorValue('PT_Cal.PT_CH4', 'pressure_psi');
  
  // Then select the value (not conditional hook calls)
  const up = upNamed ?? upCh;
  const down = downNamed ?? downCh;

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      {/* ── Header + readouts ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-blue-500 rounded-full" />
          <h1 className="text-base font-bold text-blue-400 tracking-wider">FUEL SYSTEM</h1>
        </div>
      </div>

      {/* Live readout strip */}
      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={[
          { label: 'Fuel Up', entity: 'PT_Cal.PT_CH1', component: 'pressure_psi', color: '#3498DB' },
          { label: 'Fuel Down', entity: 'PT_Cal.PT_CH4', component: 'pressure_psi', color: '#2980B9' },
        ]} />
      </div>

      {/* ── Body: chart + actuator states + gauges ─────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">

        {/* Main chart area */}
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0 overflow-hidden">
            <TimeSeriesPlot
              title="FUEL Pressure (PSI)"
              entities={['PT_Cal.PT_CH1','PT_Cal.PT_CH4']}
              labels={['Upstream','Downstream']}
              component="pressure_psi"
              colors={['#3498DB','#2980B9']}
              yLabel="Pressure (PSI)"
            />
          </div>
          {/* Actuator state readouts (replaces time-series plot) */}
          <ActuatorStatePanel
            title="Fuel Actuators"
            actuators={[
              { label: 'Fuel Main',  entity: 'ACT.Fuel_Main', color: '#27AE60' },
              { label: 'Fuel Vent',  entity: 'ACT.Fuel_Vent', color: '#E74C3C' },
              { label: 'Fuel Press', entity: 'ACT.Fuel_Press', color: '#F39C12' },
            ]}
          />
        </div>

        {/* Gauges sidebar */}
        <div className="w-44 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-hidden">
          <div className="text-sm font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          {/* Single NOP/MEOP label for all bars */}
          <div className="flex items-center justify-center gap-3 flex-shrink-0 text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 border-t-2 border-dashed border-yellow-500/85" />
              <span className="text-sm font-bold text-yellow-400">NOP {NOP}</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 border-t-2 border-dashed border-red-500/85" />
              <span className="text-sm font-bold text-red-400">MEOP {MEOP}</span>
            </div>
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0 overflow-hidden w-full">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-hidden">
              <PressureBar label="Up" value={up} nop={NOP} meop={MEOP} color="#3498DB" showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-hidden">
              <PressureBar label="Down" value={down} nop={NOP} meop={MEOP} color="#2980B9" showLabels={false} />
            </div>
          </div>
        </div>

      </div>
    </main>
  );
}
