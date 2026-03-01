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

export default function GSEGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();
  const allSensors = useSensorConfig();
  const pressureLimits = usePressureLimits();
  const gn2Limits = getLimitsForSystem(pressureLimits, 'GN2');
  const { actuators: actuatorsFromConfig } = useActuatorsFromConfig();

  // GSE sensors: role names containing "GSE"
  const gseSensors = filterByRole(allSensors, 'GSE');
  const entities = gseSensors.map((s) => s.calEntity);
  const labels = gseSensors.map((s) => s.role);
  const colors = entities.map((e) => getEntityColor(e));

  const loSensor = gseSensors.find((s) => s.role.toLowerCase().includes('low'));
  const midSensor = gseSensors.find((s) => s.role.toLowerCase().includes('mid'));
  const hiSensor = gseSensors.find((s) => s.role.toLowerCase().includes('high'));
  const lo = useSensorValue(loSensor?.calEntity ?? '', 'pressure_psi');
  const mid = useSensorValue(midSensor?.calEntity ?? '', 'pressure_psi');
  const hi = useSensorValue(hiSensor?.calEntity ?? '', 'pressure_psi');

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      <div className="flex items-center flex-shrink-0">
        <div className="w-1 h-5 bg-yellow-500 rounded-full mr-3" />
        <h1 className="text-base font-bold text-yellow-400 tracking-wider">GSE SYSTEM</h1>
      </div>

      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={gseSensors.map((s) => ({
          label: s.role, entity: s.calEntity, component: 'pressure_psi', color: getEntityColor(s.calEntity),
        }))} />
      </div>

      {/* Body: chart + sidebar */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">
        {/* Main chart + actuators */}
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0" style={{ minHeight: '300px' }}>
            <TimeSeriesPlot
              title="GSE Pressures (PSI)"
              entities={entities}
              labels={labels}
              component="pressure_psi"
              colors={colors}
              yLabel="Pressure (PSI)"
            />
          </div>

          {/* GSE actuators from config */}
          <div className="flex-shrink-0">
            <ActuatorStatePanel
              title="GSE Actuators"
              actuators={actuatorsFromConfig.map((a) => ({ label: a.name, entity: a.entity, color: getActuatorColor(a.entity) }))}
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
              <PressureBar label="Low" value={lo} nop={gn2Limits.NOP} meop={gn2Limits.MEOP} color={getEntityColor(loSensor?.calEntity ?? '')} showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Mid" value={mid} nop={gn2Limits.NOP} meop={gn2Limits.MEOP} color={getEntityColor(midSensor?.calEntity ?? '')} showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="High" value={hi} nop={gn2Limits.NOP} meop={gn2Limits.MEOP} color={getEntityColor(hiSensor?.calEntity ?? '')} showLabels={false} />
            </div>
          </div>
        </div>
      </div>

    </main>
  );
}
