'use client'

import { useEffect } from 'react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControl from '@/components/controls/ActuatorControl';
import { getWebSocketClient } from '@/lib/websocket';
import { useSensorStore } from '@/lib/store';
import { MessageType, SensorUpdate, StateUpdate, ActuatorId, SystemState, CommandPayload } from '@/lib/types';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'HIGH PRESS', 12: 'HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
};

export default function ControlsPage() {
  const ws = getWebSocketClient();
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState  = useSensorStore((state) => state.updateState);

  useEffect(() => {
    ws.connect();
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.STATE_UPDATE,  (p: unknown) => updateState(p as StateUpdate));
    return () => { u1(); u2(); };
  }, [ws, updateSensor, updateState]);

  const sendEmergency = (state: SystemState) => {
    updateState({ currentState: state, stateName: STATE_NAMES[state] ?? '', timestamp: Date.now() });
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    ws.sendCommand(cmd);
  };

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">

      {/* ── Permanent emergency strip — always visible at top ─────────────── */}
      <div className="flex-shrink-0 bg-red-950/60 border-b border-red-800/60 px-4 py-2 flex items-center justify-between">
        <span className="text-xs font-bold tracking-widest text-red-400 uppercase">
          ⚠ Emergency Controls — always active
        </span>
        <div className="flex gap-3">
          <button
            onClick={() => sendEmergency(SystemState.VENT)}
            className="px-6 py-2 bg-amber-700 hover:bg-amber-600 active:bg-amber-800 border border-amber-500
                       text-white font-bold text-sm rounded tracking-widest transition-colors"
          >
            VENT
          </button>
          <button
            onClick={() => sendEmergency(SystemState.ABORT)}
            className="px-6 py-2 bg-red-700 hover:bg-red-600 active:bg-red-800 border border-red-500
                       text-white font-bold text-sm rounded tracking-widest transition-colors"
          >
            ABORT
          </button>
        </div>
      </div>

      {/* ── Main content: state machine + actuators ───────────────────────── */}
      <div className="flex-1 flex gap-3 p-3 min-h-0 overflow-hidden">

        {/* State machine diagram — left column */}
        <div className="flex-1 min-w-0 overflow-auto">
          <StateMachineDiagram />
        </div>

        {/* Actuator controls — right column, scrollable */}
        <div className="w-80 flex-shrink-0 overflow-y-auto space-y-3">
          <div className="bg-card rounded-xl border border-gray-800 p-4">
            <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase mb-4">
              Actuator Controls
            </h2>

            <div className="space-y-4">
              <div>
                <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Main Valves</p>
                <div className="space-y-2">
                  <ActuatorControl actuatorId={ActuatorId.LOX_MAIN} />
                  <ActuatorControl actuatorId={ActuatorId.FUEL_MAIN} />
                </div>
              </div>

              <div className="border-t border-gray-800 pt-3">
                <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Vent Valves</p>
                <div className="space-y-2">
                  <ActuatorControl actuatorId={ActuatorId.LOX_VENT} />
                  <ActuatorControl actuatorId={ActuatorId.FUEL_VENT} />
                </div>
              </div>

              <div className="border-t border-gray-800 pt-3">
                <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Press / GN2</p>
                <div className="space-y-2">
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

