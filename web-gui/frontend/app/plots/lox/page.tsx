'use client'

import { useEffect, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import { getEntityColor, getActuatorColor } from '@/lib/sensor-colors';
import { useSensorConfig, filterByRole } from '@/lib/sensor-config';
import { usePressureLimits, getLimitsForSystem } from '@/lib/pressure-limits';

export default function LOXGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();
  const allSensors = useSensorConfig();
  const pressureLimits = usePressureLimits();
  const loxLimits = getLimitsForSystem(pressureLimits, 'LOX');

  const [activeTab, setActiveTab] = useState<'PT' | 'RTD'>('PT');

  const ptSensors = filterByRole(allSensors, 'Ox', 'LOX').filter(
    (s) => s.calEntity.startsWith('PT') || s.calEntity.startsWith('PT_Cal')
  );
  const rtdSensors = filterByRole(allSensors, 'Ox', 'LOX').filter(
    (s) => s.calEntity.startsWith('RTD') || s.calEntity.startsWith('RTD_Cal')
  );

  const currentSensors = activeTab === 'PT' ? ptSensors : rtdSensors;
  const componentName = activeTab === 'PT'
    ? 'pressure_psi'
    : (rtdSensors.some((s) => s.calEntity.includes('RTD.')) ? 'raw_resistance_counts' : 'temperature_c');
  const yLabel = activeTab === 'PT'
    ? 'Pressure (PSI)'
    : (componentName === 'raw_resistance_counts' ? 'Temp (Raw ADC)' : 'Temperature (°C)');

  const entities = currentSensors.map((s) => s.calEntity);
  const labels = currentSensors.map((s) => s.role);
  const colors = entities.map((e) => getEntityColor(e));

  const upSensor   = ptSensors.find((s) => s.role.toLowerCase().includes('upstream'));
  const downSensor = ptSensors.find((s) => s.role.toLowerCase().includes('downstream'));
  const up   = useSensorValue(upSensor?.calEntity   ?? '', 'pressure_psi');
  const down = useSensorValue(downSensor?.calEntity ?? '', 'pressure_psi');

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      {/* Header + tab toggle */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-red-500 rounded-full" />
          <h1 className="text-base font-bold text-red-400 tracking-wider">LOX SYSTEM</h1>
        </div>
        <div className="flex gap-2 bg-gray-900 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('PT')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'PT' ? 'bg-red-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            PTs (Pressures)
          </button>
          <button
            onClick={() => setActiveTab('RTD')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'RTD' ? 'bg-orange-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            RTDs (Temperatures)
          </button>
        </div>
      </div>

      {/* Live readout strip */}
      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={currentSensors.map((s) => ({
          label: s.role, entity: s.calEntity, component: componentName, color: getEntityColor(s.calEntity),
        }))} />
      </div>

      {/* Body: chart + sidebar */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-[3] min-h-0 bg-card rounded-lg p-2 flex flex-col min-w-0">
            <TimeSeriesPlot
              title={`LOX ${activeTab}`}
              entities={entities}
              labels={labels}
              component={componentName}
              colors={colors}
              yLabel={yLabel}
            />
          </div>

          <div className="flex-[1] min-h-[280px] flex-shrink-0 overflow-auto">
            <ActuatorStatePanel
              title="LOX Actuators"
              actuators={[
                { label: 'LOX Main',  entity: 'ACT.LOX_Main',  color: getActuatorColor('ACT.LOX_Main') },
                { label: 'LOX Vent',  entity: 'ACT.LOX_Vent',  color: getActuatorColor('ACT.LOX_Vent') },
                { label: 'LOX Press', entity: 'ACT.LOX_Press', color: getActuatorColor('ACT.LOX_Press') },
                { label: 'LOX Fill',  entity: 'ACT.LOX_Fill',  color: getActuatorColor('ACT.LOX_Fill') },
                { label: 'LOX Dump',  entity: 'ACT.LOX_Dump',  color: getActuatorColor('ACT.LOX_Dump') },
              ]}
            />
          </div>
        </div>

        {/* Pressure bars sidebar — PT only (narrower) */}
        <div className="w-40 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-visible">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0 overflow-visible w-full pr-6">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Up"   value={up}   nop={loxLimits.NOP} meop={loxLimits.MEOP} color={getEntityColor(upSensor?.calEntity   ?? '')} showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Down" value={down} nop={loxLimits.NOP} meop={loxLimits.MEOP} color={getEntityColor(downSensor?.calEntity ?? '')} showLabels={false} />
            </div>
          </div>
        </div>
      </div>

    </main>
  );
}
