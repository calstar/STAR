'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';

const NOP_HIGH = 900;
const MEOP_HIGH = 950;
const NOP_REG  = 450;
const MEOP_REG = 600;

export default function COPVGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState  = useSensorStore((s) => s.updateState);
  const ws           = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE,  (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  // Readouts for GN2 High / Reg pressures
  const hiNamed  = useSensorValue('PT_Cal.GN2_High',      'pressure_psi');
  const hiCh     = useSensorValue('PT_Cal.PT_CH9',        'pressure_psi');
  const regNamed = useSensorValue('PT_Cal.GN2_Regulated', 'pressure_psi');
  const regCh    = useSensorValue('PT_Cal.PT_CH6',        'pressure_psi');
  const hi       = hiNamed  ?? hiCh;
  const reg      = regNamed ?? regCh;

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

      {/* Body: chart + sidebar */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">
        {/* Main charts + actuators */}
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          {/* GN2 pressure */}
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

          {/* GN2-related actuators */}
          <div className="flex-shrink-0">
            <ActuatorStatePanel
              title="GN2 / GSE Actuators"
              actuators={[
                { label: 'GN2 Vent',             entity: 'ACT.GSE_Low_Vent', color: '#F39C12' },
                { label: 'GSE Low Press Vent',   entity: 'ACT.GSE_Low_Vent', color: '#F1C40F' },
                { label: 'GSE High Press Vent',  entity: 'ACT.GSE_Low_Vent', color: '#D35400' },
                { label: 'GSE High Press Ctrl',  entity: 'ACT.GSE_Low_Vent', color: '#1ABC9C' },
                { label: 'GSE Med Press Ctrl',   entity: 'ACT.GSE_Low_Vent', color: '#16A085' },
              ]}
            />
          </div>
        </div>

        {/* Pressure bars sidebar */}
        <div className="w-52 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-visible">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0 overflow-visible w-full pr-6">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="GN2 Hi"  value={hi}  nop={NOP_HIGH} meop={MEOP_HIGH} color="#27AE60" showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="GN2 Reg" value={reg} nop={NOP_REG}  meop={MEOP_REG}  color="#229954" showLabels={false} />
            </div>
          </div>
        </div>
      </div>

    </main>
  );
}

 