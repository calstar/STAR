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

export default function GSEGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState  = useSensorStore((s) => s.updateState);
  const ws           = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE,  (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  // Sidebar pressure PTs
  const loNamed  = useSensorValue('PT_Cal.GSE_Low',   'pressure_psi');
  const loCh     = useSensorValue('PT_Cal.PT_CH2',    'pressure_psi');
  const mid = useSensorValue('PT_Cal.GSE_Mid', 'pressure_psi');
  const hiNamed  = useSensorValue('PT_Cal.GSE_High',  'pressure_psi');
  const hiCh     = useSensorValue('PT_Cal.PT_CH8',    'pressure_psi');
  const lo       = loNamed  ?? loCh;
  const hi       = hiNamed  ?? hiCh;

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center flex-shrink-0">
        <div className="w-1 h-5 bg-yellow-500 rounded-full mr-3" />
        <h1 className="text-base font-bold text-yellow-400 tracking-wider">GSE SYSTEM</h1>
      </div>

      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={[
          { label: 'GSE Low',  entity: 'PT_Cal.PT_CH2', component: 'pressure_psi', color: '#F39C12' },
          { label: 'GSE MID',  entity: 'PT_Cal.GSE_Mid', component: 'pressure_psi', color: '#9B59B6' },
          { label: 'GSE High', entity: 'PT_Cal.PT_CH8', component: 'pressure_psi', color: '#8E44AD' },
        ]} />
      </div>

      {/* Body: chart + sidebar */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">
        {/* Main chart + actuators */}
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0" style={{ minHeight: '300px' }}>
            <TimeSeriesPlot
              title="GSE Pressures (PSI)"
              entities={['PT_Cal.PT_CH2','PT_Cal.GSE_Mid','PT_Cal.PT_CH8']}
              labels={['GSE Low','GSE MID','GSE High']}
              component="pressure_psi"
              colors={['#F39C12','#9B59B6','#8E44AD']}
              yLabel="Pressure (PSI)"
            />
          </div>

          {/* GSE / GN2 actuators */}
          <div className="flex-shrink-0">
            <ActuatorStatePanel
              title="GSE Actuators"
              actuators={[
                { label: 'GN2 Vent',             entity: 'ACT.GSE_Low_Vent', color: '#F39C12' },
                { label: 'GSE Low Press Vent',   entity: 'ACT.GSE_Low_Vent', color: '#F1C40F' },
                { label: 'GSE High Press Vent',  entity: 'ACT.GSE_Low_Vent', color: '#D35400' },
                { label: 'GSE LOX Fill Vent',    entity: 'ACT.GSE_Low_Vent', color: '#9B59B6' },
                { label: 'GSE High Press Ctrl',  entity: 'ACT.GSE_Low_Vent', color: '#1ABC9C' },
                { label: 'GSE Med Press Ctrl',   entity: 'ACT.GSE_Low_Vent', color: '#16A085' },
              ]}
            />
          </div>
        </div>

        {/* Pressure bars sidebar */}
        <div className="w-60 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-visible">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          <div className="flex flex-row flex-1 gap-1.5 min-h-0 overflow-visible w-full pr-6">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Low"  value={lo}  nop={NOP} meop={MEOP} color="#F39C12" showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Mid"  value={mid} nop={NOP} meop={MEOP} color="#9B59B6" showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="High" value={hi}  nop={NOP} meop={MEOP} color="#8E44AD" showLabels={false} />
            </div>
          </div>
        </div>
      </div>

    </main>
  );
}

 