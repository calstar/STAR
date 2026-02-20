'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

const NOP  = 450;
const MEOP = 600;

export default function GSEGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const ws = getWebSocketClient();
  useEffect(() => {
    ws.connect();
    const unsub = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    return unsub;
  }, [ws, updateSensor]);

  const lo  = useSensorValue('PT_Cal.PT_CH2', 'pressure_psi');
  const mid = useSensorValue('PT_Cal.PT_CH3', 'pressure_psi');
  const hi  = useSensorValue('PT_Cal.PT_CH8', 'pressure_psi');

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center flex-shrink-0">
        <div className="w-1 h-5 bg-yellow-500 rounded-full mr-3" />
        <h1 className="text-base font-bold text-yellow-400 tracking-wider">GSE SYSTEM</h1>
      </div>

      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={[
          { label: 'GSE Low', entity: 'PT_Cal.PT_CH2', component: 'pressure_psi', color: '#F39C12' },
          { label: 'GSE Mid', entity: 'PT_Cal.PT_CH3', component: 'pressure_psi', color: '#9B59B6' },
          { label: 'GSE Hi',  entity: 'PT_Cal.PT_CH8', component: 'pressure_psi', color: '#8E44AD' },
        ]} />
      </div>

      <div className="flex-1 min-h-0 flex flex-row gap-2">

        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0 overflow-hidden">
            <TimeSeriesPlot
              title="GSE Pressures (PSI)"
              entities={['PT_Cal.PT_CH2','PT_Cal.PT_CH3','PT_Cal.PT_CH8']}
              labels={['GSE Low','GSE Mid','GSE High']}
              component="pressure_psi"
              colors={['#F39C12','#9B59B6','#8E44AD']}
              yLabel="Pressure (PSI)"
            />
          </div>
          <ActuatorStatePanel
            title="GSE Actuators"
            actuators={[
              { label: 'GSE Low Vent', entity: 'ACT.ACT_CH5', color: '#F39C12' },
            ]}
          />
        </div>

        <div className="w-44 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0">
          <div className="text-[9px] font-bold uppercase tracking-widest text-gray-600 text-center flex-shrink-0">Pressures</div>
          <div className="flex-shrink-0 text-[9px] font-mono text-center">
            <span className="text-red-400">— MEOP</span> <span className="text-yellow-400">— NOP</span>
          </div>
          <div className="flex flex-row flex-1 gap-1.5 min-h-0">
            <div className="flex-1 min-h-0"><PressureBar label="Low"  value={lo}  nop={NOP} meop={MEOP} color="#F39C12" /></div>
            <div className="flex-1 min-h-0"><PressureBar label="Mid"  value={mid} nop={NOP} meop={MEOP} color="#9B59B6" /></div>
            <div className="flex-1 min-h-0"><PressureBar label="High" value={hi}  nop={NOP} meop={MEOP} color="#8E44AD" /></div>
          </div>
        </div>

      </div>
    </main>
  );
}
