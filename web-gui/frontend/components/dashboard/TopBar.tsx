'use client'

import { useSensorStore, useGetSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { useEffect, useState } from 'react';
import { ConnectionStatus, SystemState } from '@/lib/types';
import PressureBar from '@/components/plots/PressureBar';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'HIGH PRESS', 12: 'HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
};

const STATE_COLORS: Record<number, string> = {
  16: 'text-red-400',    // FIRE
  17: 'text-red-500',    // ABORT
  13: 'text-yellow-400', // VENT
  15: 'text-green-400',  // READY
  2:  'text-blue-400',   // ARMED
  0:  'text-gray-500',   // DEBUG
};

export default function TopBar() {
  const getSensorValue         = useGetSensorValue();
  const currentState           = useSensorStore((state) => state.currentState);
  const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);

  const [isPopup, setIsPopup]                     = useState(false);
  const [connectionStatus, setConnectionStatus]   = useState<ConnectionStatus>({
    connected: false,
    elodinConnected: false,
  });
  const [clock, setClock] = useState('');

  useEffect(() => { setIsPopup(!!window.opener); }, []);

  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsubscribe = ws.onConnectionStatus((status) => {
      setConnectionStatus(status);
      updateConnectionStatus(status);
    });
    return unsubscribe;
  }, [ws, updateConnectionStatus]);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Don't render in popup windows — they have WindowTopBar
  if (isPopup) return null;

  // Default to IDLE if no state received
  const effectiveState = currentState ?? SystemState.IDLE;
  const currentStateName = STATE_NAMES[effectiveState] ?? 'IDLE';
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';

  const isConnected     = connectionStatus.connected;
  const isFullyConnected = connectionStatus.connected && connectionStatus.elodinConnected;

  return (
    <div className="bg-card border-b border-gray-800 select-none sticky top-0 z-50">
      {/* ── Top strip: branding + state + boards + clock ─────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800/60">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold tracking-widest text-blue-400 uppercase">
            DIABLO DAQ
          </span>
          <span className="text-gray-700">|</span>
          <span className="text-xs text-text-muted">Ground Station</span>
        </div>

        {/* Center: multi-board status */}
        <div className="flex items-center gap-4">
          <BoardStatus id={1} label="PT Board" connected={isConnected} />
          <BoardStatus id={2} label="ACT Board" connected={false} />
        </div>

        {/* Right: state + connection + clock */}
        <div className="flex items-center gap-5">
          {/* System state */}
          <div className="flex items-center gap-2 bg-gray-900/60 rounded px-3 py-1">
            <span className="text-xs text-text-muted">STATE</span>
            <span className={`text-xs font-bold font-mono tracking-wider ${stateColor}`}>
              {currentStateName}
            </span>
          </div>

          {/* WebSocket connection */}
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${
              isFullyConnected ? 'bg-green-500 animate-pulse' :
              isConnected      ? 'bg-yellow-500' :
                                 'bg-red-500'
            }`} />
            <span className="text-xs text-text-muted">
              {isFullyConnected ? 'Connected' : isConnected ? 'WS Only' : 'Disconnected'}
            </span>
          </div>

          {/* Clock */}
          <span className="text-xs font-mono text-text-muted tabular-nums">{clock}</span>
        </div>
      </div>

      {/* ── Pressure bars — 90px tall containers ────────────────────────── */}
      <div className="flex items-stretch gap-2 px-4 py-2 overflow-x-auto" style={{ height: 90 }}>
        {([
          { label:'GN2 Reg', entity:'PT_Cal.GN2_Regulated', nop:900, meop:950, color:'#27AE60' },
          { label:'Fuel ↑',  entity:'PT_Cal.Fuel_Upstream',  nop:600, meop:650, color:'#3498DB' },
          { label:'Fuel ↓',  entity:'PT_Cal.Fuel_Downstream',nop:600, meop:650, color:'#2980B9' },
          { label:'LOX ↑',   entity:'PT_Cal.Ox_Upstream',    nop:600, meop:650, color:'#E74C3C' },
          { label:'LOX ↓',   entity:'PT_Cal.Ox_Downstream',  nop:600, meop:650, color:'#C0392B' },
          { label:'GSE Lo',  entity:'PT_Cal.GSE_Low',         nop:500, meop:700, color:'#F39C12' },
          { label:'GSE Mid', entity:'PT_Cal.GSE_Mid',         nop:500, meop:700, color:'#9B59B6' },
          { label:'GSE Hi',  entity:'PT_Cal.GSE_High',        nop:500, meop:700, color:'#8E44AD' },
          { label:'GN2 Hi',  entity:'PT_Cal.GN2_High',        nop:900, meop:950, color:'#1ABC9C' },
        ] as const).map(({ label, entity, nop, meop, color }) => (
          <div key={entity} style={{ width: 48, height: '100%' }}>
            <PressureBar
              label={label}
              value={getSensorValue(entity, 'pressure_psi')}
              nop={nop} meop={meop} color={color}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Board status chip ─────────────────────────────────────────────────────────
function BoardStatus({ id, label, connected }: { id: number; label: string; connected: boolean }) {
  return (
    <div className="flex items-center gap-1.5 bg-gray-900/80 rounded px-2.5 py-1 border border-gray-800">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${connected ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`} />
      <span className="text-xs text-text-muted">
        <span className="text-gray-600">B{id}</span> {label}
      </span>
      <span className={`text-xs font-bold font-mono ${connected ? 'text-green-400' : 'text-gray-600'}`}>
        {connected ? 'OK' : '--'}
      </span>
    </div>
  );
}
