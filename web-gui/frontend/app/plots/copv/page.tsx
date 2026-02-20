'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';

const NOP_HIGH = 900; const MEOP_HIGH = 950;
const NOP_REG  = 450; const MEOP_REG  = 600;

export default function COPVGraphsPage() {
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
  const hiNamed = useSensorValue('PT_Cal.GN2_High', 'pressure_psi');
  const hiCh = useSensorValue('PT_Cal.PT_CH9', 'pressure_psi');
  const regNamed = useSensorValue('PT_Cal.GN2_Regulated', 'pressure_psi');
  const regCh = useSensorValue('PT_Cal.PT_CH6', 'pressure_psi');
  
  // Then select the values (not conditional hook calls)
  const hi = hiNamed ?? hiCh;
  const reg = regNamed ?? regCh;

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center flex-shrink-0">
        <div className="w-1 h-5 bg-green-500 rounded-full mr-3" />
        <h1 className="text-base font-bold text-green-400 tracking-wider">COPV / GN2 SYSTEM</h1>
      </div>

      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={[
          { label: 'GN2 High', entity: 'PT_Cal.PT_CH9', component: 'pressure_psi', color: '#27AE60' },
          { label: 'GN2 Reg',  entity: 'PT_Cal.PT_CH6', component: 'pressure_psi', color: '#229954' },
        ]} />
      </div>

      <div className="flex-1 min-h-0 flex flex-row gap-2">

        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0" style={{ minHeight: '300px' }}>
            <TimeSeriesPlot
              title="COPV / GN2 Pressure (PSI)"
              entities={['PT_Cal.PT_CH9','PT_Cal.PT_CH6']}
              labels={['GN2 High','GN2 Regulated']}
              component="pressure_psi"
              colors={['#27AE60','#229954']}
              yLabel="Pressure (PSI)"
            />
          </div>
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0" style={{ minHeight: '300px' }}>
            <TimeSeriesPlot
              title="All PT Channels — Overview (PSI)"
              entities={['PT_Cal.PT_CH1','PT_Cal.PT_CH2','PT_Cal.PT_CH3',
                         'PT_Cal.PT_CH4','PT_Cal.PT_CH5','PT_Cal.PT_CH6','PT_Cal.PT_CH7']}
              labels={['Fuel Up','GSE Lo','GSE Mid','Fuel Dn','LOX Up','GN2 Reg','LOX Dn']}
              component="pressure_psi"
              colors={['#3498DB','#F39C12','#9B59B6','#2980B9','#E74C3C','#27AE60','#C0392B']}
              yLabel="PSI"
            />
          </div>
        </div>

        <div className="w-44 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-hidden">
          <div className="text-sm font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">Pressures</div>
          {/* Single NOP/MEOP label for all bars */}
          <div className="flex items-center justify-center gap-3 flex-shrink-0 text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 border-t-2 border-dashed border-yellow-500/85" />
              <span className="text-sm font-bold text-yellow-400">NOP {NOP_HIGH}/{NOP_REG}</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 border-t-2 border-dashed border-red-500/85" />
              <span className="text-sm font-bold text-red-400">MEOP {MEOP_HIGH}/{MEOP_REG}</span>
            </div>
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0 overflow-hidden w-full">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-hidden"><PressureBar label="GN2 Hi"  value={hi}  nop={NOP_HIGH} meop={MEOP_HIGH} color="#27AE60" showLabels={false} /></div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-hidden"><PressureBar label="GN2 Reg" value={reg} nop={NOP_REG}  meop={MEOP_REG}  color="#229954" showLabels={false} /></div>
          </div>
        </div>

      </div>
    </main>
  );
}
