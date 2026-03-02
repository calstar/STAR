'use client'

import { useEffect } from 'react';
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
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { useState } from 'react';

export default function GSEGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();
  const allSensors = useSensorConfig();
  const pressureLimits = usePressureLimits();
  const gn2Limits = getLimitsForSystem(pressureLimits, 'GN2');
  const fuelLimits = getLimitsForSystem(pressureLimits, 'FUEL');
  const loxLimits = getLimitsForSystem(pressureLimits, 'LOX');
  const { actuators: actuatorsFromConfig } = useActuatorsFromConfig();

  const [activeTab, setActiveTab] = useState<'PRESSURANT' | 'FUEL' | 'LOX'>('PRESSURANT');

  const pressurantSensors = filterByRole(allSensors, 'GSE', 'GN2').filter(s => !s.role.toLowerCase().includes('fuel') && !s.role.toLowerCase().includes('lox'));
  const fuelSensors = filterByRole(allSensors, 'Fuel').filter(s => s.role.toLowerCase().includes('gse') || s.role.toLowerCase().includes('fill'));
  const loxSensors = filterByRole(allSensors, 'LOX', 'Ox').filter(s => s.role.toLowerCase().includes('gse') || s.role.toLowerCase().includes('fill'));

  const pressurantActuators = actuatorsFromConfig.filter(a => (a.name.toLowerCase().includes('gse') || a.name.toLowerCase().includes('gn2')) && !a.name.toLowerCase().includes('lox') && !a.name.toLowerCase().includes('fuel'));
  const fuelActuators = actuatorsFromConfig.filter(a => a.name.toLowerCase().includes('fuel') && a.name.toLowerCase().includes('fill'));
  const loxActuators = actuatorsFromConfig.filter(a => a.name.toLowerCase().includes('lox') && (a.name.toLowerCase().includes('fill') || a.name.toLowerCase().includes('dump')));

  // Current tab data
  let currentSensors = pressurantSensors;
  let currentActuators = pressurantActuators;
  let currentSystem = 'GN2';
  let limits = gn2Limits;

  if (activeTab === 'FUEL') {
    currentSensors = fuelSensors;
    currentActuators = fuelActuators;
    currentSystem = 'FUEL';
    limits = fuelLimits;
  } else if (activeTab === 'LOX') {
    currentSensors = loxSensors;
    currentActuators = loxActuators;
    currentSystem = 'LOX';
    limits = loxLimits;
  }

  const entities = currentSensors.map((s) => s.calEntity);
  const labels = currentSensors.map((s) => s.role);
  const colors = entities.map((e) => getEntityColor(e));

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center flex-shrink-0 justify-between">
        <div className="flex items-center">
          <div className="w-1 h-5 bg-yellow-500 rounded-full mr-3" />
          <h1 className="text-base font-bold text-yellow-400 tracking-wider">GSE SYSTEM</h1>
        </div>
        <div className="flex gap-2 bg-gray-900 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('PRESSURANT')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'PRESSURANT' ? 'bg-yellow-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            Pressurant
          </button>
          <button
            onClick={() => setActiveTab('FUEL')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'FUEL' ? 'bg-rose-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            Fuel
          </button>
          <button
            onClick={() => setActiveTab('LOX')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'LOX' ? 'bg-blue-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            LOX
          </button>
        </div>
      </div>

      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={currentSensors.map((s) => ({
          label: s.role, entity: s.calEntity, component: 'pressure_psi', color: getEntityColor(s.calEntity),
        }))} />
      </div>

      <div className="flex-1 min-h-0 flex flex-row gap-2">
        {/* Main chart + actuators */}
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0" style={{ minHeight: '300px' }}>
            <TimeSeriesPlot
              title={`${activeTab} Pressures (PSI)`}
              entities={entities}
              labels={labels}
              component="pressure_psi"
              colors={colors}
              yLabel="Pressure (PSI)"
            />
          </div>

          <div className="flex-shrink-0">
            <ActuatorStatePanel
              title={`${activeTab} Actuators`}
              actuators={currentActuators.map((a) => ({ label: a.name, entity: a.entity, color: getActuatorColor(a.entity) }))}
            />
          </div>
        </div>

        {/* Pressure bars sidebar */}
        <div className="w-60 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-y-auto">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          <div className="flex flex-col flex-1 gap-4 overflow-visible w-full pr-2">
            {currentSensors.map((s) => (
              <ConnectedPressureBar key={s.calEntity} entity={s.calEntity} label={s.role} nop={limits.NOP} meop={limits.MEOP} />
            ))}
          </div>
        </div>
      </div>

    </main>
  );
}

function ConnectedPressureBar({ entity, label, nop, meop }: { entity: string, label: string, nop: number, meop: number }) {
  const value = useSensorValue(entity, 'pressure_psi');
  return (
    <div className="h-40 min-h-0 overflow-visible w-full">
      <PressureBar label={label} value={value} nop={nop} meop={meop} color={getEntityColor(entity)} showLabels={true} />
    </div>
  );
}
