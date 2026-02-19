'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

const NOP  = 450;
const MEOP = 600;

export default function LOXGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const ws = getWebSocketClient();
  useEffect(() => {
    ws.connect();
    const unsub = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    return unsub;
  }, [ws, updateSensor]);

  const up   = useSensorValue('PT_Cal.PT_CH5', 'pressure_psi');
  const down = useSensorValue('PT_Cal.PT_CH7', 'pressure_psi');
  const loxMainOpen = (useSensorValue('ACT.ACT_CH1', 'raw_adc_counts') ?? 0) > 0;

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-red-500 rounded-full" />
          <h1 className="text-base font-bold text-red-400 tracking-wider">LOX SYSTEM</h1>
        </div>
        <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${loxMainOpen ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
          LOX MAIN: {loxMainOpen ? 'OPEN' : 'CLOSED'}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex flex-row gap-2">

        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0 overflow-hidden">
            <TimeSeriesPlot
              title="LOX Pressure (PSI)"
              entities={['PT_Cal.PT_CH5','PT_Cal.PT_CH7']}
              labels={['Upstream','Downstream']}
              component="pressure_psi"
              colors={['#E74C3C','#C0392B']}
              yLabel="Pressure (PSI)"
            />
          </div>
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0 overflow-hidden">
            <TimeSeriesPlot
              title="LOX Actuator States (ADC)"
              entities={['ACT.ACT_CH1','ACT.ACT_CH6','ACT.ACT_CH8']}
              labels={['LOX Main','LOX Vent','LOX Press']}
              component="raw_adc_counts"
              colors={['#27AE60','#E74C3C','#F39C12']}
              yLabel="ADC / Status"
            />
          </div>
        </div>

        <div className="w-36 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0">
          <div className="text-[9px] font-bold uppercase tracking-widest text-gray-600 text-center flex-shrink-0">Pressures</div>
          <div className="flex-shrink-0 text-[9px] font-mono text-center">
            <span className="text-red-400">— MEOP</span> <span className="text-yellow-400">— NOP</span>
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0">
            <div className="flex-1 min-h-0"><PressureBar label="Upstream"   value={up}   nop={NOP} meop={MEOP} color="#E74C3C" /></div>
            <div className="flex-1 min-h-0"><PressureBar label="Downstream" value={down} nop={NOP} meop={MEOP} color="#C0392B" /></div>
          </div>
        </div>

      </div>
    </main>
  );
}
