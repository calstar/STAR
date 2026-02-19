'use client'

import { useEffect } from 'react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import StateMachinePanel from '@/components/controls/StateMachinePanel';
import ActuatorControl from '@/components/controls/ActuatorControl';
import { getWebSocketClient } from '@/lib/websocket';
import { useSensorStore } from '@/lib/store';
import { MessageType, SensorUpdate, StateUpdate, ActuatorId } from '@/lib/types';

export default function ControlsPage() {
  const ws = getWebSocketClient();
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);

  useEffect(() => {
    ws.connect();

    // Subscribe to sensor updates
    const unsubscribeSensor = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      updateSensor(payload as SensorUpdate);
    });

    // Subscribe to state updates
    const unsubscribeState = ws.on(MessageType.STATE_UPDATE, (payload: unknown) => {
      updateState(payload as StateUpdate);
    });

    return () => {
      unsubscribeSensor();
      unsubscribeState();
    };
  }, [ws, updateSensor, updateState]);

  return (
    <main className="min-h-screen bg-background text-text p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold">Controls</h1>

        {/* State Machine Diagram */}
        <StateMachineDiagram />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Compact State Machine Panel */}
          <StateMachinePanel />

          {/* Actuator Controls */}
          <div className="bg-card rounded-lg p-6">
            <h2 className="text-2xl font-bold mb-6">Actuator Controls</h2>

            <div className="space-y-4">
              {/* Main Valves */}
              <div>
                <h3 className="text-lg font-semibold mb-2 text-text-muted">Main Valves</h3>
                <div className="grid grid-cols-1 gap-3">
                  <ActuatorControl actuatorId={ActuatorId.LOX_MAIN} />
                  <ActuatorControl actuatorId={ActuatorId.FUEL_MAIN} />
                </div>
              </div>

              {/* Vent Valves */}
              <div>
                <h3 className="text-lg font-semibold mb-2 text-text-muted">Vent Valves</h3>
                <div className="grid grid-cols-1 gap-3">
                  <ActuatorControl actuatorId={ActuatorId.LOX_VENT} />
                  <ActuatorControl actuatorId={ActuatorId.FUEL_VENT} />
                </div>
              </div>

              {/* Press/GN2 Valves */}
              <div>
                <h3 className="text-lg font-semibold mb-2 text-text-muted">Press/GN2 Valves</h3>
                <div className="grid grid-cols-1 gap-3">
                  <ActuatorControl actuatorId={ActuatorId.LOX_PRESS} />
                  <ActuatorControl actuatorId={ActuatorId.FUEL_PRESS} />
                  <ActuatorControl actuatorId={ActuatorId.GSE_LOW_VENT} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
