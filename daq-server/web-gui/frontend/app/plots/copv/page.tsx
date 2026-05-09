'use client'

import { useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import { useSensorValue } from '@/lib/store';
import { getEntityColor, getActuatorColor } from '@/lib/sensor-colors';
import { useSensorConfig, filterByRole } from '@/lib/sensor-config';
import { usePressureLimits, getLimitsForSystem } from '@/lib/pressure-limits';

export default function COPVGraphsPage() {
  const allSensors = useSensorConfig();
  const pressureLimits = usePressureLimits();
  const gn2Limits = getLimitsForSystem(pressureLimits, 'GN2');
  const [activeTab, setActiveTab] = useState<'PT' | 'RTD'>('PT');

  const gn2Sensors = filterByRole(allSensors, 'GN2');
  const copvRtdSensors = allSensors.filter(
    (s) =>
      (s.calEntity.startsWith('RTD') || s.calEntity.startsWith('RTD_Cal')) &&
      s.role.toLowerCase().includes('copv')
  );
  const rtdSensors =
    copvRtdSensors.length > 0
      ? copvRtdSensors
      : allSensors.filter(
          (s) =>
            (s.calEntity.startsWith('RTD') || s.calEntity.startsWith('RTD_Cal')) &&
            (s.role.toLowerCase().includes('gn2') || s.role.toLowerCase().includes('copv'))
        );

  const currentSensors = activeTab === 'PT' ? gn2Sensors : rtdSensors;
  const currentEntities = currentSensors.map((s) => s.calEntity);
  const currentLabels = currentSensors.map((s) => s.role);
  const currentColors = currentEntities.map((e) => getEntityColor(e));
  const componentName = activeTab === 'PT' ? 'pressure_psi' : 'temperature_c';
  const yLabel = activeTab === 'PT' ? 'Pressure (PSI)' : 'Temperature (°C)';

  const hiSensor = gn2Sensors.find((s) => s.role.toLowerCase().includes('high'));
  const regSensor = gn2Sensors.find((s) => s.role.toLowerCase().includes('reg'));
  const hi = useSensorValue(hiSensor?.calEntity ?? '', 'pressure_psi');
  const reg = useSensorValue(regSensor?.calEntity ?? '', 'pressure_psi');

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-green-500 rounded-full mr-3" />
          <h1 className="text-base font-bold text-green-400 tracking-wider">COPV / GN2 SYSTEM</h1>
        </div>
        <div className="flex gap-2 bg-gray-900 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('PT')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'PT' ? 'bg-green-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            PTs (Pressures)
          </button>
          <button
            onClick={() => setActiveTab('RTD')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'RTD' ? 'bg-teal-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            RTD (COPV Temp)
          </button>
        </div>
      </div>

      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={currentSensors.map((s) => ({
          label: s.role, entity: s.calEntity, component: componentName, color: getEntityColor(s.calEntity),
        }))} />
      </div>

      {/* Body: chart + sidebar */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">
        {/* Main charts + actuators */}
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-[3] min-h-0 bg-card rounded-lg p-2 flex flex-col min-w-0">
            <TimeSeriesPlot
              title={activeTab === 'PT' ? 'COPV / GN2 Pressure (PSI)' : 'COPV RTD Temperature (°C)'}
              entities={currentEntities}
              labels={currentLabels}
              component={componentName}
              colors={currentColors}
              yLabel={yLabel}
            />
          </div>

          <div className="flex-[1] min-h-[180px] flex-shrink-0 overflow-auto">
            <ActuatorStatePanel
              title="GN2 Actuator"
              actuators={[
                { label: 'GN2 Vent', entity: 'ACT.GN2_Vent', color: getActuatorColor('ACT.GN2_Vent') },
              ]}
            />
          </div>
        </div>

        {/* Pressure bars sidebar (PT tab only) */}
        {activeTab === 'PT' && (
        <div className="w-40 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-visible">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0 overflow-visible w-full pr-6">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="GN2 Hi" value={hi} nop={gn2Limits.NOP} meop={gn2Limits.MEOP} color={getEntityColor(hiSensor?.calEntity ?? '')} showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="GN2 Reg" value={reg} nop={gn2Limits.NOP} meop={gn2Limits.MEOP} color={getEntityColor(regSensor?.calEntity ?? '')} showLabels={false} />
            </div>
          </div>
        </div>
        )}
      </div>

    </main>
  );
}
