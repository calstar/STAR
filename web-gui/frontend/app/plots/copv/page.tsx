'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

const NOP_HIGH = 900; const MEOP_HIGH = 950;
const NOP_REG  = 450; const MEOP_REG  = 600;

export default function COPVGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const ws = getWebSocketClient();
  useEffect(() => {
    ws.connect();
    const unsub = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    return unsub;
  }, [ws, updateSensor]);

  const hi  = useSensorValue('PT_Cal.PT_CH9', 'pressure_psi');
  const reg = useSensorValue('PT_Cal.PT_CH6', 'pressure_psi');

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center flex-shrink-0">
        <div className="w-1 h-5 bg-green-500 rounded-full mr-3" />
        <h1 className="text-base font-bold text-green-400 tracking-wider">COPV / GN2 SYSTEM</h1>
      </div>

      <div className="flex-1 min-h-0 flex flex-row gap-2">

        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0 overflow-hidden">
            <TimeSeriesPlot
              title="COPV / GN2 Pressure (PSI)"
              entities={['PT_Cal.PT_CH9','PT_Cal.PT_CH6']}
              labels={['GN2 High','GN2 Regulated']}
              component="pressure_psi"
              colors={['#27AE60','#229954']}
              yLabel="Pressure (PSI)"
            />
          </div>
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0 overflow-hidden">
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

        <div className="w-36 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0">
          <div className="text-[9px] font-bold uppercase tracking-widest text-gray-600 text-center flex-shrink-0">Pressures</div>
          <div className="flex-shrink-0 text-[9px] font-mono text-center">
            <span className="text-red-400">— MEOP</span> <span className="text-yellow-400">— NOP</span>
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0">
            <div className="flex-1 min-h-0"><PressureBar label="GN2 Hi"  value={hi}  nop={NOP_HIGH} meop={MEOP_HIGH} color="#27AE60" /></div>
            <div className="flex-1 min-h-0"><PressureBar label="GN2 Reg" value={reg} nop={NOP_REG}  meop={MEOP_REG}  color="#229954" /></div>
          </div>
        </div>

      </div>
    </main>
  );
}
