'use client'

import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { startDataCache } from '@/lib/data-cache';
import { useEffect, useState } from 'react';
import { ConnectionStatus, SystemState, CommandPayload, StateUpdate, SensorUpdate, MessageType } from '@/lib/types';
import PressureBar from '@/components/plots/PressureBar';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'HIGH PRESS', 12: 'HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
};

const STATE_COLORS: Record<number, string> = {
  16: 'text-red-400',
  17: 'text-red-500',
  13: 'text-yellow-400',
  15: 'text-green-400',
  2:  'text-blue-400',
  0:  'text-gray-500',
};

const PRESSURE_BARS = [
  { label:'GN2 REG',  entity:'PT_Cal.GN2_Regulated', nop:900,  meop:950,  color:'#8E44AD' },
  { label:'FUEL UP',  entity:'PT_Cal.Fuel_Upstream',  nop:600,  meop:650,  color:'#FF8C3A' },
  { label:'FUEL DN',  entity:'PT_Cal.Fuel_Downstream',nop:600,  meop:650,  color:'#CC2200' },
  { label:'LOX UP',   entity:'PT_Cal.Ox_Upstream',    nop:600,  meop:650,  color:'#85C1E9' },
  { label:'LOX DN',   entity:'PT_Cal.Ox_Downstream',  nop:600,  meop:650,  color:'#2471A3' },
  { label:'GSE LO',   entity:'PT_Cal.GSE_Low',        nop:500,  meop:700,  color:'#1E8449' },
  { label:'GSE MID',  entity:'PT_Cal.GSE_Mid',        nop:4000, meop:4500, color:'#2ECC71' },
  { label:'GSE HI',   entity:'PT_Cal.GSE_High',       nop:500,  meop:700,  color:'#8ACE00' },
  { label:'GN2 HI',   entity:'PT_Cal.GN2_High',       nop:900,  meop:950,  color:'#C39BD3' },
] as const;

// Separate component for each pressure bar to properly use hooks
function ReactivePressureBar({ label, entity, nop, meop, color }: {
  label: string;
  entity: string;
  nop: number;
  meop: number;
  color: string;
}) {
  const value = useSensorValue(entity, 'pressure_psi');
  return (
    <div className="min-w-0 h-full overflow-visible" style={{ width: '9%', maxWidth: 110 }}>
      <PressureBar
        label={label}
        value={value}
        nop={nop} meop={meop} color={color}
      />
    </div>
  );
}

export default function TopBar() {
  // Subscribe to sensor updates to ensure bar plots re-render when values change
  // Subscribe to the entire sensorData object to catch all updates
  const sensorData = useSensorStore((s) => s.sensorData);
  const currentState = useSensorStore((s) => s.currentState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const setDebugMode = useSensorStore((s) => s.setDebugMode);
  const updateConnectionStatus = useSensorStore((s) => s.updateConnectionStatus);
  const updateState = useSensorStore((s) => s.updateState);
  const updateSensor = useSensorStore((s) => s.updateSensor);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false, elodinConnected: false,
  });
  const [clock, setClock] = useState('');

  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    try {
      startDataCache(); // begin 1 Hz background sampling for plot history
    } catch (err) {
      console.error('[TopBar] Failed to start data cache:', err);
    }
    const unsubConn = ws.onConnectionStatus((status) => {
      setConnectionStatus(status);
      updateConnectionStatus(status);
    });
    const unsubState = ws.on(MessageType.STATE_UPDATE, (p: unknown) => {
      updateState(p as StateUpdate);
    });
    // CRITICAL: Subscribe to sensor updates to ensure bar plots update
    const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => {
      updateSensor(p as SensorUpdate);
    });
    return () => { unsubConn(); unsubState(); unsubSensor(); };
  }, [ws, updateConnectionStatus, updateState, updateSensor]);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const effectiveState = currentState ?? SystemState.IDLE;
  const currentStateName = STATE_NAMES[effectiveState] ?? 'IDLE';
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';
  const isConnected = connectionStatus.connected;
  const isFullyConnected = connectionStatus.connected && connectionStatus.elodinConnected;

  // Simple helper: send a single state-transition command
  const sendState = (state: SystemState) => {
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    ws.sendCommand(cmd);
  };

  // ENGINE ABORT: go to VENT for 5 seconds, then ENGINE_ABORT (same as old ABORT functionality)
  const handleEngineAbort = () => {
    sendState(SystemState.VENT);
    // After 5 seconds, transition to ENGINE_ABORT
    setTimeout(() => {
      sendState(SystemState.ENGINE_ABORT);
    }, 5000);
  };

  // GSE ABORT: go directly to GSE_ABORT state
  const handleGseAbort = () => {
    sendState(SystemState.GSE_ABORT);
  };

  // EMERGENCY ABORT: immediately go to EMERGENCY_ABORT state
  const handleEmergencyAbort = () => {
    if (!confirm('⚠️ EMERGENCY ABORT — immediately vent GN2 and abort all operations?')) return;
    // Go directly to EMERGENCY_ABORT state
    sendState(SystemState.EMERGENCY_ABORT);
  };

  return (
    <div className="bg-card border-b border-gray-800 select-none flex-shrink-0" style={{ height: '15vh', minHeight: 110 }}>
      <div className="flex items-stretch h-full px-4 gap-4">

        {/* Left: brand + connection + clock */}
        <div className="flex flex-col justify-start pt-1 gap-0.5 flex-shrink-0 pr-6 border-r border-gray-800/60">
          <span className="text-7xl font-bold tracking-widest text-blue-400 uppercase leading-none">
            DIABLO DAQ
          </span>
          <div className="flex items-center gap-3">
            <div className={`w-5 h-5 rounded-full ${isFullyConnected ? 'bg-green-500' : isConnected ? 'bg-yellow-500' : 'bg-red-500'}`} />
            <span className="text-3xl text-gray-300 font-semibold">
              {isFullyConnected ? 'Connected' : isConnected ? 'WS Only' : 'Disconnected'}
            </span>
          </div>
          <span className="text-5xl font-mono text-gray-200 tabular-nums font-bold leading-tight">{clock}</span>
        </div>

        {/* Center: pressure bars — dominant */}
        <div className="flex-1 flex items-stretch justify-center gap-20 py-1 min-w-0 overflow-visible">
          {PRESSURE_BARS.map(({ label, entity, nop, meop, color }) => (
            <ReactivePressureBar
              key={entity}
              label={label}
              entity={entity}
              nop={nop}
              meop={meop}
              color={color}
            />
          ))}
        </div>

        {/* Right: state + abort */}
        <div className="flex items-center gap-6 flex-shrink-0 pl-4 border-l border-gray-800/60">
          <div className="flex flex-col items-center gap-2">
            <span className="text-lg text-gray-400 uppercase tracking-widest font-bold">STATE</span>
            <span className={`text-6xl font-bold font-mono tracking-wider ${stateColor}`}>
              {currentStateName}
            </span>
          </div>

          {/* Debug mode toggle */}
          <div className="flex flex-col items-center gap-1.5 border-l border-gray-800/60 pl-6">
            <span className="text-base text-gray-500 uppercase tracking-widest font-semibold">MODE</span>
            <button
              onClick={() => {
                const newDebugMode = !debugMode;
                setDebugMode(newDebugMode);
                // Send debug mode command to backend
                const cmd: CommandPayload = {
                  commandType: 'debug_mode',
                  data: { debugMode: newDebugMode }
                };
                ws.sendCommand(cmd);
              }}
              className={`px-6 py-3.5 rounded-md text-lg font-bold uppercase tracking-wider border transition-all ${
                debugMode
                  ? 'bg-yellow-800/60 border-yellow-600 text-yellow-300 shadow-[0_0_6px_rgba(234,179,8,0.3)]'
                  : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-500'
              }`}
            >
              {debugMode ? '🔓 DEBUG' : '🔒 SAFE'}
            </button>
          </div>

          {/* Abort buttons */}
          <div className="flex flex-col gap-2 border-l border-gray-800/60 pl-6">
            <span className="text-base text-gray-500 uppercase tracking-widest font-semibold mb-1">ABORT</span>
            <div className="flex flex-col gap-2">
              <button
                onClick={handleEngineAbort}
                className="px-8 py-3 bg-amber-800 hover:bg-amber-700 active:bg-amber-900 border-2 border-amber-600
                           text-white font-bold text-lg rounded-lg tracking-wider transition-colors"
              >
                ENGINE ABORT
              </button>
              <button
                onClick={handleGseAbort}
                className="px-8 py-3 bg-orange-800 hover:bg-orange-700 active:bg-orange-900 border-2 border-orange-600
                           text-white font-bold text-lg rounded-lg tracking-wider transition-colors"
              >
                GSE ABORT
              </button>
              <button
                onClick={handleEmergencyAbort}
                className="px-8 py-3 bg-red-700 hover:bg-red-600 active:bg-red-800 border-2 border-red-500
                           text-white font-bold text-lg rounded-lg tracking-wider transition-colors
                           shadow-[0_0_8px_rgba(239,68,68,0.4)]"
              >
                E-ABORT
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
