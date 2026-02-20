'use client'

import { useSensorStore, useGetSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { startDataCache } from '@/lib/data-cache';
import { useEffect, useState } from 'react';
import { ConnectionStatus, SystemState, CommandPayload } from '@/lib/types';
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
  { label:'GN2 REG',  entity:'PT_Cal.GN2_Regulated', nop:900, meop:950, color:'#27AE60' },
  { label:'FUEL UP',  entity:'PT_Cal.Fuel_Upstream',  nop:600, meop:650, color:'#3498DB' },
  { label:'FUEL DN',  entity:'PT_Cal.Fuel_Downstream',nop:600, meop:650, color:'#2980B9' },
  { label:'LOX UP',   entity:'PT_Cal.Ox_Upstream',    nop:600, meop:650, color:'#E74C3C' },
  { label:'LOX DN',   entity:'PT_Cal.Ox_Downstream',  nop:600, meop:650, color:'#C0392B' },
  { label:'GSE LO',   entity:'PT_Cal.GSE_Low',         nop:500, meop:700, color:'#F39C12' },
  { label:'GSE MID',  entity:'PT_Cal.GSE_Mid',         nop:500, meop:700, color:'#9B59B6' },
  { label:'GSE HI',   entity:'PT_Cal.GSE_High',        nop:500, meop:700, color:'#8E44AD' },
  { label:'GN2 HI',   entity:'PT_Cal.GN2_High',        nop:900, meop:950, color:'#1ABC9C' },
] as const;

export default function TopBar() {
  const getSensorValue = useGetSensorValue();
  const currentState = useSensorStore((s) => s.currentState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const setDebugMode = useSensorStore((s) => s.setDebugMode);
  const updateConnectionStatus = useSensorStore((s) => s.updateConnectionStatus);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false, elodinConnected: false,
  });
  const [clock, setClock] = useState('');

  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    startDataCache(); // begin 1 Hz background sampling for plot history
    return ws.onConnectionStatus((status) => {
      setConnectionStatus(status);
      updateConnectionStatus(status);
    });
  }, [ws, updateConnectionStatus]);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const effectiveState = currentState ?? SystemState.IDLE;
  const currentStateName = STATE_NAMES[effectiveState] ?? 'IDLE';
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';
  const isConnected = connectionStatus.connected;
  const isFullyConnected = connectionStatus.connected && connectionStatus.elodinConnected;

  const updateState = useSensorStore((s) => s.updateState);

  const sendEmergency = (state: SystemState) => {
    // Optimistic — update UI immediately
    updateState({ currentState: state, stateName: STATE_NAMES[state] ?? '', timestamp: Date.now() });
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    ws.sendCommand(cmd);
  };

  return (
    <div className="bg-card border-b border-gray-800 select-none flex-shrink-0" style={{ height: '38vh', minHeight: 240 }}>
      <div className="flex items-stretch h-full px-4 gap-4">

        {/* Left: brand + connection + clock */}
        <div className="flex flex-col justify-center gap-2 flex-shrink-0 pr-4 border-r border-gray-800/60">
          <span className="text-base font-bold tracking-widest text-blue-400 uppercase">
            DIABLO DAQ
          </span>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${isFullyConnected ? 'bg-green-500' : isConnected ? 'bg-yellow-500' : 'bg-red-500'}`} />
            <span className="text-sm text-gray-400">
              {isFullyConnected ? 'Connected' : isConnected ? 'WS Only' : 'Disconnected'}
            </span>
          </div>
          <span className="text-base font-mono text-gray-300 tabular-nums">{clock}</span>
        </div>

        {/* Center: pressure bars — dominant */}
        <div className="flex-1 flex items-stretch gap-2 py-2 min-w-0">
          {PRESSURE_BARS.map(({ label, entity, nop, meop, color }) => (
            <div key={entity} className="flex-1 min-w-0 h-full">
              <PressureBar
                label={label}
                value={getSensorValue(entity, 'pressure_psi')}
                nop={nop} meop={meop} color={color}
              />
            </div>
          ))}
        </div>

        {/* Right: state + abort */}
        <div className="flex items-center gap-4 flex-shrink-0 pl-4 border-l border-gray-800/60">
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-gray-500 uppercase tracking-widest font-semibold">STATE</span>
            <span className={`text-2xl font-bold font-mono tracking-wider ${stateColor}`}>
              {currentStateName}
            </span>
          </div>

          {/* Debug mode toggle */}
          <div className="flex flex-col items-center gap-0.5 border-l border-gray-800/60 pl-4">
            <span className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">MODE</span>
            <button
              onClick={() => setDebugMode(!debugMode)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider border transition-all ${
                debugMode
                  ? 'bg-yellow-800/60 border-yellow-600 text-yellow-300 shadow-[0_0_6px_rgba(234,179,8,0.3)]'
                  : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-500'
              }`}
            >
              {debugMode ? '🔓 DEBUG' : '🔒 SAFE'}
            </button>
          </div>

          {/* Abort buttons */}
          <div className="flex flex-col gap-2">
            <button
              onClick={() => sendEmergency(SystemState.VENT)}
              className="px-6 py-3 bg-amber-800 hover:bg-amber-700 active:bg-amber-900 border border-amber-600
                         text-white font-bold text-sm rounded-lg tracking-wider transition-colors"
            >
              ABORT
            </button>
            <button
              onClick={() => {
                if (confirm('⚠️ EMERGENCY ABORT — immediately abort all operations?')) {
                  sendEmergency(SystemState.ABORT);
                }
              }}
              className="px-6 py-3 bg-red-700 hover:bg-red-600 active:bg-red-800 border border-red-500
                         text-white font-bold text-sm rounded-lg tracking-wider transition-colors
                         shadow-[0_0_8px_rgba(239,68,68,0.4)]"
            >
              E-ABORT
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
