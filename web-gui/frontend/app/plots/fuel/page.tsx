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



export default function FuelGraphsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();
  const allSensors = useSensorConfig();
  const pressureLimits = usePressureLimits();
  const ethLimits = getLimitsForSystem(pressureLimits, 'ETH');

  // Propulsion-side fuel sensors only — exclude anything fill-related
  const fuelSensors = filterByRole(allSensors, 'Fuel').filter(
    (s) => !s.role.toLowerCase().includes('fill')
  );
  const entities = fuelSensors.map((s) => s.calEntity);
  const labels = fuelSensors.map((s) => s.role);
  const colors = entities.map((e) => getEntityColor(e));

  // Sidebar values
  const upSensor = fuelSensors.find((s) => s.role.toLowerCase().includes('up'));
  const downSensor = fuelSensors.find((s) => s.role.toLowerCase().includes('dn') || s.role.toLowerCase().includes('down'));
  const up = useSensorValue(upSensor?.calEntity ?? '', 'pressure_psi');
  const down = useSensorValue(downSensor?.calEntity ?? '', 'pressure_psi');

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));

    const unsub3 = ws.onConnectionStatus((status) => {
      if (status.connected) {
        console.log('[FuelGraphsPage] WebSocket reconnected, listeners active');
      }
    });

    return () => { unsub1(); unsub2(); unsub3(); };
  }, [ws, updateSensor, updateState]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-blue-500 rounded-full" />
          <h1 className="text-base font-bold text-blue-400 tracking-wider">FUEL SYSTEM</h1>
        </div>
      </div>

      {/* Live readout strip */}
      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={fuelSensors.map((s) => ({
          label: s.role, entity: s.calEntity, component: 'pressure_psi', color: getEntityColor(s.calEntity),
        }))} />
      </div>

      {/* Body: chart + sidebar */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">
        {/* Main chart + actuators (plot dominant, actuators reserved) */}
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-[3] min-h-0 bg-card rounded-lg p-2 flex flex-col min-w-0">
            <TimeSeriesPlot
              title="FUEL Pressure (PSI)"
              entities={entities}
              labels={labels}
              component="pressure_psi"
              colors={colors}
              yLabel="Pressure (PSI)"
            />
          </div>

          {/* Actuators – reserved height so always visible */}
          <div className="flex-[1] min-h-[220px] flex-shrink-0 overflow-auto">
            <ActuatorStatePanel
              title="Fuel Actuators"
              actuators={[
                { label: 'Fuel Main', entity: 'ACT.Fuel_Main', color: getActuatorColor('ACT.Fuel_Main') },
                { label: 'Fuel Vent', entity: 'ACT.Fuel_Vent', color: getActuatorColor('ACT.Fuel_Vent') },
                { label: 'Fuel Press', entity: 'ACT.Fuel_Press', color: getActuatorColor('ACT.Fuel_Press') },
              ]}
            />
          </div>
        </div>

        {/* Pressure bars sidebar – narrower */}
        <div className="w-40 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-visible">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0 overflow-visible w-full pr-6">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Up" value={up} nop={ethLimits.NOP} meop={ethLimits.MEOP} color={getEntityColor(upSensor?.calEntity ?? '')} showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Down" value={down} nop={ethLimits.NOP} meop={ethLimits.MEOP} color={getEntityColor(downSensor?.calEntity ?? '')} showLabels={false} />
            </div>
          </div>
        </div>
      </div>

    </main>
  );
}
