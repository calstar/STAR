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

export default function LOXGraphsPage() {
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
  const upNamed = useSensorValue('PT_Cal.Ox_Upstream', 'pressure_psi');
  const upCh = useSensorValue('PT_Cal.PT_CH5', 'pressure_psi');
  const downNamed = useSensorValue('PT_Cal.Ox_Downstream', 'pressure_psi');
  const downCh = useSensorValue('PT_Cal.PT_CH7', 'pressure_psi');
  
  // Then select the value (not conditional hook calls)
  const up = upNamed ?? upCh;
  const down = downNamed ?? downCh;

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-red-500 rounded-full" />
          <h1 className="text-base font-bold text-red-400 tracking-wider">LOX SYSTEM</h1>
        </div>
      </div>

      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={[
          { label: 'LOX Up', entity: 'PT_Cal.PT_CH5', component: 'pressure_psi', color: '#E74C3C' },
          { label: 'LOX Down', entity: 'PT_Cal.PT_CH7', component: 'pressure_psi', color: '#C0392B' },
        ]} />
      </div>

      <div className="flex-1 min-h-0 flex flex-row gap-2">

        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0" style={{ minHeight: '300px' }}>
            <TimeSeriesPlot
              title="LOX Pressure (PSI)"
              entities={['PT_Cal.PT_CH5','PT_Cal.PT_CH7']}
              labels={['Upstream','Downstream']}
              component="pressure_psi"
              colors={['#E74C3C','#C0392B']}
              yLabel="Pressure (PSI)"
            />
          </div>
          <ActuatorStatePanel
            title="LOX Actuators"
            actuators={[
              { label: 'LOX Main',  entity: 'ACT.LOX_Main', color: '#27AE60' },
              { label: 'LOX Vent',  entity: 'ACT.LOX_Vent', color: '#E74C3C' },
              { label: 'LOX Press', entity: 'ACT.LOX_Press', color: '#F39C12' },
            ]}
          />
        </div>

        <div className="w-44 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-hidden">
          <div className="text-sm font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">Pressures</div>
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
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-hidden"><PressureBar label="Upstream"   value={up}   nop={NOP} meop={MEOP} color="#E74C3C" showLabels={false} /></div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-hidden"><PressureBar label="Downstream" value={down} nop={NOP} meop={MEOP} color="#C0392B" showLabels={false} /></div>
          </div>
        </div>

      </div>
    </main>
  );
}
