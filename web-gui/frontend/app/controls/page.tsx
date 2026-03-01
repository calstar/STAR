'use client'

import React, { useEffect } from 'react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { getWebSocketClient } from '@/lib/websocket';
import { useSensorStore } from '@/lib/store';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import { useSensorValue } from '@/lib/store';
import { PRESSURE_SENSORS } from '@/lib/sensor-colors';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 LOW PRESS', 6: 'GN2 LOW VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'GN2 HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ENGINE ABORT',
  18: 'GSE ABORT', 19: 'EMERGENCY ABORT', 20: 'PRESS STANDBY',
};

const PRESSURE_SENSORS_PLOT = PRESSURE_SENSORS.map((s) => ({
  label: s.label.replace('Upstream', 'Up').replace('Downstream', 'Down').replace('Regulated', 'Reg'),
  entity: s.entity,
  color: s.color,
}));

export default function ControlsPage() {
  const ws = getWebSocketClient();
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState  = useSensorStore((state) => state.updateState);
  const updateActuatorExpectedPositions = useSensorStore((s) => s.updateActuatorExpectedPositions);
  const { actuators: actuatorsFromConfig, loading: actuatorsLoading } = useActuatorsFromConfig();

  useEffect(() => {
    ws.connect();
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    const u3 = ws.on(MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE, (p: unknown) => {
      updateActuatorExpectedPositions(p as Record<number, Record<string, 'open' | 'closed' | null>>);
    });
    return () => { u1(); u2(); u3(); };
  }, [ws, updateSensor, updateState, updateActuatorExpectedPositions]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">
      <div className="flex-1 flex gap-3 p-3 min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="bg-card rounded-xl border border-gray-800 p-4 h-full flex flex-col min-h-0">
            <TimeSeriesPlot
              title="All Pressure Sensors (PSI)"
              entities={PRESSURE_SENSORS_PLOT.map(s => s.entity)}
              labels={PRESSURE_SENSORS_PLOT.map(s => s.label)}
              component="pressure_psi"
              colors={PRESSURE_SENSORS_PLOT.map(s => s.color)}
              yLabel="Pressure (PSI)"
              windowSeconds={30}
            />
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex-shrink-0 overflow-auto">
            <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase mb-4">
              Actuator Controls
            </h2>
            <div className="grid grid-cols-4 gap-3 auto-rows-fr">
              {actuatorsLoading ? (
                <p className="text-text-muted">Loading actuators from config…</p>
              ) : (
                actuatorsFromConfig.map((a) => (
                  <ActuatorControlByName key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                ))
              )}
            </div>
          </div>

          {/* State machine diagram */}
          <div className="flex-1 min-h-0 overflow-auto bg-card rounded-xl border border-gray-800 p-4">
            <StateMachineDiagram />
          </div>
        </div>
      </div>
    </main>
  );
}
