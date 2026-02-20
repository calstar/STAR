'use client'

import { useEffect } from 'react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControl from '@/components/controls/ActuatorControl';
import { getWebSocketClient } from '@/lib/websocket';
import { useSensorStore } from '@/lib/store';
import { MessageType, SensorUpdate, StateUpdate, ActuatorId, SystemState, CommandPayload } from '@/lib/types';
import { useSensorValue } from '@/lib/store';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'GN2 HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
};

// All actuators from the CSV - organized by category
const ALL_ACTUATORS = [
  // Main Valves
  { id: ActuatorId.LOX_MAIN, name: 'LOX Main', channel: 1, entity: 'ACT.LOX_Main' },
  { id: ActuatorId.FUEL_MAIN, name: 'Fuel Main', channel: 7, entity: 'ACT.Fuel_Main' },
  
  // Vent Valves
  { id: ActuatorId.LOX_VENT, name: 'LOX Vent', channel: 6, entity: 'ACT.LOX_Vent' },
  { id: ActuatorId.FUEL_VENT, name: 'Fuel Vent', channel: 2, entity: 'ACT.Fuel_Vent' },
  { name: 'GN2 Vent', channel: 5, entity: 'ACT.GSE_Low_Vent' }, // Maps to GSE Low Vent
  
  // Press Valves
  { id: ActuatorId.LOX_PRESS, name: 'LOX Press', channel: 8, entity: 'ACT.LOX_Press' },
  { id: ActuatorId.FUEL_PRESS, name: 'Fuel Press', channel: 3, entity: 'ACT.Fuel_Press' },
  
  // Fill Valves
  { name: 'Fuel Fill Vent', channel: 9, entity: 'ACT.Fuel_Fill_Vent' },
  { name: 'Fuel Fill Press', channel: 10, entity: 'ACT.Fuel_Fill_Press' },
  { name: 'LOX Fill', channel: 4, entity: 'ACT.ACT_CH4' },
  
  // Dump/Additional
  { name: 'LOX Dump', channel: 4, entity: 'ACT.ACT_CH4' },
  { name: 'GSE Low Press Vent', channel: 5, entity: 'ACT.GSE_Low_Vent' },
  { name: 'GSE High Press Vent', channel: 5, entity: 'ACT.GSE_Low_Vent' },
  { name: 'GSE LOX Fill Vent', channel: 5, entity: 'ACT.GSE_Low_Vent' },
  { name: 'GSE High Press Control', channel: 5, entity: 'ACT.GSE_Low_Vent' },
  { name: 'GSE Med Press Control', channel: 5, entity: 'ACT.GSE_Low_Vent' },
];

// Simple actuator display for actuators not in the enum
function SimpleActuatorDisplay({ name, channel, entity }: { name: string; channel: number; entity: string }) {
  const status = useSensorValue(entity, 'status');
  const adc = useSensorValue(entity, 'raw_adc_counts') ?? useSensorValue(`ACT.ACT_CH${channel}`, 'raw_adc_counts');
  const hasData = status !== null || adc !== null;
  const isOpen = status === 1 || (adc !== null && adc > 1000);
  const currentState = useSensorStore((s) => s.currentState);

  // Get expected position from ActuatorStatePanel logic
  const EXPECTED_POSITIONS: Record<number, Record<string, 'open' | 'closed' | null>> = {
    [SystemState.IDLE]: { 'ACT.LOX_Main': 'open', 'ACT.Fuel_Main': 'open', 'ACT.LOX_Vent': 'open', 'ACT.Fuel_Vent': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Press': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.Fuel_Fill_Vent': 'open', 'ACT.Fuel_Fill_Press': 'open' },
    [SystemState.ARMED]: { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed', 'ACT.GSE_Low_Vent': 'closed', 'ACT.Fuel_Fill_Vent': 'closed', 'ACT.Fuel_Fill_Press': 'closed' },
    [SystemState.FUEL_FILL]: { 'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.Fuel_Fill_Press': 'open', 'ACT.Fuel_Press': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Fill_Vent': 'closed' },
    [SystemState.OX_FILL]: { 'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.Fuel_Press': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed' },
    [SystemState.FIRE]: { 'ACT.Fuel_Main': 'open', 'ACT.Fuel_Press': 'open', 'ACT.LOX_Main': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.GSE_Low_Vent': 'closed' },
    [SystemState.VENT]: { 'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.Fuel_Press': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed' },
    [SystemState.ABORT]: { 'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.Fuel_Press': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Main': 'open', 'ACT.LOX_Main': 'closed' },
  };

  const stateExpected = currentState != null ? (EXPECTED_POSITIONS[currentState] ?? {}) : {};
  const expected = stateExpected[entity] ?? null;
  const mismatch = expected !== null && hasData && ((expected === 'open' && !isOpen) || (expected === 'closed' && isOpen));

  return (
    <div className={`bg-gray-900/50 rounded-lg px-4 py-3 border ${mismatch ? 'border-yellow-600/50 bg-yellow-950/20' : 'border-gray-800'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-text-muted uppercase tracking-wider">{name}</span>
          {expected && (
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
              expected === 'open' ? 'bg-green-900/30 text-green-600' : 'bg-red-900/30 text-red-600'
            }`}>
              EXP:{expected === 'open' ? 'O' : 'C'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-400">
            {hasData ? (adc?.toLocaleString() ?? '---') : '---'}
          </span>
          <span className={`text-xs font-bold font-mono px-2 py-1 rounded ${
            !hasData ? 'bg-gray-800 text-gray-600' :
            isOpen ? 'bg-green-900/60 text-green-400' : 'bg-red-900/60 text-red-400'
          }`}>
            {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
          </span>
          {mismatch && <span className="text-yellow-400 text-sm">⚠</span>}
        </div>
      </div>
    </div>
  );
}

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

  // Group actuators by category
  const mainValves = ALL_ACTUATORS.filter(a => a.name.includes('Main'));
  const ventValves = ALL_ACTUATORS.filter(a => a.name.includes('Vent'));
  const pressValves = ALL_ACTUATORS.filter(a => a.name.includes('Press'));
  const fillValves = ALL_ACTUATORS.filter(a => a.name.includes('Fill'));
  const otherValves = ALL_ACTUATORS.filter(a => 
    !a.name.includes('Main') && !a.name.includes('Vent') && !a.name.includes('Press') && !a.name.includes('Fill')
  );

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
        <div className="w-80 flex-shrink-0 overflow-y-auto space-y-4">
          <div className="bg-card rounded-xl border border-gray-800 p-4">
            <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase mb-4">
              Actuator Controls
            </h2>

            <div className="space-y-4">
              {/* Main Valves */}
              <div>
                <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Main Valves</p>
                <div className="space-y-2">
                  {mainValves.map((a) => a.id !== undefined ? (
                    <ActuatorControl key={a.name} actuatorId={a.id} />
                  ) : (
                    <SimpleActuatorDisplay key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                  ))}
                </div>
              </div>

              {/* Vent Valves */}
              <div className="border-t border-gray-800 pt-3">
                <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Vent Valves</p>
                <div className="space-y-2">
                  {ventValves.map((a) => a.id !== undefined ? (
                    <ActuatorControl key={a.name} actuatorId={a.id} />
                  ) : (
                    <SimpleActuatorDisplay key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                  ))}
                </div>
              </div>

              {/* Press Valves */}
              <div className="border-t border-gray-800 pt-3">
                <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Press Valves</p>
                <div className="space-y-2">
                  {pressValves.map((a) => a.id !== undefined ? (
                    <ActuatorControl key={a.name} actuatorId={a.id} />
                  ) : (
                    <SimpleActuatorDisplay key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                  ))}
                </div>
              </div>

              {/* Fill Valves */}
              <div className="border-t border-gray-800 pt-3">
                <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Fill Valves</p>
                <div className="space-y-2">
                  {fillValves.map((a) => (
                    <SimpleActuatorDisplay key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                  ))}
                </div>
              </div>

              {/* Other Valves */}
              {otherValves.length > 0 && (
                <div className="border-t border-gray-800 pt-3">
                  <p className="text-xs text-text-muted font-semibold uppercase tracking-wider mb-2">Other</p>
                  <div className="space-y-2">
                    {otherValves.map((a) => (
                      <SimpleActuatorDisplay key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
